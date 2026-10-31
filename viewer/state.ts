/** What the viewer is showing right now. Modules read and change it, then call `render()`. */

import type { ChangeKind } from "../src/model/kinds.js";
import type { MindmapDocument, MindmapListItem, MindmapNode, NodeId, UnreadableMindmap } from "../src/model/schema.js";
import { kindOf, nodeChanges } from "./display.js";
import { ROOT, type ViewMode } from "./layout.js";
import { matchesQuery } from "./search.js";
import type { StatusFilter } from "./session-filter.js";
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
  sessionStatus: StatusFilter;
  /** The session list shows the archive instead of the working sessions. */
  showArchived: boolean;
  /** The text in the canvas's find box; matching cards are highlighted. */
  mapQuery: string;
  /** The path filter over the file list in the sidebar. */
  fileQuery: string;
  /** Whether auto-detected files are expanded in the sidebar. */
  showAutoFiles: boolean;
  /** How many rows of a file list are rendered. */
  fileLimit: number;
}

/** File lists are rendered this many rows at a time: a session can have thousands. */
export const FILE_PAGE = 50;

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
  sessionStatus: "all",
  showArchived: false,
  mapQuery: "",
  fileQuery: "",
  showAutoFiles: false,
  fileLimit: FILE_PAGE,
};

/** Back to an unfiltered first page, for a different list of files. */
export function resetFileList(): void {
  state.fileQuery = "";
  state.showAutoFiles = false;
  state.fileLimit = FILE_PAGE;
}

/** Select a card. A file highlight belongs to the card it was picked on, so it ends here. */
export function selectNode(id: string): void {
  if (id !== state.selectedNodeId) resetFileList();
  state.selectedNodeId = id;
  state.highlightedFilePath = null;
}

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
