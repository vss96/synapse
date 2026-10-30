import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile, mkdir, unlink, rename, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorCode } from "./errors.js";
import { isTask } from "./model/kinds.js";
import { MindmapDocument, now, type MindmapId, type MindmapList, type MindmapListItem, type NodeId, type UnreadableMindmap } from "./model/schema.js";

/** Where mindmaps are stored: $SYNAPSE_DATA_DIR, or ~/.synapse/data (shared by the MCP server and the viewer). */
export function getDataDir(): string {
  return path.resolve(process.env.SYNAPSE_DATA_DIR || path.join(os.homedir(), ".synapse", "data"));
}

export async function ensureDataDir(): Promise<string> {
  const dir = getDataDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

// MindmapId only admits [A-Za-z0-9_-], so the file name can't escape the data directory.
const filePath = (id: MindmapId): string => path.join(getDataDir(), `${id}.json`);

/** Append an activity entry to a mindmap document (keeps the latest 100 entries). */
export function recordActivity(doc: MindmapDocument, message: string, extra?: { nodeId?: NodeId; file?: string }): void {
  doc.activityLog.unshift({ timestamp: now(), message, ...extra });
  if (doc.activityLog.length > 100) doc.activityLog.length = 100;
}

/** A mindmap file exists but can't be loaded: it can't be opened, its JSON is damaged, or it isn't a valid mindmap. */
export class UnreadableMindmapError extends Error {
  constructor(
    readonly id: string,
    readonly reason: string,
  ) {
    super(`Mindmap "${id}" can't be read: ${reason}`);
  }
}

/** Unreadable files are read again by every listing, so each failure is only logged once. */
const reported = new Set<string>();

function unreadableError(file: string, reason: string): UnreadableMindmapError {
  const err = new UnreadableMindmapError(path.basename(file, ".json"), reason);
  if (!reported.has(err.message)) {
    reported.add(err.message);
    console.error(`[synapse] ${err.message}`);
  }
  return err;
}

/** Returns null if the file doesn't exist; throws UnreadableMindmapError if it can't be used. */
async function readDocument(file: string): Promise<MindmapDocument | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw unreadableError(file, String(err));
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw unreadableError(file, String(err));
  }
  const parsed = MindmapDocument.safeParse(json);
  if (!parsed.success) throw unreadableError(file, `not a valid mindmap (${parsed.error.issues[0]?.message ?? "invalid"})`);
  return parsed.data;
}

/** Load a single mindmap. Returns null if it doesn't exist; throws UnreadableMindmapError if it can't be read. */
export function load(id: MindmapId): Promise<MindmapDocument | null> {
  return readDocument(filePath(id));
}

/**
 * Persist a whole mindmap (a new one, say) after checking it is still a valid document; the write is atomic.
 * To change a stored mindmap use `update`, which can't overwrite changes made since it was read.
 * Archive state belongs to the viewer, so the copy on disk wins over the caller's (possibly stale) one.
 */
export async function save(doc: MindmapDocument): Promise<void> {
  doc.updatedAt = now();
  const file = filePath(doc.id);
  await withLock(file, async () => {
    const archivedAt = (await readDocument(file).catch(() => null))?.archivedAt;
    if (archivedAt) doc.archivedAt = archivedAt;
    else delete doc.archivedAt;
    await write(doc);
  });
}

/**
 * Read a mindmap, apply `mutate` to it and save it, all under its lock, so a change another tool call,
 * the watcher or the viewer makes in the meantime isn't overwritten by a stale copy.
 * `mutate` must be quick and synchronous (do slow work such as running git before calling this);
 * if it throws, nothing is saved. The mindmap is only written, and `updatedAt` only bumped, if `mutate` changed it.
 * Returns what `mutate` returned, or null if the mindmap doesn't exist. Throws UnreadableMindmapError if it can't be read.
 */
export async function update<T>(id: MindmapId, mutate: (doc: MindmapDocument) => T): Promise<T | null> {
  const file = filePath(id);
  return withLock(file, async () => {
    const doc = await readDocument(file);
    if (!doc) return null;
    const before = JSON.stringify(doc);
    const result = mutate(doc);
    if (JSON.stringify(doc) !== before) {
      doc.updatedAt = now();
      await write(doc);
    }
    return result;
  });
}

/**
 * Archive or restore a mindmap. Leaves `updatedAt` alone, so archiving doesn't make a session look recent.
 * Returns null if the mindmap doesn't exist.
 */
export async function setArchived(id: MindmapId, archived: boolean): Promise<MindmapDocument | null> {
  const file = filePath(id);
  // Read and write under the lock, so a save from an agent can't land in between and be overwritten.
  return withLock(file, async () => {
    const doc = await readDocument(file);
    if (!doc) return null;
    if (archived) doc.archivedAt ??= now();
    else delete doc.archivedAt;
    await write(doc);
    return doc;
  });
}

/** A lock with no pid in it, older than this, was left by a crash or by a version that didn't record one. */
const STALE_LOCK_MS = 5000;
/** No live holder takes this long: its owner died and another process now has its pid. */
const MAX_LOCK_MS = 5 * 60_000;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) !== "ESRCH"; // EPERM: it's running, as another user
  }
}

/**
 * Whether `lock` can be taken over. A big mindmap can hold its lock for several seconds and block the
 * event loop while it does, so age alone can't tell a busy holder from a dead one: the holder's pid does.
 */
async function isStaleLock(lock: string): Promise<boolean> {
  const held = await stat(lock).catch(() => null);
  if (!held) return false;
  const age = Date.now() - held.mtimeMs;
  const pid = Number(await readFile(lock, "utf-8").catch(() => ""));
  return pid ? age > MAX_LOCK_MS || !isRunning(pid) : age > STALE_LOCK_MS;
}

/**
 * Run `fn` while holding `<file>.lock`, which holds the owner's pid. The MCP server and the viewer are
 * separate processes, so the lock is a file created with O_EXCL rather than anything in memory.
 */
async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await ensureDataDir();
  const lock = `${file}.lock`;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      if (await isStaleLock(lock)) await unlink(lock).catch(() => {});
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

async function write(doc: MindmapDocument): Promise<void> {
  const valid = MindmapDocument.parse(doc);
  const file = filePath(valid.id);
  // Unique per write: two writers sharing a temp file can leave one's tail after the other's JSON.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(valid, null, 2), "utf-8");
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function summarize(doc: MindmapDocument): MindmapListItem {
  const nodes = Object.values(doc.nodes);
  const tasks = nodes.filter(isTask);
  const activeTask = tasks
    .filter((n) => n.status === "in_progress")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return {
    id: doc.id,
    title: doc.title,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    workspacePath: doc.workspacePath,
    repoPath: doc.repoPath,
    archivedAt: doc.archivedAt,
    nodeCount: nodes.length,
    completedTasks: tasks.filter((n) => n.status === "completed").length,
    totalTasks: tasks.length,
    activeTask: activeTask?.label,
    fileCount: new Set(nodes.flatMap((n) => n.files.map((f) => f.path))).size,
  };
}

/** List every stored mindmap, most recently updated first, and the files that couldn't be read. */
export async function list(): Promise<MindmapList> {
  const dir = await ensureDataDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const mindmaps: MindmapListItem[] = [];
  const unreadable: UnreadableMindmap[] = [];
  await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map(async (e) => {
        try {
          const doc = await readDocument(path.join(dir, e.name));
          if (doc) mindmaps.push(summarize(doc));
        } catch (err) {
          if (!(err instanceof UnreadableMindmapError)) throw err;
          unreadable.push({ id: err.id, error: err.reason });
        }
      }),
  );
  return {
    mindmaps: mindmaps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    unreadable: unreadable.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Delete a mindmap. */
export async function remove(id: MindmapId): Promise<boolean> {
  try {
    await unlink(filePath(id));
    return true;
  } catch {
    return false;
  }
}
