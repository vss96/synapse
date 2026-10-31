/** Draws the map: cards, tree edges and flow links, as SVG. */

import { touchChanges } from "../src/model/file-stats.js";
import { isTask } from "../src/model/kinds.js";
import type { MindmapDocument, MindmapNode, NodeId } from "../src/model/schema.js";
import type { Box } from "./camera.js";
import { nodeBoxes, placeCamera, setSceneSize, showNode, svgEl } from "./canvas.js";
import { expandTo, toggleCollapsed } from "./collapse.js";
import { STATUS_LABELS, TYPE_BADGES, nodeChanges, tallyChanges, tallySvg, toneClass } from "./display.js";
import { byId, escXml, setHtml } from "./dom.js";
import { ROOT, latestActiveTask, layoutTree, type ViewMode } from "./layout.js";
import { routeBounds, routeLinks } from "./link-routing.js";
import { openSidebar } from "./panels.js";
import { updateTabUI } from "./sidebar.js";
import { isHighlighted, nodeById, render, selectNode, state } from "./state.js";
import { fitLine, wrapLines, type Measure } from "./text-fit.js";

const CARD_W = 235;
/** What's left of a card's width for its text, between the padding on both sides. */
const TEXT_W = CARD_W - 24;
const TITLE_LINE_H = 15;
const MAX_TITLE_LINES = 2;
/** Tasks in a grid get a step number (viewer/layout.ts), so card sizes leave room for one. */
const STEP_PREFIX = "00. ";

const textContext = document.createElement("canvas").getContext("2d");
const FONT_FAMILY = getComputedStyle(document.body).fontFamily || "sans-serif";

/** Measures text in pixels in a font, or estimates it where there's no canvas to measure with. */
function measurer(font: string, charWidth: number): Measure {
  return (text) => {
    if (!textContext) return text.length * charWidth;
    textContext.font = font;
    return textContext.measureText(text).width;
  };
}

// These match .node-title, .node-meta-text and .node-file-text in index.html.
const titleWidth = measurer(`600 12.5px ${FONT_FAMILY}`, 7);
const metaWidth = measurer(`10.5px ${FONT_FAMILY}`, 5.5);
const fileWidth = measurer("10px ui-monospace, SFMono-Regular, Menlo, monospace", 6);

const titleLines = (title: string) => wrapLines(title, TEXT_W, MAX_TITLE_LINES, titleWidth);

// ── Card size (layout.ts places the cards; renderMap() draws these rows) ──
function getNodeSize(node: MindmapNode) {
  const fileCount = node.files.length;
  const hasNotes = Boolean(node.notes);
  const hasStatusOrType = node.type !== "root" && (isTask(node) || Boolean(TYPE_BADGES[node.type]));
  let h = 44 + (titleLines(`${STEP_PREFIX}${node.label}`).length - 1) * TITLE_LINE_H;
  if (hasStatusOrType) h += 16;
  if (hasNotes) h += 16;
  if (nodeChanges(node).length > 0) h += 16;
  if (fileCount > 0) h += Math.min(fileCount, 2) * 20 + 6;
  return { w: CARD_W, h };
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

/** What a card is called to a screen reader: the visible card says the rest with color and icons. */
function cardName(node: MindmapNode, title: string) {
  return [title, TYPE_BADGES[node.type] ? node.type.replace("_", " ") : "", isTask(node) ? node.status.replace("_", " ") : ""].filter(Boolean).join(", ");
}

/** The pill on a branch's right edge: folds it, or says how many cards it's hiding. */
function foldPillHtml(right: number, centerY: number, hidden: number) {
  const label = hidden ? `+${hidden}` : "−";
  const w = hidden ? 14 + label.length * 6 : 16;
  const title = hidden ? `Unfold ${hidden} hidden card${hidden === 1 ? "" : "s"}` : "Fold this branch";
  return `
    <g class="fold-pill ${hidden ? "folded" : ""}">
      <title>${title}</title>
      <rect x="${right - 3}" y="${centerY - 8}" width="${w}" height="16" rx="8" ry="8"/>
      <text x="${right - 3 + w / 2}" y="${centerY}">${label}</text>
    </g>`;
}

const EMPTY_VIEW_MESSAGES: Record<ViewMode, string> = {
  all: "No cards in this session yet",
  plan: "No plan in this session",
  hld: "No code mental model in this session",
};

const viewEmpty = byId("view-empty");
let lastActive: { session?: string; task?: string } = {};

/** Draw `doc`, or the empty state without one. */
export function renderMap(doc: MindmapDocument | null): void {
  const svg = svgEl;
  const empty = byId("empty-state");

  if (!doc || !doc.nodes[ROOT]) {
    svg.innerHTML = "";
    viewEmpty.hidden = true;
    empty.style.display = "flex";
    return;
  }
  empty.style.display = "none";
  followActiveTask(doc);

  const nodes = doc.nodes;
  const layout = layoutTree(doc, state.viewMode, getNodeSize, state.collapsed);
  if (!layout) {
    svg.innerHTML = "";
    return;
  }
  const { positions, grids, context, branches } = layout;
  const emptyView = positions.size <= 1 ? EMPTY_VIEW_MESSAGES[state.viewMode] : "";
  viewEmpty.textContent = emptyView;
  viewEmpty.hidden = !emptyView;
  // Tab reaches the map at one card, the selected one; the arrow keys go from there.
  const focusable = [...positions.keys()].find((id) => id === state.selectedNodeId) ?? ROOT;
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

  const routes = routeLinks(doc.links, positions);
  const boxes: Box[] = [
    ...[...positions.values()].map((p) => ({ x: p.x, y: p.y - p.h / 2, w: p.w, h: p.h })),
    ...grids,
    ...routes.map(routeBounds),
  ];
  const minX = Math.min(...boxes.map((b) => b.x));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));

  const PAD = 80;
  setSceneSize({ w: maxX - minX + PAD * 2, h: maxY - minY + PAD * 2 });
  const OFX = PAD - minX;
  const OFY = PAD - minY;
  nodeBoxes.clear();

  let edges = "";
  let gridEls = "";
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
    classes.push(`type-${escXml(node.type)}`);
    if (isTask(node)) classes.push(`status-${escXml(node.status)}`);
    // Concepts are colored by type, tasks by status (planned tasks stay neutral).
    const tone = TYPE_BADGES[node.type] ? node.type : isTask(node) ? node.status : undefined;
    if (tone && tone !== "planned") classes.push("toned", toneClass(tone));
    const selected = id === state.selectedNodeId;
    if (selected) classes.push("selected");
    if (isHighlighted(node)) classes.push("file-highlighted");
    if (context.has(id)) classes.push("context");

    const topY = py - p.h / 2;
    let cursorY = topY + 20;
    // Agents often number steps themselves ("1. Configure…"); don't number those twice.
    const step = /^\s*\d+[.)]\s/.test(node.label) ? undefined : stepNumbers.get(id);

    const title = step ? `${step}. ${node.label}` : node.label;

    const lines = titleLines(title);
    let innerContent = lines.map((line, i) => `<text class="node-title" x="${px + 12}" y="${cursorY + i * TITLE_LINE_H}">${escXml(line)}</text>`).join("");
    cursorY += (lines.length - 1) * TITLE_LINE_H;

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
      innerContent += `<text class="node-meta-text" x="${px + 12}" y="${cursorY}">💬 ${escXml(fitLine(node.notes, TEXT_W - 18, metaWidth))}</text>`;
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
      const tallyW = fileWidth("0".repeat(tallyChanges(changes).reduce((n, [, c]) => n + String(c).length + 2, 0)));
      innerContent += `
        <rect class="node-file-chip ${toneClass(action)}" x="${px + 10}" y="${cursorY - 12}" width="${p.w - 20}" height="16"/>
        <text class="node-file-text" x="${px + 15}" y="${cursorY - 1}"><tspan class="svg-tone ${toneClass(action)}" font-weight="700">${escXml(action.charAt(0).toUpperCase())}</tspan> ${escXml(fitLine(shownName + extraCount, Math.max(60, p.w - 42 - tallyW), fileWidth))} ${tallySvg(changes)}</text>
      `;
    });

    const hiddenCards = branches.get(id);
    const expandedAttr = hiddenCards === undefined ? "" : `aria-expanded="${hiddenCards === 0}"`;
    nodeEls += `
      <g class="${classes.join(" ")}" data-node-id="${escXml(id)}" data-focus="node:${escXml(id)}" role="treeitem" tabindex="${id === focusable ? 0 : -1}" aria-level="${p.depth + 1}" aria-selected="${selected}" aria-label="${escXml(cardName(node, title))}" ${expandedAttr}>
        <title>${escXml(node.notes ? `${title}\n\n${node.notes}` : title)}</title>
        ${selected ? `<rect class="node-select-ring" x="${px - 5}" y="${topY - 5}" width="${p.w + 10}" height="${p.h + 10}"/>` : ""}
        <rect class="node-rect" x="${px}" y="${topY}" width="${p.w}" height="${p.h}"/>
        ${innerContent}
        ${hiddenCards === undefined ? "" : foldPillHtml(px + p.w, py, hiddenCards)}
      </g>`;
  }

  for (const g of grids) {
    const p = positions.get(g.parent);
    if (!p) continue;
    const members = g.members.flatMap((id) => nodes[id] ?? []);
    edges += edgePath(edgeClass(members), p.x + OFX + p.w, p.y + OFY, g.x + OFX, g.y + OFY + g.h / 2);
    gridEls += `<rect class="node-grid" x="${g.x + OFX}" y="${g.y + OFY}" width="${g.w}" height="${g.h}"/>`;
  }

  // Lines go under the cards, so they never cover a card's text; their labels stay on top.
  let flowLinksSvg = "";
  let flowLabelsSvg = "";
  for (const { link, x1, y1, cx, cy, x2, y2, label, pill } of routes) {
    const ends = `data-link="${escXml(link.id)}" data-from="${escXml(link.from)}" data-to="${escXml(link.to)}"`;
    const styleCls = link.style || "solid";
    flowLinksSvg += `
      <path class="flow-link ${escXml(styleCls)}" ${ends} marker-end="url(#flow-arrow)" d="M${x1 + OFX},${y1 + OFY} Q${cx + OFX},${cy + OFY} ${x2 + OFX},${y2 + OFY}"/>
    `;
    flowLabelsSvg += `
      <g class="flow-label" ${ends}>
        <title>${escXml(link.notes ? `${link.label}\n\n${link.notes}` : link.label)}</title>
        <rect class="flow-label-bg" x="${pill.x + OFX}" y="${pill.y + OFY}" width="${pill.w}" height="${pill.h}"/>
        <text class="flow-label-text" x="${pill.x + OFX + pill.w / 2}" y="${pill.y + OFY + pill.h / 2}">${escXml(label)}</text>
      </g>
    `;
  }

  setHtml(svg, `
    <defs>
      <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path class="flow-arrow-head" d="M 0 1 L 10 5 L 0 9 z"/>
      </marker>
    </defs>
    <g class="scene">
      ${edges}
      ${gridEls}
      ${flowLinksSvg}
      ${nodeEls}
      ${flowLabelsSvg}
    </g>`);

  placeCamera(doc);
}

/**
 * Unfold the branches hiding a task as the agent moves on to it. Only then: folding it again sticks,
 * and so does a fold a session is opened with, which isn't the agent moving on.
 */
function followActiveTask(doc: MindmapDocument) {
  const active = latestActiveTask(doc);
  if (active && doc.id === lastActive.session && active.id !== lastActive.task) expandTo(doc, active);
  lastActive = { session: doc.id, task: active?.id };
}

/** Pick a card, the way clicking it does. */
function pickCard(id: string) {
  selectNode(id);
  state.activeTab = "inspector";
  state.changeKindFilter = null;
  updateTabUI();
  openSidebar();
  render();
}

function toggleFold(id: string) {
  toggleCollapsed(id);
  render();
}

// The canvas is redrawn on every update, so its events are delegated to the <svg>, which stays.
svgEl.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const id = e.target.closest<SVGGElement>(".node-group")?.dataset.nodeId;
  if (id && e.target.closest(".fold-pill")) toggleFold(id);
  else if (id) pickCard(id);
  else {
    const from = e.target.closest<SVGGElement>(".flow-label")?.dataset.from;
    if (from) showNode(from);
  }
});

/** Trace a link to the cards at its ends, or clear the trace. */
function traceLink(link: SVGElement | null | undefined) {
  svgEl.querySelectorAll(".traced").forEach((el) => el.classList.remove("traced"));
  if (!link) return;
  const { from = "", to = "", link: linkId = "" } = link.dataset;
  const ends = [from, to].map((id) => `.node-group[data-node-id="${CSS.escape(id)}"]`);
  svgEl.querySelectorAll([`[data-link="${CSS.escape(linkId)}"]`, ...ends].join(",")).forEach((el) => el.classList.add("traced"));
}

svgEl.addEventListener("mouseover", (e) => {
  if (e.target instanceof Element) traceLink(e.target.closest<SVGElement>(".flow-label, .flow-link"));
});
svgEl.addEventListener("mouseleave", () => traceLink(null));

/** Move keyboard focus to a card, selecting it and bringing it into view. */
function focusCard(id: string) {
  showNode(id);
  const card = svgEl.querySelector<SVGGElement>(`[data-focus="node:${CSS.escape(id)}"]`);
  card?.focus({ preventScroll: true });
}

/** The card an arrow key leads to: Left to the parent, Right to the first child, Up and Down to siblings. */
function cardByArrow(doc: MindmapDocument, node: MindmapNode, key: string): string | undefined {
  // As drawn: the layout puts the plan above the mental model, whichever came first.
  const boxOf = (id: string) => nodeBoxes.get(id) ?? { x: 0, y: 0 };
  const drawn = (ids: readonly string[]) => ids.filter((id) => nodeBoxes.has(id)).sort((a, b) => boxOf(a).y - boxOf(b).y || boxOf(a).x - boxOf(b).x);
  if (key === "ArrowRight") return drawn(node.children)[0];
  if (key === "ArrowLeft") return node.parent ?? undefined;
  const siblings = drawn(node.parent === null ? [] : (doc.nodes[node.parent]?.children ?? []));
  return siblings[siblings.indexOf(node.id) + (key === "ArrowDown" ? 1 : -1)];
}

svgEl.addEventListener("keydown", (e) => {
  const doc = state.currentDoc;
  if (!doc || !(e.target instanceof Element) || e.metaKey || e.ctrlKey || e.altKey) return;
  const node = nodeById(doc, e.target.closest<SVGGElement>(".node-group")?.dataset.nodeId ?? "");
  if (!node) return;
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
    const next = cardByArrow(doc, node, e.key);
    if (next) focusCard(next);
  } else if (e.key === "Enter" || e.key === " ") {
    pickCard(node.id);
  } else if (e.key === "-" || e.key === "+" || e.key === "=") {
    const folds = node.type !== "root" && (state.collapsed.has(node.id) || node.children.some((id) => nodeBoxes.has(id)));
    if (folds && state.collapsed.has(node.id) === (e.key !== "-")) toggleFold(node.id);
  } else {
    return;
  }
  e.preventDefault();
});
