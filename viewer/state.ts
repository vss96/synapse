/** What the viewer is showing right now. Modules read and change it, then call `render()`. */

import type { ChangeKind } from "../src/model/kinds.js";
import type { MindmapDocument, MindmapListItem, MindmapNode, NodeId, UnreadableMindmap } from "../src/model/schema.js";
import { kindOf, nodeChanges } from "./display.js";
import { ROOT, type ViewMode } from "./layout.js";
import { matchesQuery } from "./search.js";
import { sessionIdFromHash } from "./session-link.js";

export const SIDEBAR_TABS = ["inspector", "files", "activity"] as const;
export type SidebarTab = (typeof SIDEBAR_TABS)[number];

export interface ViewerState {
  currentId: string;
  currentDoc: MindmapDocument | null;
  /** Plain string: it also comes from DOM data attributes; resolve it with nodeById. */
  selectedNodeId: string;
  highlightedFilePath: string | null;
  changeKindFilter: ChangeKind | null;
  activeTab: SidebarTab;
  viewMode: ViewMode;
  sessions: MindmapListItem[];
  unreadableSessions: UnreadableMindmap[];
  sessionQuery: string;
  /** The text in the canvas's find box; matching cards are highlighted. */
  mapQuery: string;
}

export const state: ViewerState = {
  currentId: sessionIdFromHash(location.hash),
  currentDoc: null,
  selectedNodeId: ROOT,
  highlightedFilePath: null,
  changeKindFilter: null,
  activeTab: "inspector",
  viewMode: "all",
  sessions: [],
  unreadableSessions: [],
  sessionQuery: "",
  mapQuery: "",
};

let draw = () => {};

/** Set what `render()` runs; app.ts composes it, so the modules that call it needn't import each other. */
export function onRender(fn: () => void): void {
  draw = fn;
}

/** Redraw everything from `state`. */
export function render(): void {
  draw();
}

/** Looks up a node by an untrusted id (URL, DOM attribute). */
export function nodeById(doc: MindmapDocument, id: string): MindmapNode | undefined {
  // hasOwn has just checked that `id` is one of the document's NodeId keys.
  return Object.hasOwn(doc.nodes, id) ? doc.nodes[id as NodeId] : undefined;
}

/** Whether the node touched the file or logged the change kind picked in the sidebar, or matches the find box. */
export function isHighlighted(node: MindmapNode) {
  return (
    (state.highlightedFilePath !== null && node.files.some((f) => f.path === state.highlightedFilePath)) ||
    (state.changeKindFilter !== null && nodeChanges(node).some((c) => kindOf(c) === state.changeKindFilter)) ||
    matchesQuery(node, state.mapQuery)
  );
}
