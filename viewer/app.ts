import { isChangeKind, isConceptType, isTask, type ChangeKind, type FileAction, type NodeType, type TaskStatus } from "../src/model/kinds.js";
import type { CodeChange, FileTouch, MindmapDocument, MindmapListItem, MindmapNode, NodeId } from "../src/model/schema.js";

type ViewMode = "all" | "plan" | "hld";
type SidebarTab = "inspector" | "files" | "activity";

/** The well-known root id (schema.ts's ROOT_ID can't be imported: it would bundle zod). */
const ROOT = "root" as NodeId;

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

interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
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

function byId<T extends Element = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as Element as T;
}

function query<T extends Element = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
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

const STATUS_COLORS: Record<TaskStatus, string> = {
  planned: "#6e6e73",
  in_progress: "#007aff",
  completed: "#15803d",
  blocked: "#dc2626",
};

const TYPE_BADGES: Partial<Record<NodeType, string>> = {
  component: "📦 Component",
  data_flow: "⇄ Data Flow",
  hypothesis: "💡 Hypothesis",
  decision: "⚖️ Decision",
  risk: "⚠️ Risk",
};

const TYPE_COLORS: Partial<Record<NodeType, string>> = {
  component: "#4338ca",
  data_flow: "#0f766e",
  hypothesis: "#b45309",
  decision: "#6d28d9",
  risk: "#be123c",
};

// Symbol-level change kinds (order = display order). Colors mirror the .kind-* CSS classes.
const CHANGE_KINDS: Record<ChangeKind, { glyph: string; label: string; color: string }> = {
  add: { glyph: "+", label: "Added", color: "#15803d" },
  modify: { glyph: "~", label: "Modified", color: "#1d4ed8" },
  fix: { glyph: "✱", label: "Fixed", color: "#c2410c" },
  refactor: { glyph: "⟲", label: "Refactored", color: "#7c3aed" },
  rename: { glyph: "↦", label: "Renamed", color: "#0f766e" },
  remove: { glyph: "−", label: "Removed", color: "#b91c1c" },
  test: { glyph: "✓", label: "Tested", color: "#0369a1" },
};
const KIND_ORDER = Object.keys(CHANGE_KINDS) as ChangeKind[];

const ACTION_COLORS: Record<FileAction, string> = {
  read: "#9ca3af",
  create: "#15803d",
  modify: "#1d4ed8",
  delete: "#b91c1c",
  rename: "#0f766e",
};

let currentId = decodeURIComponent(location.hash.slice(1));
let currentDoc: MindmapDocument | null = null;
/** Plain string: it also comes from DOM data attributes; resolve it with nodeById. */
let selectedNodeId: string = ROOT;
let highlightedFilePath: string | null = null;
let changeKindFilter: ChangeKind | null = null;
let activeTab: SidebarTab = "inspector";
let viewMode: ViewMode = "all";
let sessions: MindmapListItem[] = [];
let sessionQuery = "";

/** Looks up a node by an untrusted id (URL, DOM attribute). */
function nodeById(doc: MindmapDocument, id: string): MindmapNode | undefined {
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
    .map(([k, n]) => `<tspan fill="${CHANGE_KINDS[k].color}" font-weight="700">${CHANGE_KINDS[k].glyph}${n} </tspan>`)
    .join("");
}

function tallyHtml(changes: readonly CodeChange[]) {
  return tallyChanges(changes)
    .map(([k, n]) => `<span class="kind-tally kind-${k}" title="${CHANGE_KINDS[k].label}">${CHANGE_KINDS[k].glyph}${n}</span>`)
    .join("");
}

function changeRowHtml(c: CodeChange, via?: string) {
  const k = kindOf(c);
  const name = c.kind === "rename" ? `${c.previousSymbol} → ${c.symbol}` : c.symbol;
  return `
    <div class="change-row kind-${k}">
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
        <span class="action-badge ${escXml(action)}">${escXml(action)}</span>
        <span>${filePathHtml(f)}</span>
      </div>
      ${f.summary ? `<div class="file-summary">${escXml(f.summary)}</div>` : ""}
      ${changes.length ? `<div class="change-list">${changes.map((c) => changeRowHtml(c, c.via && c.via.join(", "))).join("")}</div>` : ""}
      ${!changes.length && f.symbols && f.symbols.length ? `<div class="file-meta">Symbols: <code>${escXml(f.symbols.join(", "))}</code></div>` : ""}
      ${meta}
    </div>`;
}

function isHldBranchNode(doc: MindmapDocument, node: MindmapNode) {
  let cur: MindmapNode | undefined = node;
  while (cur) {
    if (isConceptType(cur.type)) return true;
    cur = cur.parent === null ? undefined : doc.nodes[cur.parent];
  }
  return false;
}

function shouldShowNodeInView(doc: MindmapDocument, node: MindmapNode) {
  if (node.type === "root" || viewMode === "all") return true;
  const isHld = isHldBranchNode(doc, node);
  return viewMode === "hld" ? isHld : !isHld;
}

function visibleChildren(doc: MindmapDocument, node: MindmapNode): MindmapNode[] {
  return node.children.flatMap((cid) => {
    const child = doc.nodes[cid];
    return child && shouldShowNodeInView(doc, child) ? [child] : [];
  });
}

// ── Calculate Dynamic Node Dimensions & Non-Overlapping Tree Layout ──
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

function layoutTree(doc: MindmapDocument) {
  const root = doc.nodes[ROOT];
  if (!root) return null;

  const LEVEL_GAP = 105;
  const SIBLING_GAP = 34;
  const measured = new Map<NodeId, { size: { w: number; h: number }; subtreeH: number; children: MindmapNode[] }>();

  function measure(node: MindmapNode): number {
    const size = getNodeSize(node);
    const children = visibleChildren(doc, node);
    let totalChildrenH = 0;
    children.forEach((child, i) => {
      totalChildrenH += measure(child);
      if (i > 0) totalChildrenH += SIBLING_GAP;
    });
    const subtreeH = Math.max(size.h, totalChildrenH);
    measured.set(node.id, { size, subtreeH, children });
    return subtreeH;
  }

  const rootH = measure(root);

  const positions = new Map<NodeId, NodeBox>();
  function assign(node: MindmapNode, x: number, centerY: number, depth: number) {
    const m = measured.get(node.id);
    if (!m) return;
    const { size, children } = m;
    positions.set(node.id, { x, y: centerY, w: size.w, h: size.h, depth });
    if (children.length === 0) return;

    const heights = children.map((child) => measured.get(child.id)?.subtreeH ?? 0);
    const totalChildrenH = heights.reduce((sum, h) => sum + h, 0) + SIBLING_GAP * (children.length - 1);

    let cursorY = centerY - totalChildrenH / 2;
    children.forEach((child, i) => {
      const chH = heights[i] ?? 0;
      assign(child, x + size.w + LEVEL_GAP, cursorY + chH / 2, depth + 1);
      cursorY += chH + SIBLING_GAP;
    });
  }

  assign(root, 60, Math.max(300, rootH / 2 + 40), 0);
  return positions;
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

// ── Render SVG Mindmap & HLD Flow Links ─────────────────────────────────
function render(doc: MindmapDocument | null) {
  const svg = svgEl;
  const empty = byId("empty-state");

  updateHeaderProgress(doc);
  renderSidebar(doc);

  if (!doc || !doc.nodes[ROOT]) {
    svg.innerHTML = "";
    empty.style.display = "flex";
    return;
  }
  empty.style.display = "none";

  const nodes = doc.nodes;
  const positions = layoutTree(doc);
  if (!positions) {
    svg.innerHTML = "";
    return;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + p.w);
    minY = Math.min(minY, p.y - p.h / 2);
    maxY = Math.max(maxY, p.y + p.h / 2);
  }

  const PAD = 80;
  const W = Math.max(850, maxX - minX + PAD * 2);
  const H = Math.max(520, maxY - minY + PAD * 2);
  const OFX = PAD - minX;
  const OFY = PAD - minY;

  let edges = "";
  let flowLinksSvg = "";
  let nodeEls = "";

  for (const [id, p] of positions) {
    const node = nodes[id];
    if (!node) continue;
    const px = p.x + OFX;
    const py = p.y + OFY;

    // Draw cubic bezier tree edges to children
    for (const cid of node.children) {
      const cp = positions.get(cid);
      if (!cp) continue;
      const cpx = cp.x + OFX;
      const cpy = cp.y + OFY;
      const childNode = nodes[cid];
      const childStatus = childNode && isTask(childNode) ? childNode.status : undefined;
      const mx = (px + p.w + cpx) / 2;
      let edgeCls = "edge";
      if (childStatus === "in_progress") edgeCls += " edge-active";
      else if (childStatus === "completed") edgeCls += " edge-completed";
      edges += `<path class="${edgeCls}" d="M${px + p.w},${py} C${mx},${py} ${mx},${cpy} ${cpx},${cpy}"/>`;
    }

    // Determine node classes
    const classes = ["node-group"];
    if (node.type === "root") classes.push("root");
    classes.push(`type-${node.type}`);
    if (isTask(node)) classes.push(`status-${node.status}`);
    if (id === selectedNodeId) classes.push("selected");
    if (
      (highlightedFilePath && node.files.some((f) => f.path === highlightedFilePath)) ||
      (changeKindFilter && nodeChanges(node).some((c) => kindOf(c) === changeKindFilter))
    ) {
      classes.push("file-highlighted");
    }

    const topY = py - p.h / 2;
    let cursorY = topY + 20;

    let innerContent = `
      <text class="node-title" x="${px + 12}" y="${cursorY}">${escXml(truncate(node.label, 30))}</text>
    `;

    // Status (tasks only) or Semantic Thinking Type row
    const typeLabel = TYPE_BADGES[node.type];
    const stLabel = isTask(node) ? STATUS_LABELS[node.status] : "";
    if (node.type !== "root" && (typeLabel || stLabel)) {
      cursorY += 16;
      const combined = [typeLabel, stLabel].filter(Boolean).join("  ·  ");
      const pillColor = TYPE_COLORS[node.type] || (isTask(node) ? STATUS_COLORS[node.status] : "") || "#6e6e73";
      innerContent += `<text class="node-status-pill" fill="${pillColor}" x="${px + 12}" y="${cursorY}">${escXml(combined)}</text>`;
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
      const color = ACTION_COLORS[action] || ACTION_COLORS.modify;
      innerContent += `
        <rect class="node-file-chip" style="stroke:${color}" x="${px + 10}" y="${cursorY - 12}" width="${p.w - 20}" height="16"/>
        <text class="node-file-text" x="${px + 15}" y="${cursorY - 1}"><tspan fill="${color}" font-weight="700">${escXml(action.charAt(0).toUpperCase())}</tspan> ${escXml(truncate(shownName + extraCount, Math.max(10, 31 - tallyLen)))} ${tallySvg(changes)}</text>
      `;
    });

    nodeEls += `
      <g class="${classes.join(" ")}" data-node-id="${escXml(id)}">
        <rect class="node-rect" x="${px}" y="${topY}" width="${p.w}" height="${p.h}"/>
        ${innerContent}
      </g>`;
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
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#6366f1"/>
        </marker>
      </defs>
      ${edges}
      ${nodeEls}
      ${flowLinksSvg}
    </svg>`;

  applyTransform();

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
          <span class="type-tag ${escXml(node.type)}">${escXml(TYPE_BADGES[node.type] || node.type)}</span>
          ${isTask(node) ? `<span class="status-tag ${escXml(node.status)}">${escXml(node.status.replace("_", " "))}</span>` : ""}
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

    container.querySelectorAll<HTMLElement>(".link-item").forEach((el) => {
      el.addEventListener("click", () => {
        selectedNodeId = el.dataset.jumpNode ?? ROOT;
        render(currentDoc);
      });
    });
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
          `<button class="kind-filter kind-${k} ${changeKindFilter === k ? "active" : ""}" data-kind="${k}">${CHANGE_KINDS[k].glyph} ${CHANGE_KINDS[k].label} ${n}</button>`
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
      });
    });
  } else if (activeTab === "activity") {
    const log = doc.activityLog;
    if (log.length === 0) {
      container.innerHTML = `<div style="color:var(--muted);font-size:12.5px;">No activity recorded yet.</div>`;
      return;
    }
    container.innerHTML = log
      .map(
        (entry) => `
      <div class="activity-item">
        <div class="activity-time">${new Date(entry.timestamp).toLocaleTimeString()}</div>
        <div>${escXml(entry.message)}</div>
      </div>`
      )
      .join("");
  }

  container.querySelectorAll<HTMLElement>(".file-item").forEach((el) => {
    el.addEventListener("click", () => {
      const fp = el.dataset.filePath ?? null;
      highlightedFilePath = highlightedFilePath === fp ? null : fp;
      render(currentDoc);
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
    activeTab = btn.dataset.tab as SidebarTab;
    if (activeTab !== "files") changeKindFilter = null;
    updateTabUI();
    render(currentDoc);
  });
});

// View Mode Switcher (Split / Plan / HLD)
document.querySelectorAll<HTMLElement>("#view-switcher button").forEach((btn) => {
  btn.addEventListener("click", () => {
    viewMode = btn.dataset.mode as ViewMode;
    document.querySelectorAll<HTMLElement>("#view-switcher button").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === viewMode)
    );
    render(currentDoc);
  });
});

// ── Pan & Zoom ──────────────────────────────────────────────────
const viewport = byId("viewport");
const svgEl = byId<SVGSVGElement>("svg");

let scale = 1;
let tx = 0, ty = 0;
let panning = false, startX = 0, startY = 0, startTx = 0, startTy = 0;

function applyTransform() {
  const inner = svgEl.querySelector("svg");
  if (!inner) return;
  inner.setAttribute("transform", `translate(${tx}, ${ty}) scale(${scale})`);
  inner.style.transformOrigin = "0 0";
}

byId("zoom-in").onclick = () => { scale = Math.min(4, scale * 1.2); applyTransform(); };
byId("zoom-out").onclick = () => { scale = Math.max(0.2, scale / 1.2); applyTransform(); };
byId("zoom-reset").onclick = () => { scale = 1; tx = 0; ty = 0; applyTransform(); };

// The canvas fits the tree into #svg, so end #svg above the bottom overlays (legend, zoom
// controls); panned content still shows beneath them because #svg doesn't clip.
const bottomOverlays = [query(".legend"), query(".controls")];
const fitAboveOverlays = () => {
  const top = Math.min(...bottomOverlays.map((el) => el.offsetTop));
  svgEl.style.height = `${Math.max(0, top - 8)}px`;
};
const overlayObserver = new ResizeObserver(fitAboveOverlays);
[viewport, ...bottomOverlays].forEach((el) => overlayObserver.observe(el));

viewport.addEventListener("mousedown", (e) => {
  if (e.target instanceof Element && (e.target.closest(".node-group") || e.target.closest(".controls"))) return;
  panning = true;
  startX = e.clientX; startY = e.clientY;
  startTx = tx; startTy = ty;
});
window.addEventListener("mousemove", (e) => {
  if (!panning) return;
  tx = startTx + (e.clientX - startX);
  ty = startTy + (e.clientY - startY);
  applyTransform();
});
window.addEventListener("mouseup", () => { panning = false; });

viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.92 : 1.08;
  scale = Math.max(0.2, Math.min(4, scale * delta));
  applyTransform();
}, { passive: false });

// ── Load & Refresh Mindmaps ─────────────────────────────────────
function loadMindmap(doc: MindmapDocument) {
  currentDoc = doc;
  currentId = doc.id;
  if (!nodeById(doc, selectedNodeId)) selectedNodeId = ROOT;
  render(doc);
}

async function fetchMindmapById(id: string) {
  if (!id) return;
  const res = await fetch(`/api/mindmaps/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.ok) {
    const doc: MindmapDocument = await res.json();
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
      <div class="session-title">${live ? `<span class="session-live-dot" title="Updated in the last 2 minutes"></span>` : ""}<span class="session-title-text">${escXml(s.title)}</span>
        <button class="session-action" data-action="${action}" title="${s.archivedAt ? "Restore this session" : "Archive this session"}">${s.archivedAt ? "Restore" : "Archive"}</button>
      </div>
      <div class="session-sub">${escXml(timeAgo(s.updatedAt))}</div>
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
    if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`);
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

async function selectSession(id: string | undefined) {
  if (!id || id === currentId) return;
  currentId = id;
  history.replaceState(null, "", `#${encodeURIComponent(id)}`);
  selectedNodeId = ROOT;
  highlightedFilePath = null;
  changeKindFilter = null;
  scale = 1; tx = 0; ty = 0;
  renderSessions();
  document.querySelector(".session-item.active")?.scrollIntoView({ block: "nearest" });
  await fetchMindmapById(id);
}

async function refreshSessions() {
  try {
    const res = await fetch("/api/mindmaps", { cache: "no-store" });
    if (!res.ok) return;
    sessions = await res.json();
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
    if (first) await selectSession(first.id);
  }
}

const sessionSearch = byId<HTMLInputElement>("session-search");
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

if (localStorage.getItem("synapse.sessionsCollapsed") === "1") document.body.classList.add("sessions-collapsed");
byId("sessions-toggle").onclick = () => {
  const collapsed = document.body.classList.toggle("sessions-collapsed");
  localStorage.setItem("synapse.sessionsCollapsed", collapsed ? "1" : "0");
};

setInterval(renderSessions, 30000); // keep "x m ago" and live dots fresh

byId("legend-kinds").innerHTML = Object.entries(CHANGE_KINDS)
  .map(([k, m]) => `<span class="kind-tally kind-${k}" title="${m.label}">${m.glyph} ${k}</span>`)
  .join("");

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
    const data: SyncGitResponse = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (data.mindmap) loadMindmap(data.mindmap);
  } catch (err) {
    alert("Git sync failed: " + errorMessage(err));
  }
};

// File upload
const fileUpload = byId<HTMLInputElement>("file-upload");
byId("upload-btn").onclick = () => {
  fileUpload.click();
};
fileUpload.onchange = async () => {
  const file = fileUpload.files?.[0];
  if (!file) return;
  const text = await file.text();
  try {
    loadMindmap(JSON.parse(text));
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
      const payload: ViewerEvent = JSON.parse(event.data);
      if (payload.type === "mindmap_updated") {
        // Refresh the session list, but only reload the canvas for the session being viewed.
        await refreshSessions();
        if (!currentId && payload.id) await selectSession(payload.id);
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
