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
 * Fold a later touch of the same file into an earlier one. Reading a file never downgrades an
 * edit, creating then modifying stays a create, and renaming then modifying stays a rename.
 */
export function combineTouches(prev: FileTouch, next: FileTouch): FileTouch {
  const common = {
    path: next.path,
    lines: next.lines ?? prev.lines,
    symbols: next.symbols ?? prev.symbols,
    summary: next.summary ?? prev.summary,
    timestamp: next.timestamp,
  };
  if (next.action === "read") return prev.action === "read" ? { ...common, action: "read" } : prev;
  if (prev.action === "read") return { ...common, ...next, ...common };

  return { ...common, ...combinedAction(prev, next), changes: mergeChanges(prev.changes, next.changes) };
}

/** Record a file touch on a node, merging with an earlier touch of the same file (or of a renamed file's old path). */
export function upsertFileTouch(node: MindmapNode, touch: FileTouch): void {
  let i = node.files.findIndex((f) => f.path === touch.path);
  if (i < 0 && touch.action === "rename") i = node.files.findIndex((f) => f.path === touch.previousPath);
  const earlier = node.files[i];
  if (earlier) node.files[i] = combineTouches(earlier, touch);
  else node.files.push(touch);
  node.updatedAt = touch.timestamp;
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
