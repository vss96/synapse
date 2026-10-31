/** The canvas's find box. */

import type { MindmapDocument } from "../src/model/schema.js";
import { nodeBoxes, showNode } from "./canvas.js";
import { byId } from "./dom.js";
import { matchesQuery } from "./search.js";
import { nodeById, render, state } from "./state.js";

const mapSearch = byId("map-search", HTMLInputElement);
const mapSearchCount = byId("map-search-count");

/** Cards matching the find box: the ones drawn in this view in outline order, then the ones it hides. */
function mapMatches(doc: MindmapDocument | null): string[] {
  if (!doc || !state.mapQuery.trim()) return [];
  const ids = [...nodeBoxes.keys(), ...Object.keys(doc.nodes).filter((id) => !nodeBoxes.has(id))];
  return ids.filter((id) => {
    const node = nodeById(doc, id);
    return node !== undefined && matchesQuery(node, state.mapQuery);
  });
}

export function updateMapSearchCount(doc: MindmapDocument | null) {
  const matches = mapMatches(doc);
  const i = matches.indexOf(state.selectedNodeId);
  mapSearchCount.textContent = !state.mapQuery.trim()
    ? ""
    : matches.length === 0
      ? "No matches"
      : i >= 0
        ? `${i + 1} of ${matches.length}`
        : `${matches.length} found`;
}

/** Select the match after (or before) the selected card, wrapping around. */
function stepMatch(delta: 1 | -1) {
  const matches = mapMatches(state.currentDoc);
  if (matches.length === 0) return;
  const i = matches.indexOf(state.selectedNodeId);
  const next = i < 0 ? (delta === 1 ? 0 : matches.length - 1) : (i + delta + matches.length) % matches.length;
  const id = matches[next];
  if (id) showNode(id);
}

mapSearch.addEventListener("input", () => {
  state.mapQuery = mapSearch.value;
  // Find as you type: keep the selected card while it still matches, else go to the first match.
  const matches = mapMatches(state.currentDoc);
  const first = matches[0];
  if (first && !matches.includes(state.selectedNodeId)) showNode(first);
  else render();
});

mapSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    stepMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    mapSearch.value = "";
    state.mapQuery = "";
    mapSearch.blur();
    render();
  }
});

// "/" focuses the find box, unless you're typing somewhere else.
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return;
  e.preventDefault();
  mapSearch.focus();
  mapSearch.select();
});
