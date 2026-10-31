/** Draws the map: cards, tree edges and flow links, as SVG. */

import { isTask } from "../src/model/kinds.js";
import type { MindmapDocument, MindmapNode, NodeId } from "../src/model/schema.js";
import { nodeBoxes, placeCamera, setSceneSize, svgEl } from "./canvas.js";
import { STATUS_LABELS, TYPE_BADGES, nodeChanges, tallyChanges, tallySvg, toneClass } from "./display.js";
import { touchChanges } from "../src/model/file-stats.js";
import { byId, escXml, truncate } from "./dom.js";
import { ROOT, layoutTree } from "./layout.js";
import { updateTabUI } from "./sidebar.js";
import { isHighlighted, render, selectNode, state } from "./state.js";

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

/** Draw `doc`, or the empty state without one. */
export function renderMap(doc: MindmapDocument | null): void {
  const svg = svgEl;
  const empty = byId("empty-state");

  if (!doc || !doc.nodes[ROOT]) {
    svg.innerHTML = "";
    empty.style.display = "flex";
    return;
  }
  empty.style.display = "none";

  const nodes = doc.nodes;
  const layout = layoutTree(doc, state.viewMode, getNodeSize);
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
  setSceneSize({ w: maxX - minX + PAD * 2, h: maxY - minY + PAD * 2 });
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
    const selected = id === state.selectedNodeId;
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

  placeCamera(doc);

  document.querySelectorAll<SVGGElement>(".node-group").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      selectNode(el.dataset.nodeId ?? ROOT);
      state.activeTab = "inspector";
      state.changeKindFilter = null;
      updateTabUI();
      render();
    });
  });
}
