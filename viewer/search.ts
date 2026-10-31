/**
 * Finding cards on the map by name. Pure, so it is unit-tested without a DOM.
 */

import type { FileTouch, MindmapNode } from "../src/model/schema.js";

/** The names a file touch can be found by: its path (and old path), and the symbols it touched or changed. */
function touchTerms(f: FileTouch): string[] {
  const changes = f.action === "read" ? [] : f.changes.flatMap((c) => [c.symbol, c.kind === "rename" ? c.previousSymbol : ""]);
  return [f.path, f.action === "rename" ? f.previousPath : "", ...(f.symbols ?? []), ...changes];
}

const contains = (terms: readonly string[], query: string) => terms.some((term) => term.toLowerCase().includes(query));

/**
 * Whether a card matches the map search: its label, ID or notes, or a path or symbol of a file it
 * touched, contains `query`, ignoring case. An empty query matches nothing.
 */
export function matchesQuery(node: MindmapNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return contains([node.label, node.id, node.notes ?? ""], q) || node.files.some((f) => contains(touchTerms(f), q));
}

/**
 * The file that explains why a card matches, so it can be shown: the first file matching `query`.
 * Undefined when the card's own text matches, since the card itself then explains the match.
 */
export function matchingFile(node: MindmapNode, query: string): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q || contains([node.label, node.id, node.notes ?? ""], q)) return undefined;
  return node.files.find((f) => contains(touchTerms(f), q))?.path;
}
