/**
 * Checks a mindmap file opened from disk. Pure, so it is unit-tested without a DOM. The server checks
 * documents with zod (src/model/schema.ts), which the viewer can't bundle, so this checks by hand
 * everything rendering relies on: a wrong file must be refused before it replaces what's on screen.
 * Unknown change kinds and link styles are fine, because `kindOf` and the styles' CSS tolerate them.
 */

import { isFileAction, isNodeType, isTaskStatus, isTaskType } from "../src/model/kinds.js";
import type { MindmapDocument } from "../src/model/schema.js";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string";

function isChange(value: unknown): boolean {
  return isObject(value) && isString(value.kind) && isString(value.symbol) && (value.kind !== "rename" || isString(value.previousSymbol));
}

function isTouch(value: unknown): boolean {
  if (!isObject(value) || !isString(value.path) || !isString(value.action) || !isString(value.timestamp)) return false;
  if (!isFileAction(value.action)) return false;
  if (value.symbols !== undefined && !(Array.isArray(value.symbols) && value.symbols.every(isString))) return false;
  if (value.action === "read") return true;
  if (value.action === "rename" && !isString(value.previousPath)) return false;
  return Array.isArray(value.changes) && value.changes.every(isChange);
}

function isNode(value: unknown, id: string): boolean {
  if (!isObject(value) || value.id !== id || !isString(value.type) || !isString(value.label) || !isString(value.updatedAt)) return false;
  if (value.notes !== undefined && !isString(value.notes)) return false;
  if (!isNodeType(value.type) || (isTaskType(value.type) && !(isString(value.status) && isTaskStatus(value.status)))) return false;
  return Array.isArray(value.children) && value.children.every(isString) && Array.isArray(value.files) && value.files.every(isTouch);
}

/** Every node hangs off the root exactly once, so walking up or down the tree always ends. */
function isTree(nodes: Record<string, unknown>): boolean {
  const { root } = nodes;
  if (!isObject(root) || root.type !== "root" || root.parent !== null) return false;
  const seen = new Set<string>();
  const queue = ["root"];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    const node = nodes[id];
    if (seen.has(id) || !isObject(node) || !Array.isArray(node.children)) return false;
    seen.add(id);
    for (const child of node.children) {
      const below = nodes[String(child)];
      if (!isObject(below) || below.parent !== id) return false;
      queue.push(String(child));
    }
  }
  return seen.size === Object.keys(nodes).length;
}

const isLink = (value: unknown, nodes: Record<string, unknown>): boolean =>
  isObject(value) && isString(value.id) && isString(value.from) && isString(value.to) && isString(value.label) && value.from in nodes && value.to in nodes;

const isActivity = (value: unknown): boolean => isObject(value) && isString(value.timestamp) && isString(value.message);

export function isMindmapDocument(value: unknown): value is MindmapDocument {
  if (!isObject(value) || !isString(value.id) || !isString(value.title) || !isObject(value.nodes)) return false;
  const { nodes, links, activityLog } = value;
  if (!Array.isArray(links) || !Array.isArray(activityLog) || !activityLog.every(isActivity)) return false;
  if (!links.every((l) => isLink(l, nodes))) return false;
  return Object.entries(nodes).every(([id, node]) => isNode(node, id)) && isTree(nodes);
}
