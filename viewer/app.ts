import {
  CHANGE_KINDS as KIND_ORDER,
  isChangeKind,
  isTask,
  type ChangeKind,
  type FileAction,
  type NodeType,
  type TaskStatus,
} from "../src/model/kinds.js";
import type { CodeChange, FileTouch, MindmapDocument, MindmapList, MindmapListItem, MindmapNode, NodeId, UnreadableMindmap } from "../src/model/schema.js";
import {
  READABLE_SCALE,
  centerCamera,
  fitCamera,
  fitScale,
  revealCamera,
  wheelZoomFactor,
  zoomAt,
  type Box,
  type Camera,
  type Size,
} from "./camera.js";
import { ROOT, VIEW_MODES, layoutTree, type ViewMode } from "./layout.js";
import { matchesQuery } from "./search.js";
import { sessionHash, sessionIdFromHash } from "./session-link.js";
import { dayLabel } from "./time.js";

const SIDEBAR_TABS = ["inspector", "files", "activity"] as const;
type SidebarTab = (typeof SIDEBAR_TABS)[number];

/** A change as shown in the sidebar; `via` lists the nodes that logged it. */
type DisplayChange = CodeChange & { via?: string[] };

/** A file aggregated across every node that touched it. */
interface AggregatedFile {
  /** The latest touch: decides path, action, summary, lines and previous path. */
  touch: FileTouch;
  /** Changes from every touch, merged on kind + symbol. */
  changes: Array<CodeChange & { via: string[] }>;
  nodes: MindmapNode[];
}

interface ViewerEvent {
  type: "connected" | "mindmap_updated";
  id?: string;
  timestamp: string;
}

interface SyncGitResponse {
  synced?: number;
  mindmap?: MindmapDocument;
  error?: string;
}

/** The element with this id, checked to be a `type` (an HTMLElement unless given). */
function byId(id: string): HTMLElement;
function byId<T extends Element>(id: string, type: new () => T): T;
function byId(id: string, type: new () => Element = HTMLElement): Element {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(el ? `#${id} is not a ${type.name}` : `Missing #${id}`);
  return el;
}

function query(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(el ? `${selector} is not an HTMLElement` : `Missing ${selector}`);
  return el;
}

/**
 * Parses JSON from the Synapse server (API responses and live events). Typed, not validated: the
 * server only sends mindmaps it checked with zod (src/model/schema.ts), and checking them again here
 * would bundle zod.
 */
function serverJson<T>(json: string): T {
  return JSON.parse(json) as T;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  planned: "○ Planned",
  in_progress: "◐ In Progress",
  completed: "✔ Completed",
  blocked: "✖ Blocked",
};

const TYPE_BADGES: Partial<Record<NodeType, string>> = {
  component: "📦 Component",
  data_flow: "⇄ Data Flow",
  hypothesis: "💡 Hypothesis",
  decision: "⚖️ Decision",
  risk: "⚠️ Risk",
};

// Colors live in index.html: a `tone-<key>` class (task status, concept type, change kind or
// file action) sets the --c color that badges, tallies and cards use, in light and dark mode.
const toneClass = (key: TaskStatus | NodeType | ChangeKind | FileAction) => `tone-${escXml(key)}`;

// Symbol-level change kinds, shown in KIND_ORDER (kinds.ts's CHANGE_KINDS).
const CHANGE_KINDS: Record<ChangeKind, { glyph: string; label: string }> = {
  add: { glyph: "+", label: "Added" },
  modify: { glyph: "~", label: "Modified" },
  fix: { glyph: "✱", label: "Fixed" },
  refactor: { glyph: "⟲", label: "Refactored" },
  rename: { glyph: "↦", label: "Renamed" },
  remove: { glyph: "−", label: "Removed" },
  test: { glyph: "✓", label: "Tested" },
};

let currentId = sessionIdFromHash(location.hash);
let currentDoc: MindmapDocument | null = null;
/** Plain string: it also comes from DOM data attributes; resolve it with nodeById. */
let selectedNodeId: string = ROOT;
let highlightedFilePath: string | null = null;
let changeKindFilter: ChangeKind | null = null;
let activeTab: SidebarTab = "inspector";
let viewMode: ViewMode = "all";
let sessions: MindmapListItem[] = [];
let unreadableSessions: UnreadableMindmap[] = [];
let sessionQuery = "";
/** The text in the canvas's find box; matching cards are highlighted. */
let mapQuery = "";

/** Looks up a node by an untrusted id (URL, DOM attribute). */
function nodeById(doc: MindmapDocument, id: string): MindmapNode | undefined {
  // hasOwn has just checked that `id` is one of the document's NodeId keys.
  return Object.hasOwn(doc.nodes, id) ? doc.nodes[id as NodeId] : undefined;
}

/** Uploaded files aren't validated; unknown change kinds display as "modify". */
function kindOf(change: CodeChange): ChangeKind {
  return isChangeKind(change.kind) ? change.kind : "modify";
}

function touchChanges(f: FileTouch): readonly CodeChange[] {
  return f.action === "read" ? [] : f.changes;
}

function nodeChanges(node: MindmapNode): CodeChange[] {
  return node.files.flatMap(touchChanges);
}

/** [[kind, count], ...] in display order, non-zero only. */
function tallyChanges(changes: readonly CodeChange[]): Array<[ChangeKind, number]> {
  const counts: Partial<Record<ChangeKind, number>> = {};
  for (const c of changes) counts[kindOf(c)] = (counts[kindOf(c)] || 0) + 1;
  return KIND_ORDER.filter((k) => counts[k]).map((k): [ChangeKind, number] => [k, counts[k] ?? 0]);
}

function tallySvg(changes: readonly CodeChange[]) {
  return tallyChanges(changes)
    .map(([k, n]) => `<tspan class="svg-tone ${toneClass(k)}" font-weight="700">${CHANGE_KINDS[k].glyph}${n} </tspan>`)
    .join("");
}

function tallyHtml(changes: readonly CodeChange[]) {
  return tallyChanges(changes)
    .map(([k, n]) => `<span class="kind-tally ${toneClass(k)}" title="${CHANGE_KINDS[k].label}">${CHANGE_KINDS[k].glyph}${n}</span>`)
    .join("");
}

function changeRowHtml(c: CodeChange, via?: string) {
  const k = kindOf(c);
  const name = c.kind === "rename" ? `${c.previousSymbol} → ${c.symbol}` : c.symbol;
  return `
    <div class="change-row ${toneClass(k)}">
      <span class="kind-badge">${CHANGE_KINDS[k].glyph} ${escXml(c.kind)}</span>
      <span><code>${escXml(name)}</code>${c.detail ? ` <span class="change-detail">— ${escXml(c.detail)}</span>` : ""}${via ? ` <span class="change-detail">(${escXml(via)})</span>` : ""}</span>
    </div>`;
}

function filePathHtml(f: FileTouch) {
  const from = f.action === "rename" ? `${escXml(f.previousPath)} → ` : "";
  return `${from}${escXml(f.path)}${f.lines ? `:${escXml(f.lines)}` : ""}`;
}

function fileItemHtml(
  f: FileTouch,
  { changes = touchChanges(f), meta = "" }: { changes?: readonly DisplayChange[]; meta?: string } = {}
) {
  const action = f.action;
  return `
    <div class="file-item ${highlightedFilePath === f.path ? "active-highlight" : ""}" data-file-path="${escXml(f.path)}">
      <div class="file-header">
        <span class="action-badge ${toneClass(action)}">${escXml(action)}</span>
        <span>${filePathHtml(f)}</span>
      </div>
      ${f.summary ? `<div class="file-summary">${escXml(f.summary)}</div>` : ""}
      ${changes.length ? `<div class="change-list">${changes.map((c) => changeRowHtml(c, c.via && c.via.join(", "))).join("")}</div>` : ""}
      ${!changes.length && f.symbols && f.symbols.length ? `<div class="file-meta">Symbols: <code>${escXml(f.symbols.join(", "))}</code></div>` : ""}
      ${meta}
    </div>`;
}

// ── Card size (layout.ts places the cards; render() draws these rows) ──
function getNodeSize(node: MindmapNode) {
  const w = 235;
  const fileCount = node.files.length;
  const hasNotes = Boolean(node.notes);
  const hasStatusOrType = node.type !== "root" && (isTask(node) || Boolean(TYPE_BADGES[node.type]));
  let h = 44;
  if (hasStatusOrType) h += 16;
  if (hasNotes) h += 16;
  if (nodeChanges(node).length > 0) h += 16;
  if (fileCount > 0) h += Math.min(fileCount, 2) * 20 + 6;
  return { w, h };
}

function truncate(str: string | undefined, max: number) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function escXml(s: unknown) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Whether the node touched the file or logged the change kind picked in the sidebar, or matches the find box. */
function isHighlighted(node: MindmapNode) {
  return (
    (highlightedFilePath !== null && node.files.some((f) => f.path === highlightedFilePath)) ||
    (changeKindFilter !== null && nodeChanges(node).some((c) => kindOf(c) === changeKindFilter)) ||
    matchesQuery(node, mapQuery)
  );
}

/** Dashed while a child is in progress, green once every child is completed. */
function edgeClass(children: readonly MindmapNode[]) {
  if (children.some((n) => isTask(n) && n.status === "in_progress")) return "edge edge-active";
  if (children.length > 0 && children.every((n) => isTask(n) && n.status === "completed")) return "edge edge-completed";
  return "edge";
}

/** A tree edge from a parent's right side (x1, y1) to a child's left side (x2, y2). */
function edgePath(cls: string, x1: number, y1: number, x2: number, y2: number) {
  const mx = (x1 + x2) / 2;
  return `<path class="${cls}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
}

// ── Render SVG Mindmap & HLD Flow Links ─────────────────────────────────
function render(doc: MindmapDocument | null) {
  const svg = svgEl;
  const empty = byId("empty-state");

  updateSessionName(doc);
  updateHeaderProgress(doc);
  renderSidebar(doc);

  if (!doc || !doc.nodes[ROOT]) {
    svg.innerHTML = "";
    empty.style.display = "flex";
    updateMapSearchCount(null);
    return;
  }
  empty.style.display = "none";

  const nodes = doc.nodes;
  const layout = layoutTree(doc, viewMode, getNodeSize);
  if (!layout) {
    svg.innerHTML = "";
    return;
  }
  const { positions, grids } = layout;
  // Cards in a grid share one edge to its frame, and the tasks in it are numbered in reading order.
  const inGrid = new Set<NodeId>(grids.flatMap((g) => g.members));
  const stepNumbers = new Map<NodeId, number>();
  for (const g of grids) {
    let step = 0;
    for (const id of g.members) {
      const member = nodes[id];
      if (member && isTask(member)) stepNumbers.set(id, ++step);
    }
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + p.w);
    minY = Math.min(minY, p.y - p.h / 2);
    maxY = Math.max(maxY, p.y + p.h / 2);
  }
  for (const g of grids) {
    minX = Math.min(minX, g.x);
    maxX = Math.max(maxX, g.x + g.w);
    minY = Math.min(minY, g.y);
    maxY = Math.max(maxY, g.y + g.h);
  }

  const PAD = 80;
  sceneSize = { w: maxX - minX + PAD * 2, h: maxY - minY + PAD * 2 };
  const OFX = PAD - minX;
  const OFY = PAD - minY;
  nodeBoxes.clear();

  let edges = "";
  let gridEls = "";
  let flowLinksSvg = "";
  let nodeEls = "";

  for (const [id, p] of positions) {
    const node = nodes[id];
    if (!node) continue;
    const px = p.x + OFX;
    const py = p.y + OFY;
    nodeBoxes.set(id, { x: px, y: py - p.h / 2, w: p.w, h: p.h });

    // Draw cubic bezier tree edges to children (grid members get one edge to their frame, below)
    for (const cid of node.children) {
      const cp = positions.get(cid);
      const childNode = nodes[cid];
      if (!cp || !childNode || inGrid.has(cid)) continue;
      edges += edgePath(edgeClass([childNode]), px + p.w, py, cp.x + OFX, cp.y + OFY);
    }

    // Determine node classes
    const classes = ["node-group"];
    if (node.type === "root") classes.push("root");
    classes.push(`type-${node.type}`);
    if (isTask(node)) classes.push(`status-${node.status}`);
    // Concepts are colored by type, tasks by status (planned tasks stay neutral).
    const tone = TYPE_BADGES[node.type] ? node.type : isTask(node) ? node.status : undefined;
    if (tone && tone !== "planned") classes.push("toned", toneClass(tone));
    const selected = id === selectedNodeId;
    if (selected) classes.push("selected");
    if (isHighlighted(node)) classes.push("file-highlighted");

    const topY = py - p.h / 2;
    let cursorY = topY + 20;
    // Agents often number steps themselves ("1. Configure…"); don't number those twice.
    const step = /^\s*\d+[.)]\s/.test(node.label) ? undefined : stepNumbers.get(id);

    const title = step ? `${step}. ${node.label}` : node.label;

    let innerContent = `
      <text class="node-title" x="${px + 12}" y="${cursorY}">${escXml(truncate(title, 30))}</text>
    `;

    // Status (tasks only) or Semantic Thinking Type row
    const typeLabel = TYPE_BADGES[node.type];
    const stLabel = isTask(node) ? STATUS_LABELS[node.status] : "";
    if (node.type !== "root" && (typeLabel || stLabel)) {
      cursorY += 16;
      const combined = [typeLabel, stLabel].filter(Boolean).join("  ·  ");
      innerContent += `<text class="node-status-pill svg-tone ${tone ? toneClass(tone) : ""}" x="${px + 12}" y="${cursorY}">${escXml(combined)}</text>`;
    }

    // Notes preview row
    if (node.notes) {
      cursorY += 15;
      innerContent += `<text class="node-meta-text" x="${px + 12}" y="${cursorY}">💬 ${escXml(truncate(node.notes, 32))}</text>`;
    }

    // Change tally for everything this node touched (e.g. "+2 ✱1 ✓3")
    const allNodeChanges = nodeChanges(node);
    if (allNodeChanges.length > 0) {
      cursorY += 16;
      innerContent += `<text class="node-status-pill" x="${px + 12}" y="${cursorY}">${tallySvg(allNodeChanges)}</text>`;
    }

    // File chips (up to 2 shown directly on the node card), most recent first
    const files = [...node.files].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    files.slice(0, 2).forEach((f, i) => {
      cursorY += 20;
      const action = f.action;
      const name = f.path.split("/").pop() ?? "";
      const shownName = f.action === "rename" ? `${f.previousPath.split("/").pop()}→${name}` : name;
      const extraCount = i === 1 && files.length > 2 ? ` +${files.length - 2}` : "";
      const changes = touchChanges(f);
      const tallyLen = tallyChanges(changes).reduce((n, [, c]) => n + String(c).length + 2, 0);
      innerContent += `
        <rect class="node-file-chip ${toneClass(action)}" x="${px + 10}" y="${cursorY - 12}" width="${p.w - 20}" height="16"/>
        <text class="node-file-text" x="${px + 15}" y="${cursorY - 1}"><tspan class="svg-tone ${toneClass(action)}" font-weight="700">${escXml(action.charAt(0).toUpperCase())}</tspan> ${escXml(truncate(shownName + extraCount, Math.max(10, 31 - tallyLen)))} ${tallySvg(changes)}</text>
      `;
    });

    nodeEls += `
      <g class="${classes.join(" ")}" data-node-id="${escXml(id)}">
        <title>${escXml(node.notes ? `${title}\n\n${node.notes}` : title)}</title>
        ${selected ? `<rect class="node-select-ring" x="${px - 5}" y="${topY - 5}" width="${p.w + 10}" height="${p.h + 10}"/>` : ""}
        <rect class="node-rect" x="${px}" y="${topY}" width="${p.w}" height="${p.h}"/>
        ${innerContent}
      </g>`;
  }

  for (const g of grids) {
    const p = positions.get(g.parent);
    if (!p) continue;
    const members = g.members.flatMap((id) => nodes[id] ?? []);
    edges += edgePath(edgeClass(members), p.x + OFX + p.w, p.y + OFY, g.x + OFX, g.y + OFY + g.h / 2);
    gridEls += `<rect class="node-grid" x="${g.x + OFX}" y="${g.y + OFY}" width="${g.w}" height="${g.h}"/>`;
  }

  // Draw directed concept / data-flow links (doc.links)
  for (const link of doc.links) {
    const pFrom = positions.get(link.from);
    const pTo = positions.get(link.to);
    if (!pFrom || !pTo) continue;

    const sameColumn = Math.abs(pFrom.x - pTo.x) < 20;
    const verticalDist = Math.abs(pTo.y - pFrom.y);
    const skipsIntermediateCard = sameColumn && verticalDist > (pFrom.h + pTo.h) / 2 + 45;

    const lbl = truncate(link.label, 24);
    const pillW = Math.max(54, lbl.length * 6.2 + 14);

    let x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, mx: number, my: number;

    if (skipsIntermediateCard) {
      // Route cleanly along the right gutter of the column so it never crosses over tree edges or sibling cards
      x1 = pFrom.x + OFX + pFrom.w;
      y1 = pFrom.y + OFY;
      x2 = pTo.x + OFX + pTo.w;
      y2 = pTo.y + OFY;
      cx = x1 + 70;
      cy = (y1 + y2) / 2;
      mx = x1 + 35 + pillW / 2;
      my = cy;
    } else if (Math.abs(pFrom.y - pTo.y) < 20) {
      // Cards side by side (e.g. in a grid row): arc over their tops, so the line and its label
      // stay in the gap above the row instead of crossing a card
      x1 = pFrom.x + OFX + pFrom.w / 2;
      y1 = pFrom.y + OFY - pFrom.h / 2;
      x2 = pTo.x + OFX + pTo.w / 2;
      y2 = pTo.y + OFY - pTo.h / 2;
      cx = (x1 + x2) / 2;
      cy = Math.min(y1, y2) - 28;
      mx = cx;
      my = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
    } else if (sameColumn) {
      // Adjacent cards in the same column: connect bottom-center to top-center
      const goingDown = pTo.y >= pFrom.y;
      x1 = pFrom.x + OFX + pFrom.w / 2;
      y1 = pFrom.y + OFY + (goingDown ? pFrom.h / 2 : -pFrom.h / 2);
      x2 = pTo.x + OFX + pTo.w / 2;
      y2 = pTo.y + OFY + (goingDown ? -pTo.h / 2 : pTo.h / 2);
      cx = x1;
      cy = (y1 + y2) / 2;
      mx = x1;
      my = cy;
    } else {
      x1 = pFrom.x + OFX + pFrom.w / 2;
      y1 = pFrom.y + OFY + (pTo.y >= pFrom.y ? pFrom.h / 2 : -pFrom.h / 2);
      x2 = pTo.x + OFX + pTo.w / 2;
      y2 = pTo.y + OFY + (pTo.y >= pFrom.y ? -pTo.h / 2 : pTo.h / 2);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const curveOffset = Math.max(40, Math.min(110, Math.hypot(dx, dy) * 0.25));
      cx = (x1 + x2) / 2 + curveOffset;
      cy = (y1 + y2) / 2;
      mx = 0.25 * x1 + 0.5 * cx + 0.25 * x2;
      my = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
    }

    const styleCls = link.style || "solid";
    flowLinksSvg += `
      <path class="flow-link ${escXml(styleCls)}" marker-end="url(#flow-arrow)" d="M${x1},${y1} Q${cx},${cy} ${x2},${y2}"/>
    `;

    flowLinksSvg += `
      <g>
        <rect class="flow-label-bg" x="${mx - pillW / 2}" y="${my - 9}" width="${pillW}" height="18"/>
        <text class="flow-label-text" x="${mx}" y="${my}">${escXml(lbl)}</text>
      </g>
    `;
  }

  svg.innerHTML = `
    <defs>
      <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path class="flow-arrow-head" d="M 0 1 L 10 5 L 0 9 z"/>
      </marker>
    </defs>
    <g class="scene">
      ${edges}
      ${gridEls}
      ${nodeEls}
      ${flowLinksSvg}
    </g>`;

  // Move the camera only for a new session or view, or when the agent moves on to another task;
  // otherwise live updates and clicks keep whatever the user panned to.
  const active = activeNodeId(doc);
  if (viewPending || active !== lastActiveId) initialView();
  viewPending = false;
  lastActiveId = active;
  applyTransform();
  updateMapSearchCount(doc);

  document.querySelectorAll<SVGGElement>(".node-group").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedNodeId = el.dataset.nodeId ?? ROOT;
      activeTab = "inspector";
      changeKindFilter = null;
      updateTabUI();
      render(currentDoc);
    });
  });
}

// ── Header Progress & Sidebar Rendering ────────────────────────────────
function collectStats(doc: MindmapDocument | null): {
  tasks: MindmapNode[];
  completed: MindmapNode[];
  fileMap: Map<string, AggregatedFile>;
} {
  const fileMap = new Map<string, AggregatedFile>();
  if (!doc) return { tasks: [], completed: [], fileMap };
  const tasks = Object.values(doc.nodes).filter(isTask);
  const completed = tasks.filter((n) => n.status === "completed");

  // Aggregate per path across nodes; the most recent touch decides action/summary.
  // Symbol-level changes merge on kind + symbol (same rule as the server) and remember
  // every node that logged them.
  for (const n of Object.values(doc.nodes)) {
    for (const f of n.files) {
      const existing = fileMap.get(f.path);
      const agg: AggregatedFile = existing ?? { touch: f, changes: [], nodes: [n] };
      if (!existing) fileMap.set(f.path, agg);
      else if (!agg.nodes.some((x) => x.id === n.id)) agg.nodes.push(n);

      for (const c of touchChanges(f)) {
        const i = agg.changes.findIndex((x) => x.kind === c.kind && x.symbol === c.symbol);
        const same = agg.changes[i];
        if (!same) agg.changes.push({ ...c, via: [n.label] });
        else {
          agg.changes[i] = { ...c, detail: c.detail ?? same.detail, via: same.via };
          if (!same.via.includes(n.label)) same.via.push(n.label);
        }
      }
      // A newer touch wins, but keeps older details it doesn't restate.
      if (existing && f.timestamp >= existing.touch.timestamp) {
        const prev = existing.touch;
        existing.touch = {
          ...f,
          summary: f.summary ?? prev.summary,
          lines: f.lines ?? prev.lines,
          symbols: f.symbols ?? prev.symbols,
        };
      }
    }
  }
  return { tasks, completed, fileMap };
}

const APP_TITLE = document.title;

/** Names the open session in the header and on the browser tab. */
function updateSessionName(doc: MindmapDocument | null) {
  const name = byId("session-name");
  name.textContent = doc?.title ?? "";
  name.title = doc?.title ?? "";
  document.title = doc ? `${doc.title} – Synapse` : APP_TITLE;
}

function updateHeaderProgress(doc: MindmapDocument | null) {
  const wrap = byId("progress-summary");
  const fill = byId("progress-bar-fill");
  const txt = byId("progress-text");
  const filesTabBtn = byId("tab-files-btn");

  if (!doc) {
    wrap.style.display = "none";
    filesTabBtn.textContent = "Changes (0)";
    return;
  }

  const { tasks, completed, fileMap } = collectStats(doc);
  const changedFiles = [...fileMap.values()].filter((f) => f.touch.action !== "read").length;
  wrap.style.display = "flex";
  const pct = tasks.length > 0 ? Math.round((completed.length / tasks.length) * 100) : 0;
  fill.style.width = `${pct}%`;
  txt.textContent = `${completed.length}/${tasks.length} tasks (${pct}%) · ${fileMap.size} files`;
  filesTabBtn.textContent = `Changes (${changedFiles})`;
}

function renderSidebar(doc: MindmapDocument | null) {
  const container = byId("sidebar-content");
  if (!doc) {
    container.innerHTML = `<div style="color:var(--muted);font-size:13px;">Load or create a mindmap to inspect plan tasks, HLD concepts, and touched code.</div>`;
    return;
  }

  if (activeTab === "inspector") {
    const node = nodeById(doc, selectedNodeId) ?? doc.nodes[ROOT];
    if (!node) return;
    const files = node.files;

    const relatedLinks = doc.links.filter(
      (l) => l.from === node.id || l.to === node.id
    );

    let linksHtml = "";
    if (relatedLinks.length > 0) {
      linksHtml = `
        <div class="section-title">Concept & Data Flow Links (${relatedLinks.length})</div>
        ${relatedLinks
          .map((l) => {
            const isOut = l.from === node.id;
            const otherId = isOut ? l.to : l.from;
            const otherLabel = doc.nodes[otherId]?.label || otherId;
            return `
              <div class="link-item" data-jump-node="${escXml(otherId)}">
                <div><b>${isOut ? "──[" + escXml(l.label) + "]──▶" : "◀──[" + escXml(l.label) + "]──"}</b> ${escXml(otherLabel)}</div>
                ${l.notes ? `<div style="font-size:11px;color:var(--muted);margin-top:3px;">${escXml(l.notes)}</div>` : ""}
              </div>
            `;
          })
          .join("")}
      `;
    }

    const filesHtml =
      files.length === 0
        ? `<div style="color:var(--muted);font-size:12px;">No files logged on this node yet.</div>`
        : files.map((f) => fileItemHtml(f)).join("");
    const nodeTally = tallyHtml(nodeChanges(node));

    container.innerHTML = `
      <div class="inspector-card">
        <div class="inspector-title">${escXml(node.label)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;">
          <span class="type-tag ${toneClass(node.type)}">${escXml(TYPE_BADGES[node.type] || node.type)}</span>
          ${isTask(node) ? `<span class="status-tag ${toneClass(node.status)}">${escXml(node.status.replace("_", " "))}</span>` : ""}
          <span style="font-size:11px;color:var(--muted);">ID: <code>${escXml(node.id)}</code></span>
        </div>
      </div>

      ${
        node.notes
          ? `<div class="section-title">Agent Thinking / Notes</div>
             <div class="notes-box">${escXml(node.notes)}</div>`
          : ""
      }

      ${linksHtml}

      <div class="section-title">Files & Changes on Node (${files.length}) ${nodeTally}</div>
      ${filesHtml}
    `;

  } else if (activeTab === "files") {
    const { fileMap } = collectStats(doc);
    if (fileMap.size === 0) {
      container.innerHTML = `<div style="color:var(--muted);font-size:12.5px;">No files have been logged yet. Use <code>log_file_touch</code> or click <b>⎇ Sync Git</b>.</div>`;
      return;
    }

    const all = [...fileMap.values()].sort((a, b) => b.touch.timestamp.localeCompare(a.touch.timestamp));
    const changed = all.filter((f) => f.touch.action !== "read");
    const readOnly = all.filter((f) => f.touch.action === "read");
    const allChanges = changed.flatMap((f) => f.changes);

    const filterChips = [
      `<button class="kind-filter ${changeKindFilter ? "" : "active"}" data-kind="">All ${allChanges.length}</button>`,
      ...tallyChanges(allChanges).map(
        ([k, n]) =>
          `<button class="kind-filter toned ${toneClass(k)} ${changeKindFilter === k ? "active" : ""}" data-kind="${k}">${CHANGE_KINDS[k].glyph} ${CHANGE_KINDS[k].label} ${n}</button>`
      ),
    ].join("");

    const visible = changeKindFilter
      ? changed
          .map((f) => ({ f, changes: f.changes.filter((c) => kindOf(c) === changeKindFilter) }))
          .filter((x) => x.changes.length > 0)
      : changed.map((f) => ({ f, changes: f.changes }));

    const changedHtml = visible.length
      ? visible
          .map(({ f, changes }) =>
            fileItemHtml(f.touch, {
              changes,
              meta: `<div class="file-meta">via ${f.nodes.map((n) => `<b>${escXml(n.label)}</b>`).join(", ")}</div>`,
            })
          )
          .join("")
      : `<div style="color:var(--muted);font-size:12px;">No matching changes.</div>`;

    const readHtml = readOnly
      .map(
        ({ touch }) => `
        <div class="file-item read-only ${highlightedFilePath === touch.path ? "active-highlight" : ""}" data-file-path="${escXml(touch.path)}">
          <div class="file-header"><span class="action-badge read">read</span><span>${filePathHtml(touch)}</span></div>
        </div>`
      )
      .join("");

    container.innerHTML = `
      ${allChanges.length ? `<div class="kind-filters">${filterChips}</div>` : ""}
      <div class="section-title">Changed Files (${changed.length}) · newest first</div>
      ${changedHtml}
      ${readOnly.length && !changeKindFilter ? `<div class="section-title">Read for Context (${readOnly.length})</div>${readHtml}` : ""}
    `;

    container.querySelectorAll<HTMLElement>(".kind-filter").forEach((el) => {
      el.addEventListener("click", () => {
        const kind = el.dataset.kind;
        changeKindFilter = kind && isChangeKind(kind) ? kind : null;
        render(currentDoc);
        if (changeKindFilter) revealHighlighted();
      });
    });
  } else if (activeTab === "activity") {
    const log = doc.activityLog;
    if (log.length === 0) {
      container.innerHTML = `<div style="color:var(--muted);font-size:12.5px;">No activity recorded yet.</div>`;
      return;
    }
    // Newest first, under a heading for each day. Entries about a node that still exists jump to it.
    let day = "";
    container.innerHTML = log
      .map((entry) => {
        const label = dayLabel(entry.timestamp);
        const heading = label === day ? "" : `<div class="section-title">${escXml(label)}</div>`;
        day = label;
        const time = new Date(entry.timestamp);
        const body = `
          <div class="activity-time" title="${escXml(time.toLocaleString())}">${escXml(time.toLocaleTimeString())}</div>
          <div>${escXml(entry.message)}</div>`;
        const node = entry.nodeId ? nodeById(doc, entry.nodeId) : undefined;
        return node
          ? `${heading}<button class="activity-item ${node.id === selectedNodeId ? "active" : ""}" data-jump-node="${escXml(node.id)}" title="Show “${escXml(node.label)}” on the map">${body}</button>`
          : `${heading}<div class="activity-item">${body}</div>`;
      })
      .join("");
  }

  container.querySelectorAll<HTMLElement>("[data-jump-node]").forEach((el) => {
    el.addEventListener("click", () => showNode(el.dataset.jumpNode ?? ROOT));
  });
  container.querySelectorAll<HTMLElement>(".file-item").forEach((el) => {
    el.addEventListener("click", () => {
      const fp = el.dataset.filePath ?? null;
      highlightedFilePath = highlightedFilePath === fp ? null : fp;
      render(currentDoc);
      if (highlightedFilePath) revealHighlighted();
    });
  });
}

function updateTabUI() {
  document.querySelectorAll<HTMLElement>(".sidebar-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === activeTab);
  });
}

document.querySelectorAll<HTMLElement>(".sidebar-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = SIDEBAR_TABS.find((t) => t === btn.dataset.tab);
    if (!tab) return;
    activeTab = tab;
    if (activeTab !== "files") changeKindFilter = null;
    updateTabUI();
    render(currentDoc);
  });
});

// View Mode Switcher (Split / Plan / HLD)
function setViewMode(mode: ViewMode) {
  viewMode = mode;
  document.querySelectorAll<HTMLElement>("#view-switcher button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === viewMode)
  );
  viewPending = true;
  render(currentDoc);
}

document.querySelectorAll<HTMLElement>("#view-switcher button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = VIEW_MODES.find((m) => m === btn.dataset.mode);
    if (mode) setViewMode(mode);
  });
});

/** Select a node picked in the sidebar and bring it into view, switching to the split view if this view hides it. */
function showNode(id: string) {
  selectedNodeId = id;
  if (nodeBoxes.has(id) || viewMode === "all") render(currentDoc);
  else setViewMode("all");
  revealNodes([id]);
}

// ── Pan & Zoom ──────────────────────────────────────────────────
const viewport = byId("viewport");
const svgEl = byId("svg", SVGSVGElement);

let camera: Camera = { scale: 1, tx: 0, ty: 0 };
let panning = false, startX = 0, startY = 0, startTx = 0, startTy = 0;
/** Size of the laid-out tree and the box of each visible card, in scene coordinates. */
let sceneSize: Size = { w: 0, h: 0 };
const nodeBoxes = new Map<string, Box>();
/** Set when a session or view is opened, so the next render picks a fresh camera. */
let viewPending = true;
let lastActiveId: string | null = null;

function applyTransform() {
  const { scale, tx, ty } = camera;
  svgEl.querySelector(".scene")?.setAttribute("transform", `translate(${tx} ${ty}) scale(${scale})`);
}

function viewSize(): Size {
  const r = svgEl.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

/** The task the agent is working on (latest updated in progress) if it is in this view, else the root. */
function activeNodeId(doc: MindmapDocument): string {
  const active = Object.values(doc.nodes)
    .filter((n) => isTask(n) && n.status === "in_progress" && nodeBoxes.has(n.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return active?.id ?? ROOT;
}

function focusActive() {
  if (!currentDoc) return;
  const id = activeNodeId(currentDoc);
  const box = nodeBoxes.get(id);
  const view = viewSize();
  // With no active task, keep the root at the left edge so its branches fill the view.
  if (box) camera = centerCamera(id === ROOT ? box.x - 40 + view.w / 2 : box.x + box.w / 2, box.y + box.h / 2, view);
  applyTransform();
}

function fitView() {
  camera = fitCamera(sceneSize, viewSize());
  applyTransform();
}

/** Fit the whole map when it is readable that way, otherwise show the active task at full size. */
function initialView() {
  if (fitScale(sceneSize, viewSize()) >= READABLE_SCALE) fitView();
  else focusActive();
}

/** Move the camera, if needed, to show these cards (the ones drawn in the current view). */
function revealNodes(ids: readonly string[]) {
  const boxes = ids.flatMap((id) => nodeBoxes.get(id) ?? []);
  if (boxes.length === 0) return;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const w = Math.max(...boxes.map((b) => b.x + b.w)) - x;
  const h = Math.max(...boxes.map((b) => b.y + b.h)) - y;
  camera = revealCamera(camera, { x, y, w, h }, viewSize());
  applyTransform();
}

function revealHighlighted() {
  if (currentDoc) revealNodes(Object.values(currentDoc.nodes).filter(isHighlighted).map((n) => n.id));
}

function zoomFromCenter(factor: number) {
  const { w, h } = viewSize();
  camera = zoomAt(camera, factor, w / 2, h / 2);
  applyTransform();
}

byId("zoom-in").onclick = () => zoomFromCenter(1.2);
byId("zoom-out").onclick = () => zoomFromCenter(1 / 1.2);
byId("zoom-fit").onclick = fitView;
byId("zoom-focus").onclick = focusActive;

// End #svg above the bottom overlays (legend, zoom controls) so fitting and centering use the
// unobstructed area; panned content still shows beneath them because #svg doesn't clip.
const bottomOverlays = query(".canvas-bottom");
const fitAboveOverlays = () => {
  svgEl.style.height = `${Math.max(0, bottomOverlays.offsetTop - 8)}px`;
};
fitAboveOverlays(); // now, not only when observed: the first view is measured against this size
const overlayObserver = new ResizeObserver(fitAboveOverlays);
[viewport, bottomOverlays].forEach((el) => overlayObserver.observe(el));

viewport.addEventListener("mousedown", (e) => {
  if (e.target instanceof Element && (e.target.closest(".node-group") || e.target.closest(".controls") || e.target.closest(".map-search"))) return;
  panning = true;
  startX = e.clientX; startY = e.clientY;
  startTx = camera.tx; startTy = camera.ty;
});
window.addEventListener("mousemove", (e) => {
  if (!panning) return;
  camera = { ...camera, tx: startTx + (e.clientX - startX), ty: startTy + (e.clientY - startY) };
  applyTransform();
});
window.addEventListener("mouseup", () => { panning = false; });

// Zoom around the cursor, so whatever is under it stays put.
viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = svgEl.getBoundingClientRect();
  camera = zoomAt(camera, wheelZoomFactor(e), e.clientX - r.left, e.clientY - r.top);
  applyTransform();
}, { passive: false });

// ── Find on map ─────────────────────────────────────────────────
const mapSearch = byId("map-search", HTMLInputElement);
const mapSearchCount = byId("map-search-count");

/** Cards matching the find box: the ones drawn in this view in outline order, then the ones it hides. */
function mapMatches(doc: MindmapDocument | null): string[] {
  if (!doc || !mapQuery.trim()) return [];
  const ids = [...nodeBoxes.keys(), ...Object.keys(doc.nodes).filter((id) => !nodeBoxes.has(id))];
  return ids.filter((id) => {
    const node = nodeById(doc, id);
    return node !== undefined && matchesQuery(node, mapQuery);
  });
}

function updateMapSearchCount(doc: MindmapDocument | null) {
  const matches = mapMatches(doc);
  const i = matches.indexOf(selectedNodeId);
  mapSearchCount.textContent = !mapQuery.trim()
    ? ""
    : matches.length === 0
      ? "No matches"
      : i >= 0
        ? `${i + 1} of ${matches.length}`
        : `${matches.length} found`;
}

/** Select the match after (or before) the selected card, wrapping around. */
function stepMatch(delta: 1 | -1) {
  const matches = mapMatches(currentDoc);
  if (matches.length === 0) return;
  const i = matches.indexOf(selectedNodeId);
  const next = i < 0 ? (delta === 1 ? 0 : matches.length - 1) : (i + delta + matches.length) % matches.length;
  const id = matches[next];
  if (id) showNode(id);
}

mapSearch.addEventListener("input", () => {
  mapQuery = mapSearch.value;
  // Find as you type: keep the selected card while it still matches, else go to the first match.
  const matches = mapMatches(currentDoc);
  const first = matches[0];
  if (first && !matches.includes(selectedNodeId)) showNode(first);
  else render(currentDoc);
});

mapSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    stepMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    mapSearch.value = "";
    mapQuery = "";
    mapSearch.blur();
    render(currentDoc);
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

// ── Load & Refresh Mindmaps ─────────────────────────────────────
function loadMindmap(doc: MindmapDocument) {
  if (doc.id !== currentDoc?.id) viewPending = true;
  currentDoc = doc;
  currentId = doc.id;
  if (!nodeById(doc, selectedNodeId)) selectedNodeId = ROOT;
  render(doc);
}

async function fetchMindmapById(id: string) {
  if (!id) return;
  const res = await fetch(`/api/mindmaps/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.ok) {
    const doc = serverJson<MindmapDocument>(await res.text());
    if (id === currentId) loadMindmap(doc); // ignore responses for a session we already switched away from
  }
}

// ── Sessions sidebar ────────────────────────────────────────────
const LIVE_WINDOW_MS = 2 * 60 * 1000;

function timeAgo(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (!iso || Number.isNaN(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function filteredSessions() {
  const q = sessionQuery.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => `${s.title} ${s.workspacePath || ""} ${s.activeTask || ""}`.toLowerCase().includes(q));
}

// Sessions are grouped by repository (workspacePath); archived ones go in a last group of their own.
// Not a path, so it can't collide with a repository group.
const ARCHIVED_GROUP = "archived:";
const COLLAPSED_GROUPS_KEY = "synapse.collapsedGroups";

/** Group keys the user collapsed; the archived group starts collapsed. */
const collapsedGroups = new Set<string>(
  (() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? "null");
      return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [ARCHIVED_GROUP];
    } catch {
      return [ARCHIVED_GROUP];
    }
  })(),
);

function toggleGroup(key: string) {
  if (!collapsedGroups.delete(key)) collapsedGroups.add(key);
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedGroups]));
  } catch {
    // Storage blocked or full: the group still toggles, it just isn't remembered.
  }
  renderSessions();
}

interface SessionGroup {
  key: string;
  name: string;
  /** Shown on hover: the full repository path. */
  hint: string;
  items: MindmapListItem[];
}

/** Groups in order of their most recently updated session (the list arrives newest first). */
function groupSessions(items: MindmapListItem[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  const archived: SessionGroup = { key: ARCHIVED_GROUP, name: "Archived", hint: "Archived sessions", items: [] };
  for (const s of items) {
    if (s.archivedAt) {
      archived.items.push(s);
      continue;
    }
    const key = s.workspacePath ?? "";
    let group = groups.get(key);
    if (!group) {
      const name = key ? key.split(/[\\/]/).filter(Boolean).pop() ?? key : "No repository";
      group = { key, name, hint: key || "Sessions without a workspacePath", items: [] };
      groups.set(key, group);
    }
    group.items.push(s);
  }
  return archived.items.length ? [...groups.values(), archived] : [...groups.values()];
}

function sessionItemHtml(s: MindmapListItem) {
  const pct = s.totalTasks > 0 ? Math.round((s.completedTasks / s.totalTasks) * 100) : 0;
  const live = Date.now() - new Date(s.updatedAt).getTime() < LIVE_WINDOW_MS;
  const action = s.archivedAt ? "restore" : "archive";
  return `
    <div class="session-item ${s.id === currentId ? "active" : ""}" data-session-id="${escXml(s.id)}" title="${escXml(s.title)}${s.workspacePath ? `\n${escXml(s.workspacePath)}` : ""}">
      <div class="session-title">${live ? `<span class="session-live-dot" title="Updated in the last 2 minutes"></span>` : ""}<span class="session-title-text">${escXml(s.title)}</span></div>
      <div class="session-sub">${escXml(timeAgo(s.updatedAt))}
        <button class="session-action" data-action="${action}" title="${s.archivedAt ? "Restore this session" : "Archive this session"}">${s.archivedAt ? "Restore" : "Archive"}</button>
      </div>
      ${s.activeTask ? `<div class="session-task">◐ ${escXml(s.activeTask)}</div>` : ""}
      <div class="session-progress">
        <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        <span>${s.completedTasks}/${s.totalTasks} tasks · ${s.fileCount} files</span>
      </div>
    </div>`;
}

async function setArchived(id: string, archived: boolean) {
  try {
    const res = await fetch("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mindmapId: id, archived }),
    });
    if (!res.ok) throw new Error(serverJson<{ error?: string }>(await res.text()).error ?? `HTTP ${res.status}`);
  } catch (err) {
    alert(`Could not ${archived ? "archive" : "restore"} the session: ${errorMessage(err)}`);
  }
  await refreshSessions();
}

function renderSessions() {
  const list = byId("session-list");
  const visible = filteredSessions();
  const archivedCount = sessions.filter((s) => s.archivedAt).length;
  byId("sessions-count").textContent = `Sessions (${sessions.length - archivedCount})`;

  const unreadable = byId("sessions-unreadable");
  unreadable.hidden = unreadableSessions.length === 0;
  unreadable.innerHTML = `
    <div class="sessions-unreadable-head">⚠ Can't read ${unreadableSessions.length} session${unreadableSessions.length === 1 ? "" : "s"}</div>
    ${unreadableSessions.map((s) => `<div class="sessions-unreadable-item"><code>${escXml(s.id)}</code> ${escXml(s.error)}</div>`).join("")}`;

  if (visible.length === 0) {
    list.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px;">${sessions.length ? "No matching sessions." : "No sessions yet."}</div>`;
    return;
  }

  // While filtering, show every match rather than hiding some in collapsed groups.
  const filtering = sessionQuery.trim() !== "";
  list.innerHTML = groupSessions(visible)
    .map((g) => {
      const collapsed = !filtering && collapsedGroups.has(g.key);
      return `
        <div class="session-group ${g.key === ARCHIVED_GROUP ? "archived" : ""}">
          <button class="session-group-head" data-group="${escXml(g.key)}" title="${escXml(g.hint)}" aria-expanded="${!collapsed}">
            <span class="session-group-chevron">${collapsed ? "▸" : "▾"}</span>
            <span class="session-group-name">${escXml(g.name)}</span>
            <span class="session-group-count">${g.items.length}</span>
          </button>
          ${collapsed ? "" : g.items.map(sessionItemHtml).join("")}
        </div>`;
    })
    .join("");

  list.querySelectorAll<HTMLElement>(".session-group-head").forEach((el) => {
    el.addEventListener("click", () => toggleGroup(el.dataset.group ?? ""));
  });
  list.querySelectorAll<HTMLElement>(".session-item").forEach((el) => {
    el.addEventListener("click", () => selectSession(el.dataset.sessionId));
  });
  list.querySelectorAll<HTMLElement>(".session-action").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.closest<HTMLElement>(".session-item")?.dataset.sessionId;
      if (id) setArchived(id, el.dataset.action === "archive");
    });
  });
}

/** Switch to a session, leaving the URL as it is. */
async function showSession(id: string) {
  currentId = id;
  selectedNodeId = ROOT;
  highlightedFilePath = null;
  changeKindFilter = null;
  document.body.classList.remove("sessions-open");
  renderSessions();
  document.querySelector(".session-item.active")?.scrollIntoView({ block: "nearest" });
  await fetchMindmapById(id);
}

/**
 * Open a session. Switching adds a history entry, so Back returns to the session you left. With
 * `replace`, for a session nobody picked, it doesn't, so Back leaves the viewer instead of landing
 * on a URL with no session in it.
 */
async function selectSession(id: string | undefined, { replace = false } = {}) {
  if (!id || id === currentId) return;
  if (replace) history.replaceState(null, "", sessionHash(id));
  else history.pushState(null, "", sessionHash(id));
  await showSession(id);
}

/**
 * Switch to the session the URL names (Back, Forward or a pasted link). If there is no such
 * session, put back the URL of the open one.
 */
function followUrl() {
  const id = sessionIdFromHash(location.hash);
  if (id === currentId) return;
  if (sessions.some((s) => s.id === id)) showSession(id);
  else history.replaceState(null, "", sessionHash(currentId));
}

// Back and Forward fire both; a pasted link fires hashchange.
window.addEventListener("popstate", followUrl);
window.addEventListener("hashchange", followUrl);

async function refreshSessions() {
  try {
    const res = await fetch("/api/mindmaps", { cache: "no-store" });
    if (!res.ok) return;
    const list = serverJson<MindmapList>(await res.text());
    sessions = list.mindmaps;
    unreadableSessions = list.unreadable;
    renderSessions();
  } catch {
    // Viewer opened without the API server; sessions list stays empty
  }
}

async function init() {
  await refreshSessions();
  if (currentId && sessions.some((s) => s.id === currentId)) {
    await fetchMindmapById(currentId);
  } else {
    currentId = "";
    // Prefer a session that isn't archived: the Archived group starts collapsed.
    const first = sessions.find((s) => !s.archivedAt) ?? sessions[0];
    if (first) await selectSession(first.id, { replace: true });
  }
}

const sessionSearch = byId("session-search", HTMLInputElement);
sessionSearch.addEventListener("input", () => {
  sessionQuery = sessionSearch.value;
  renderSessions();
});

document.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  // Follow the list as shown: grouped, and skipping collapsed groups.
  const visible = [...document.querySelectorAll<HTMLElement>("#session-list .session-item")].map((el) => el.dataset.sessionId);
  if (visible.length === 0) return;
  e.preventDefault();
  const idx = visible.indexOf(currentId);
  const next = e.key === "ArrowDown" ? Math.min(visible.length - 1, idx + 1) : Math.max(0, idx - 1);
  selectSession(visible[next]);
});

// Wide screens dock the sessions list (remembered); narrow ones show it as a drawer over the canvas.
const narrowScreen = matchMedia("(max-width: 900px)");
if (localStorage.getItem("synapse.sessionsCollapsed") === "1") document.body.classList.add("sessions-collapsed");
byId("sessions-toggle").onclick = () => {
  if (narrowScreen.matches) {
    document.body.classList.toggle("sessions-open");
    return;
  }
  const collapsed = document.body.classList.toggle("sessions-collapsed");
  localStorage.setItem("synapse.sessionsCollapsed", collapsed ? "1" : "0");
};

setInterval(renderSessions, 30000); // keep "x m ago" and live dots fresh

byId("legend-kinds").innerHTML = KIND_ORDER.map(
  (k) => `<span class="kind-tally ${toneClass(k)}" title="${CHANGE_KINDS[k].label}">${CHANGE_KINDS[k].glyph} ${k}</span>`,
).join("");

byId("refresh-btn").onclick = async () => {
  await refreshSessions();
  await fetchMindmapById(currentId);
};

byId("sync-git-btn").onclick = async () => {
  if (!currentId) {
    alert("Select or create a mindmap first.");
    return;
  }
  try {
    const res = await fetch("/api/sync-git", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mindmapId: currentId }),
    });
    const data = serverJson<SyncGitResponse>(await res.text());
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (data.mindmap) loadMindmap(data.mindmap);
  } catch (err) {
    alert("Git sync failed: " + errorMessage(err));
  }
};

// File upload
const fileUpload = byId("file-upload", HTMLInputElement);
byId("upload-btn").onclick = () => {
  fileUpload.click();
};
fileUpload.onchange = async () => {
  const file = fileUpload.files?.[0];
  if (!file) return;
  const text = await file.text();
  try {
    // Not validated (that would bundle zod): rendering tolerates unknown change kinds (kindOf), and
    // this catch reports files it can't render.
    loadMindmap(JSON.parse(text) as MindmapDocument);
    renderSessions();
  } catch (err) {
    alert("Invalid JSON: " + errorMessage(err));
  }
  fileUpload.value = "";
};

// ── Live Server-Sent Events (SSE) Connection ────────────────────
function connectSSE() {
  const indicator = byId("live-indicator");
  const liveText = byId("live-text");
  const es = new EventSource("/events");

  es.onopen = () => {
    indicator.classList.remove("offline");
    liveText.textContent = "Live";
  };

  es.onmessage = async (event) => {
    try {
      const payload = serverJson<ViewerEvent>(event.data);
      if (payload.type === "mindmap_updated") {
        // Refresh the session list, but only reload the canvas for the session being viewed.
        await refreshSessions();
        if (!currentId && payload.id) await selectSession(payload.id, { replace: true });
        else if (payload.id === currentId) await fetchMindmapById(currentId);
      }
    } catch {
      // ignore malformed event
    }
  };

  es.onerror = () => {
    indicator.classList.add("offline");
    liveText.textContent = "Reconnecting…";
  };
}

init();
connectSSE();
