import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPlanTask, type MindmapDocument, type MindmapListItem } from "./types.js";

export type { MindmapListItem };

/** Where mindmaps are stored: $SYNAPSE_DATA_DIR, or ~/.synapse/data (shared by the MCP server and the viewer). */
export function getDataDir(): string {
  return path.resolve(process.env.SYNAPSE_DATA_DIR || path.join(os.homedir(), ".synapse", "data"));
}

export async function ensureDataDir(): Promise<string> {
  const dir = getDataDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

const MINDMAP_ID = /^[A-Za-z0-9_-]+$/;

/** Mindmap ids come from agents and HTTP requests, so they must not be able to escape the data directory. */
export function isValidMindmapId(id: unknown): id is string {
  return typeof id === "string" && MINDMAP_ID.test(id);
}

function filePath(id: string): string {
  if (!isValidMindmapId(id)) throw new Error(`Invalid mindmap id: ${JSON.stringify(id)}`);
  return path.join(getDataDir(), `${id}.json`);
}

/** Append an activity entry to a mindmap document (keeps the latest 100 entries). */
export function recordActivity(
  doc: MindmapDocument,
  message: string,
  extra?: { nodeId?: string; file?: string },
): void {
  if (!doc.activityLog) {
    doc.activityLog = [];
  }
  doc.activityLog.unshift({
    timestamp: new Date().toISOString(),
    message,
    ...extra,
  });
  if (doc.activityLog.length > 100) {
    doc.activityLog.length = 100;
  }
}

/** Load a single mindmap by id. Returns null if not found or the id is invalid. */
export async function load(id: string): Promise<MindmapDocument | null> {
  try {
    const raw = await readFile(filePath(id), "utf-8");
    return JSON.parse(raw) as MindmapDocument;
  } catch {
    return null;
  }
}

/** Persist a mindmap document. */
export async function save(doc: MindmapDocument): Promise<void> {
  const file = filePath(doc.id);
  await ensureDataDir();
  doc.updatedAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(doc, null, 2), "utf-8");
}


function summarize(doc: MindmapDocument): MindmapListItem {
  const nodes = Object.values(doc.nodes || {});
  const tasks = nodes.filter(isPlanTask);
  const activeTask = tasks
    .filter((n) => n.status === "in_progress")
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
  const files = new Set(nodes.flatMap((n) => (n.files || []).map((f) => f.path)));
  return {
    id: doc.id,
    title: doc.title || doc.id,
    updatedAt: doc.updatedAt || doc.createdAt || "",
    createdAt: doc.createdAt || "",
    workspacePath: doc.workspacePath,
    nodeCount: nodes.length,
    completedTasks: tasks.filter((n) => n.status === "completed").length,
    totalTasks: tasks.length,
    activeTask: activeTask?.label,
    fileCount: files.size,
  };
}

/** List every stored mindmap sorted by most recently updated. */
export async function list(): Promise<MindmapListItem[]> {
  const dir = await ensureDataDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const results: MindmapListItem[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    try {
      const doc = JSON.parse(await readFile(path.join(dir, entry.name), "utf-8")) as MindmapDocument;
      if (isValidMindmapId(doc.id)) results.push(summarize(doc));
    } catch {
      // skip malformed files
    }
  }
  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return results;
}

/** Delete a mindmap by id. */
export async function remove(id: string): Promise<boolean> {
  try {
    await unlink(filePath(id));
    return true;
  } catch {
    return false;
  }
}
