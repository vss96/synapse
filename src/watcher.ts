import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { watch, existsSync, type FSWatcher } from "node:fs";
import path from "node:path";
import * as store from "./store.js";
import { fileTouchTarget, upsertFileTouch } from "./model/file-touch.js";
import { MindmapId, now, type EditTouch } from "./model/schema.js";

const execFileAsync = promisify(execFile);

const IGNORED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  ".DS_Store",
]);

function shouldIgnorePath(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/);
  for (const part of parts) {
    if (IGNORED_SEGMENTS.has(part)) return true;
  }
  // Ignore synapse's own data JSON files if watching the synapse repo itself
  if (parts[0] === "data" && relPath.endsWith(".json")) return true;
  if (relPath.endsWith("~") || relPath.endsWith(".swp") || relPath.endsWith(".tmp")) return true;
  return false;
}

/**
 * Inspect git status and diff --numstat in a workspace directory. Staged renames
 * (`R old -> new`) are reported as renames; everything else as create, modify or delete.
 */
export async function inspectGitChanges(workspacePath: string): Promise<EditTouch[]> {
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace path does not exist: ${workspacePath}`);
  }

  const [{ stdout: statusOut }, { stdout: numstatOut }] = await Promise.all([
    execFileAsync("git", ["status", "--porcelain"], { cwd: workspacePath }).catch(() => ({ stdout: "" })),
    execFileAsync("git", ["diff", "--numstat", "HEAD"], { cwd: workspacePath }).catch(() => ({ stdout: "" })),
  ]);

  const statsMap = new Map<string, string>();
  for (const line of numstatOut.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, filePath] = line.split("\t");
    if (filePath && added !== undefined && removed !== undefined) {
      statsMap.set(filePath.trim(), `+${added}/-${removed} lines`);
    }
  }

  const changes: EditTouch[] = [];
  const timestamp = now();
  for (const line of statusOut.split("\n")) {
    if (!line.trim() || line.length < 4) continue;
    const code = line.slice(0, 2);
    const [from, to] = line.slice(3).trim().split(" -> ");
    const filePath = (to ?? from ?? "").trim();
    const previousPath = to !== undefined ? from?.trim() : undefined;
    if (!filePath || shouldIgnorePath(filePath)) continue;

    const diffStat = statsMap.get(filePath);
    const describe = (action: string) => (diffStat ? `Git ${action} (${diffStat})` : `Git ${action}`);
    const common = { path: filePath, changes: [], timestamp };
    if (code.includes("R") && previousPath) {
      changes.push({ ...common, action: "rename", previousPath, summary: describe("rename") });
    } else {
      const action = code.includes("?") || code.includes("A") ? "create" : code.includes("D") ? "delete" : "modify";
      changes.push({ ...common, action, summary: describe(action) });
    }
  }

  return changes;
}

/* ------------------------------------------------------------------ */
/*  Active workspace directory watchers                                */
/* ------------------------------------------------------------------ */

const activeWatchers = new Map<string, FSWatcher>();

export function ensureWorkspaceWatcher(mindmapId: MindmapId, workspacePath?: string): void {
  if (!workspacePath || !existsSync(workspacePath)) return;
  const resolved = path.resolve(workspacePath);
  const key = `${mindmapId}:${resolved}`;
  if (activeWatchers.has(key)) return;

  const pendingFiles = new Map<string, "create" | "modify" | "delete">();
  let debounceTimer: NodeJS.Timeout | null = null;

  const flush = async () => {
    debounceTimer = null;
    if (pendingFiles.size === 0) return;
    const batch = Array.from(pendingFiles.entries());
    pendingFiles.clear();

    const doc = await store.load(mindmapId);
    if (!doc) return;

    const targetNode = fileTouchTarget(doc);
    for (const [relPath, action] of batch) {
      upsertFileTouch(targetNode, { path: relPath, action, changes: [], summary: `Auto-detected file ${action}`, timestamp: now() });
      store.recordActivity(doc, `File ${action}: ${relPath}`, { nodeId: targetNode.id, file: relPath });
    }
    await store.save(doc);
  };

  try {
    const watcher = watch(resolved, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const relPath = filename.replace(/\\/g, "/");
      if (shouldIgnorePath(relPath)) return;

      const fullPath = path.join(resolved, filename);
      const exists = existsSync(fullPath);
      const action: "create" | "modify" | "delete" = !exists
        ? "delete"
        : eventType === "rename"
          ? "create"
          : "modify";

      pendingFiles.set(relPath, action);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, 600);
    });
    watcher.unref();

    activeWatchers.set(key, watcher);
  } catch {
    // Recursive watch may fail on unsupported mounts; fail gracefully
  }
}
