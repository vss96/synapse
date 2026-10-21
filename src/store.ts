import { readdir, readFile, writeFile, mkdir, unlink, rename, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isTask } from "./model/kinds.js";
import { MindmapDocument, MindmapId, now, type MindmapListItem, type NodeId } from "./model/schema.js";

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

async function readDocument(file: string): Promise<MindmapDocument | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return null;
  }
  const parsed = MindmapDocument.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error(`[synapse] Skipping ${file}: not a valid mindmap (${parsed.error.issues[0]?.message ?? "invalid"})`);
    return null;
  }
  return parsed.data;
}

/** Load a single mindmap. Returns null if it doesn't exist or isn't a valid mindmap. */
export function load(id: MindmapId): Promise<MindmapDocument | null> {
  return readDocument(filePath(id)).catch(() => null);
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
 * Returns what `mutate` returned, or null if the mindmap doesn't exist.
 */
export async function update<T>(id: MindmapId, mutate: (doc: MindmapDocument) => T): Promise<T | null> {
  const file = filePath(id);
  return withLock(file, async () => {
    const doc = await readDocument(file).catch(() => null);
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
    const doc = await readDocument(file).catch(() => null);
    if (!doc) return null;
    if (archived) doc.archivedAt ??= now();
    else delete doc.archivedAt;
    await write(doc);
    return doc;
  });
}

/** A lock older than this was left behind by a process that died while holding it. */
const STALE_LOCK_MS = 5000;

/**
 * Run `fn` while holding `<file>.lock`. The MCP server and the viewer are separate processes,
 * so the lock is a file created with O_EXCL rather than anything in memory.
 */
async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await ensureDataDir();
  const lock = `${file}.lock`;
  for (;;) {
    try {
      await (await open(lock, "wx")).close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const held = await stat(lock).catch(() => null);
      if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) await unlink(lock).catch(() => {});
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
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(valid, null, 2), "utf-8");
  await rename(tmp, file);
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
    archivedAt: doc.archivedAt,
    nodeCount: nodes.length,
    completedTasks: tasks.filter((n) => n.status === "completed").length,
    totalTasks: tasks.length,
    activeTask: activeTask?.label,
    fileCount: new Set(nodes.flatMap((n) => n.files.map((f) => f.path))).size,
  };
}

/** List every valid stored mindmap, most recently updated first. */
export async function list(): Promise<MindmapListItem[]> {
  const dir = await ensureDataDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const docs = await Promise.all(
    entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => readDocument(path.join(dir, e.name)).catch(() => null)),
  );
  return docs
    .filter((d): d is MindmapDocument => d !== null)
    .map(summarize)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
