import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { MindmapDocument } from "./types.js";

export function getDataDir(): string {
  return path.resolve(process.env.SYNAPSE_DATA_DIR || "./data");
}

/** Ensure the data directory exists. */
async function ensureDir(): Promise<void> {
  const dir = getDataDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

function filePath(id: string): string {
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

/** Load a single mindmap by id. Returns null if not found. */
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
  await ensureDir();
  doc.updatedAt = new Date().toISOString();
  await writeFile(filePath(doc.id), JSON.stringify(doc, null, 2), "utf-8");
}

export interface MindmapListItem {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  workspacePath?: string;
  nodeCount: number;
}

/** List every stored mindmap sorted by most recently updated. */
export async function list(): Promise<MindmapListItem[]> {
  await ensureDir();
  const dir = getDataDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const results: MindmapListItem[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(dir, entry.name), "utf-8");
      const doc = JSON.parse(raw) as MindmapDocument;
      results.push({
        id: doc.id,
        title: doc.title,
        updatedAt: doc.updatedAt || doc.createdAt || "",
        createdAt: doc.createdAt || "",
        workspacePath: doc.workspacePath,
        nodeCount: Object.keys(doc.nodes || {}).length,
      });
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