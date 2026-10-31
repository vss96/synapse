import { combineTouches } from "./file-stats.js";
import { isTask } from "./kinds.js";
import { attachChild, createChild } from "./node.js";
import { ROOT_ID, type FileTouch, type MindmapDocument, type MindmapNode, type NodeId } from "./schema.js";

export { combineTouches, mergeChanges } from "./file-stats.js";

/** Every path that a node in the mindmap has a file touch for. */
export function recordedPaths(doc: MindmapDocument): Set<string> {
  return new Set(Object.values(doc.nodes).flatMap((n) => n.files.map((f) => f.path)));
}

/**
 * Record file touches on a node in order, merging each with an earlier touch of the same file (or of a
 * renamed file's old path). The node's paths are indexed once, so a big batch doesn't rescan them per touch.
 */
export function upsertFileTouches(node: MindmapNode, touches: readonly FileTouch[]): void {
  const indexOf = new Map<string, number>();
  const repeats = new Map<string, number[]>(); // a path's later entries, when it's listed more than once
  node.files.forEach((f, i) => {
    const later = repeats.get(f.path);
    if (later) later.push(i);
    else if (indexOf.has(f.path)) repeats.set(f.path, [i]);
    else indexOf.set(f.path, i);
  });
  for (const touch of touches) {
    const i = indexOf.get(touch.path) ?? (touch.action === "rename" ? indexOf.get(touch.previousPath) : undefined) ?? node.files.length;
    const earlier = node.files[i];
    node.files[i] = earlier ? combineTouches(earlier, touch) : touch;
    if (earlier && earlier.path !== touch.path) {
      // A rename moved it, so the old path is found at its next entry, if it has one.
      const next = repeats.get(earlier.path)?.shift();
      if (next === undefined) indexOf.delete(earlier.path);
      else indexOf.set(earlier.path, next);
    }
    indexOf.set(touch.path, i);
    node.updatedAt = touch.timestamp;
  }
}

export function upsertFileTouch(node: MindmapNode, touch: FileTouch): void {
  upsertFileTouches(node, [touch]);
}

/** Whether a mindmap's work is done: it has tasks and all are completed. With no tasks, it hasn't started. */
export function isFinished(doc: MindmapDocument): boolean {
  const tasks = Object.values(doc.nodes).filter(isTask);
  return tasks.length > 0 && tasks.every((n) => n.status === "completed");
}

/** Whether the workspace watcher records into a mindmap, so whether the mindmap can take it over. */
export function collectsWorkspaceChanges(doc: MindmapDocument): boolean {
  return !doc.archivedAt && !isFinished(doc);
}

const TOUCHED_FILES_LABEL = "Touched Files";

/**
 * The node a file touch attaches to: the given node, else the most recently updated in-progress
 * task, else a "Touched Files" node under the root (created on first use).
 */
export function fileTouchTarget(doc: MindmapDocument, nodeId?: NodeId): MindmapNode {
  const explicit = nodeId && doc.nodes[nodeId];
  if (explicit) return explicit;

  const active = Object.values(doc.nodes)
    .filter(isTask)
    .filter((n) => n.status === "in_progress")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (active) return active;

  const existing = Object.values(doc.nodes).find((n) => n.parent === ROOT_ID && n.type === "file" && n.label === TOUCHED_FILES_LABEL);
  if (existing) return existing;
  const node = createChild({ type: "file", label: TOUCHED_FILES_LABEL, parent: ROOT_ID });
  attachChild(doc, node);
  return node;
}
