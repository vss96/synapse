/**
 * Finding cards on the map by name. Pure, so it is unit-tested without a DOM.
 */

import type { FileTouch, MindmapNode } from "../src/model/schema.js";

/** The names a file touch can be found by: its path (and old path), and the symbols it touched or changed. */
function touchTerms(f: FileTouch): string[] {
  const changes = f.action === "read" ? [] : f.changes.flatMap((c) => [c.symbol, c.kind === "rename" ? c.previousSymbol : ""]);
  return [f.path, f.action === "rename" ? f.previousPath : "", ...(f.symbols ?? []), ...changes];
}

/**
 * Whether a card matches the map search: its label, its ID, or a path or symbol of a file it
 * touched contains `query`, ignoring case. An empty query matches nothing.
 */
export function matchesQuery(node: MindmapNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return [node.label, node.id, ...node.files.flatMap(touchTerms)].some((term) => term.toLowerCase().includes(q));
}
