import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile, mkdir, unlink, rename, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorCode } from "./errors.js";
import { aggregateFiles } from "./model/file-stats.js";
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
    // Stamped first, so the text that shows whether anything changed is also the text written.
    doc.updatedAt = now();
    const before = serialize(doc);
    const result = mutate(doc);
    const after = serialize(doc);
    if (after !== before) await write(doc, after);
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

const serialize = (doc: MindmapDocument): string => JSON.stringify(doc, null, 2);

/** Check `doc` and write it atomically. `text` is `doc` already serialized, for a caller that has it. */
async function write(doc: MindmapDocument, text?: string): Promise<void> {
  const valid = MindmapDocument.parse(doc);
  const file = filePath(valid.id);
  // Unique per write: two writers sharing a temp file can leave one's tail after the other's JSON.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text ?? serialize(valid), "utf-8");
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Every page gets this text for every session, so it's bounded. Most maps fit well within it. */
const MAX_SEARCH_TEXT = 8000;

function summarize(doc: MindmapDocument): MindmapListItem {
  const nodes = Object.values(doc.nodes);
  const tasks = nodes.filter(isTask);
  const files = [...aggregateFiles(nodes).values()];
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
    blockedTasks: tasks.filter((n) => n.status === "blocked").length,
    activeTask: activeTask?.label,
    fileCount: files.length,
    loggedFileCount: files.filter((f) => !f.autoDetected).length,
    // Labels first: they're short and they're what people remember, so long notes can't crowd them out.
    searchText: [...nodes.map((n) => n.label), ...nodes.flatMap((n) => n.notes ?? [])].join("\n").slice(0, MAX_SEARCH_TEXT),
  };
}

/** How a file in the data directory reads: a mindmap's summary, or why it can't be read. */
export type StoredSummary = MindmapListItem | UnreadableMindmap;

/** Files read at once when listing: the data directory can hold more mindmaps than the process may open files. */
const MAX_CONCURRENT_READS = 16;

/** Each file's last summary, with the mtime and size it was read at, so a listing only reads the files that changed. */
const summaries = new Map<string, { mtimeMs: number; size: number; summary: StoredSummary }>();

/** A file's summary, reading it only if it changed since last time. Null if it doesn't exist. */
async function summarizeFile(file: string): Promise<StoredSummary | null> {
  const seen = await stat(file).catch(() => null);
  const cached = summaries.get(file);
  if (seen && cached && cached.mtimeMs === seen.mtimeMs && cached.size === seen.size) return cached.summary;

  let summary: StoredSummary | null;
  try {
    const doc = await readDocument(file);
    summary = doc && summarize(doc);
  } catch (err) {
    if (!(err instanceof UnreadableMindmapError)) throw err;
    summary = { id: err.id, error: err.reason };
  }
  if (seen && summary) summaries.set(file, { mtimeMs: seen.mtimeMs, size: seen.size, summary });
  else summaries.delete(file);
  return summary;
}

/** The summary of the file a mindmap is stored in. `id` is a file name, which an unreadable file may not make a MindmapId. Null if it doesn't exist. */
export function summaryOf(id: string): Promise<StoredSummary | null> {
  return summarizeFile(path.join(getDataDir(), `${id}.json`));
}

export const isUnreadable = (summary: StoredSummary): summary is UnreadableMindmap => "error" in summary;

/** List every stored mindmap, most recently updated first, and the files that couldn't be read. */
export async function list(): Promise<MindmapList> {
  const dir = await ensureDataDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => path.join(dir, e.name));
  const mindmaps: MindmapListItem[] = [];
  const unreadable: UnreadableMindmap[] = [];
  const queue = [...files];
  const worker = async () => {
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      const summary = await summarizeFile(file);
      if (summary && isUnreadable(summary)) unreadable.push(summary);
      else if (summary) mindmaps.push(summary);
    }
  };
  await Promise.all(Array.from({ length: MAX_CONCURRENT_READS }, worker));

  const present = new Set(files);
  for (const file of summaries.keys()) {
    if (path.dirname(file) === dir && !present.has(file)) summaries.delete(file);
  }
  return {
    mindmaps: mindmaps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    unreadable: unreadable.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Delete a mindmap, under its lock so a write already under way can't put it back. */
export async function remove(id: MindmapId): Promise<boolean> {
  const file = filePath(id);
  return withLock(file, async () => {
    try {
      await unlink(file);
      return true;
    } catch {
      return false;
    }
  });
}
