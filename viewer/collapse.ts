/** Which branches are folded away on the canvas, remembered per session. */

import type { MindmapDocument, MindmapNode } from "../src/model/schema.js";
import { ancestors } from "./layout.js";
import { state } from "./state.js";

const storageKey = (sessionId: string) => `synapse.collapsed.${sessionId}`;

/** The branches folded in a session, as far as this browser remembers. */
export function loadCollapsed(sessionId: string): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey(sessionId)) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(): void {
  if (!state.currentId) return; // a file from disk isn't a session to remember anything about
  try {
    const key = storageKey(state.currentId);
    if (state.collapsed.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...state.collapsed]));
  } catch {
    // Storage blocked or full: the branch still folds, it just isn't remembered.
  }
}

export function toggleCollapsed(id: string): void {
  if (!state.collapsed.delete(id)) state.collapsed.add(id);
  saveCollapsed();
}

/** Unfold whatever hides `node`. */
export function expandTo(doc: MindmapDocument, node: MindmapNode): void {
  const before = state.collapsed.size;
  for (const parent of ancestors(doc, node)) state.collapsed.delete(parent.id);
  if (state.collapsed.size !== before) saveCollapsed();
}
