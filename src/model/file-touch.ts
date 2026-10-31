import { isAutoDetected } from "./file-stats.js";
import { isTask } from "./kinds.js";
import { attachChild, createChild } from "./node.js";
import { ROOT_ID, type CodeChange, type EditTouch, type FileTouch, type MindmapDocument, type MindmapNode, type NodeId } from "./schema.js";

/** Merge symbol-level changes; a later change with the same kind + symbol replaces the earlier one. */
export function mergeChanges(prev: readonly CodeChange[], next: readonly CodeChange[]): CodeChange[] {
  const merged = [...prev];
  for (const change of next) {
    const i = merged.findIndex((c) => c.kind === change.kind && c.symbol === change.symbol);
    const earlier = merged[i];
    if (earlier) merged[i] = { ...change, detail: change.detail ?? earlier.detail };
    else merged.push(change);
  }
  return merged;
}

/** Every path that a node in the mindmap has a file touch for. */
export function recordedPaths(doc: MindmapDocument): Set<string> {
  return new Set(Object.values(doc.nodes).flatMap((n) => n.files.map((f) => f.path)));
}

/** The action a file ends up with after an earlier and a later edit; a rename keeps its previous path. */
function combinedAction(
  prev: EditTouch,
  next: EditTouch,
): { action: "rename"; previousPath: string } | { action: "create" | "modify" | "delete" } {
  if (next.action === "delete") return { action: "delete" };
  if (next.action === "modify" && prev.action === "create") return { action: "create" };
  if (next.action === "modify" && prev.action === "rename") return { action: "rename", previousPath: prev.previousPath };
  return next.action === "rename" ? { action: "rename", previousPath: next.previousPath } : { action: next.action };
}

/**
 * The summary and source of a file after two touches. What an agent logged outranks what the watcher
 * saw: its summary stays, the watcher's boilerplate doesn't, and the file counts as logged from then on.
 */
function combinedProvenance(prev: FileTouch, next: FileTouch): Pick<FileTouch, "summary" | "source"> {
  const [prevAuto, nextAuto] = [isAutoDetected(prev), isAutoDetected(next)];
  if (prevAuto && nextAuto) return { summary: next.summary ?? prev.summary, source: "watcher" };
  if (prevAuto) return { summary: next.summary, source: undefined };
  return { summary: nextAuto ? prev.summary : (next.summary ?? prev.summary), source: undefined };
}

/**
 * Fold a later touch of the same file into an earlier one. Reading a file never downgrades an
 * edit, creating then modifying stays a create, and renaming then modifying stays a rename.
 */
export function combineTouches(prev: FileTouch, next: FileTouch): FileTouch {
  const common = {
    path: next.path,
    lines: next.lines ?? prev.lines,
    symbols: next.symbols ?? prev.symbols,
    ...combinedProvenance(prev, next),
    timestamp: next.timestamp,
  };
  if (next.action === "read") return prev.action === "read" ? { ...common, action: "read" } : prev;
  if (prev.action === "read") return { ...common, ...next, ...common };

  return { ...common, ...combinedAction(prev, next), changes: mergeChanges(prev.changes, next.changes) };
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
