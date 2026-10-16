import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { watch, existsSync, type FSWatcher } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import * as store from "./store.js";
import type { FileAction, FileTouch, MindmapDocument, MindmapNode } from "./types.js";

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

export interface GitFileChange {
  path: string;
  action: FileAction;
  summary: string;
}

/**
 * Inspect git status and diff --numstat in a workspace directory.
 */
export async function inspectGitChanges(workspacePath: string): Promise<GitFileChange[]> {
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

  const changes: GitFileChange[] = [];
  for (const line of statusOut.split("\n")) {
    if (!line.trim() || line.length < 4) continue;
    const code = line.slice(0, 2);
    let filePath = line.slice(3).trim();
    if (filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ").pop()!.trim();
    }
    if (shouldIgnorePath(filePath)) continue;

    let action: FileAction = "modify";
    if (code.includes("?") || code.includes("A")) {
      action = "create";
    } else if (code.includes("D")) {
      action = "delete";
    }

    const diffStat = statsMap.get(filePath);
    const summary = diffStat
      ? `Git ${action} (${diffStat})`
      : `Git ${action}`;

    changes.push({ path: filePath, action, summary });
  }

  return changes;
}

/**
 * Find the best target node in a mindmap to attach a file touch to:
 * 1. Explicit nodeId if provided and exists
 * 2. The most recently updated node with status === "in_progress"
 * 3. A dedicated "Touched Files" node under root (created if needed)
 */
export function resolveTargetNodeForFile(
  doc: MindmapDocument,
  explicitNodeId?: string,
): MindmapNode {
  if (explicitNodeId && doc.nodes[explicitNodeId]) {
    return doc.nodes[explicitNodeId];
  }

  // Find an in_progress node
  const inProgressNodes = Object.values(doc.nodes).filter(
    (n) => n.status === "in_progress" && n.id !== "root",
  );
  if (inProgressNodes.length > 0) {
    inProgressNodes.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return inProgressNodes[0];
  }

  // Find or create "Touched Files" node under root
  const root = doc.nodes["root"];
  const existingFilesNode = Object.values(doc.nodes).find(
    (n) => n.parent === "root" && (n.label === "Touched Files" || n.type === "file"),
  );
  if (existingFilesNode) {
    return existingFilesNode;
  }

  const id = `n_${nanoid(6)}`;
  const filesNode: MindmapNode = {
    id,
    label: "Touched Files",
    type: "file",
    status: "in_progress",
    children: [],
    parent: "root",
    files: [],
    updatedAt: new Date().toISOString(),
  };
  doc.nodes[id] = filesNode;
  if (root) {
    root.children.push(id);
  }
  return filesNode;
}

/**
 * Upsert a FileTouch entry onto a node.
 */
export function upsertNodeFileTouch(node: MindmapNode, touch: FileTouch): void {
  if (!node.files) {
    node.files = [];
  }
  const now = new Date().toISOString();
  const normalizedTouch: FileTouch = {
    ...touch,
    action: touch.action || "modify",
    timestamp: touch.timestamp || now,
  };

  const existingIdx = node.files.findIndex((f) => f.path === normalizedTouch.path);
  if (existingIdx >= 0) {
    const prev = node.files[existingIdx];
    node.files[existingIdx] = {
      ...prev,
      ...normalizedTouch,
      symbols: normalizedTouch.symbols ?? prev.symbols,
      lines: normalizedTouch.lines ?? prev.lines,
      summary: normalizedTouch.summary ?? prev.summary,
    };
  } else {
    node.files.push(normalizedTouch);
  }
  node.updatedAt = now;
}

/* ------------------------------------------------------------------ */
/*  Active workspace directory watchers                                */
/* ------------------------------------------------------------------ */

const activeWatchers = new Map<string, FSWatcher>();

export function ensureWorkspaceWatcher(mindmapId: string, workspacePath?: string): void {
  if (!workspacePath || !existsSync(workspacePath)) return;
  const resolved = path.resolve(workspacePath);
  const key = `${mindmapId}:${resolved}`;
  if (activeWatchers.has(key)) return;

  const pendingFiles = new Map<string, FileAction>();
  let debounceTimer: NodeJS.Timeout | null = null;

  const flush = async () => {
    debounceTimer = null;
    if (pendingFiles.size === 0) return;
    const batch = Array.from(pendingFiles.entries());
    pendingFiles.clear();

    const doc = await store.load(mindmapId);
    if (!doc) return;

    const targetNode = resolveTargetNodeForFile(doc);
    let changed = false;

    for (const [relPath, action] of batch) {
      upsertNodeFileTouch(targetNode, {
        path: relPath,
        action,
        summary: `Auto-detected file ${action}`,
      });
      store.recordActivity(doc, `File ${action}: ${relPath}`, {
        nodeId: targetNode.id,
        file: relPath,
      });
      changed = true;
    }

    if (changed) {
      await store.save(doc);
    }
  };

  try {
    const watcher = watch(resolved, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const relPath = filename.replace(/\\/g, "/");
      if (shouldIgnorePath(relPath)) return;

      const fullPath = path.join(resolved, filename);
      const exists = existsSync(fullPath);
      const action: FileAction = !exists
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
