/**
 * Checks a mindmap file opened from disk. Pure, so it is unit-tested without a DOM. The server checks
 * documents with zod (src/model/schema.ts), which the viewer can't bundle, so this only checks the
 * shape rendering relies on; it's what stops a wrong file from breaking the page halfway through a render.
 */

import type { MindmapDocument } from "../src/model/schema.js";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function isTouch(value: unknown): boolean {
  if (!isObject(value) || typeof value.path !== "string" || typeof value.action !== "string" || typeof value.timestamp !== "string") return false;
  return value.action === "read" || Array.isArray(value.changes);
}

function isNode(value: unknown, id: string): boolean {
  if (!isObject(value) || value.id !== id || typeof value.type !== "string" || typeof value.label !== "string") return false;
  return typeof value.updatedAt === "string" && Array.isArray(value.children) && Array.isArray(value.files) && value.files.every(isTouch);
}

export function isMindmapDocument(value: unknown): value is MindmapDocument {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.title !== "string") return false;
  if (!Array.isArray(value.links) || !Array.isArray(value.activityLog) || !isObject(value.nodes)) return false;
  return isObject(value.nodes.root) && Object.entries(value.nodes).every(([id, node]) => isNode(node, id));
}
