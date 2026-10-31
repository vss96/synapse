/**
 * Tree layout for the canvas: places every card shown in a view, left to right by depth. Pure (the
 * card size comes from the caller), so it is unit-tested without a DOM.
 */

import { isConceptType } from "../src/model/kinds.js";
import type { MindmapDocument, MindmapNode, NodeId } from "../src/model/schema.js";
import type { Box, Size } from "./camera.js";

export const VIEW_MODES = ["all", "plan", "hld"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/** The well-known root id (schema.ts's ROOT_ID can't be imported: it would bundle zod). */
export const ROOT = "root" as NodeId;

/** A card's place: `x` is its left edge and `y` its vertical center, in scene coordinates. */
export interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

/** A run of leaf siblings wrapped into rows; the frame is the box, and one edge leads to it from `parent`. */
export interface Grid extends Box {
  parent: NodeId;
  /** In reading order: left to right, then top to bottom. */
  members: NodeId[];
}

export interface Layout {
  positions: Map<NodeId, NodeBox>;
  grids: Grid[];
}

const LEVEL_GAP = 105;
const SIBLING_GAP = 34;
/** A run of at least this many leaf siblings wraps into a grid instead of one tall column. */
export const GRID_MIN = 7;
const GRID_ROWS = 5;
const GRID_MAX_COLS = 4;
const GRID_GAP = 24;
/** Space between a grid's frame and its cards. */
const GRID_PAD = 14;

/** The nodes above `node`, starting at the root. */
export function ancestors(doc: MindmapDocument, node: MindmapNode): MindmapNode[] {
  const path: MindmapNode[] = [];
  for (let cur = node.parent === null ? undefined : doc.nodes[node.parent]; cur; cur = cur.parent === null ? undefined : doc.nodes[cur.parent]) {
    path.unshift(cur);
  }
  return path;
}

/** `node` and everything below it. */
export function subtree(doc: MindmapDocument, node: MindmapNode): MindmapNode[] {
  return [node, ...node.children.flatMap((id) => {
    const child = doc.nodes[id];
    return child ? subtree(doc, child) : [];
  })];
}

function isHldBranchNode(doc: MindmapDocument, node: MindmapNode) {
  let cur: MindmapNode | undefined = node;
  while (cur) {
    if (isConceptType(cur.type)) return true;
    cur = cur.parent === null ? undefined : doc.nodes[cur.parent];
  }
  return false;
}

function shouldShowNodeInView(doc: MindmapDocument, node: MindmapNode, mode: ViewMode) {
  if (node.type === "root" || mode === "all") return true;
  const isHld = isHldBranchNode(doc, node);
  return mode === "hld" ? isHld : !isHld;
}

/** The children shown in this view, plan before HLD so the mental model doesn't split the plan. */
function visibleChildren(doc: MindmapDocument, node: MindmapNode, mode: ViewMode): MindmapNode[] {
  const shown = node.children.flatMap((cid) => {
    const child = doc.nodes[cid];
    return child && shouldShowNodeInView(doc, child, mode) ? [child] : [];
  });
  return [...shown.filter((c) => !isHldBranchNode(doc, c)), ...shown.filter((c) => isHldBranchNode(doc, c))];
}

type Block =
  | { kind: "node"; node: MindmapNode; h: number }
  | { kind: "grid"; members: MindmapNode[]; cols: number; colW: number; rowH: number[]; w: number; h: number };

function gridBlock(members: MindmapNode[], sizes: Map<NodeId, Size>): Block {
  const cols = Math.min(GRID_MAX_COLS, Math.ceil(members.length / GRID_ROWS));
  const size = (n: MindmapNode) => sizes.get(n.id) ?? { w: 0, h: 0 };
  const colW = Math.max(...members.map((n) => size(n).w));
  const rowH: number[] = [];
  members.forEach((n, i) => {
    const r = Math.floor(i / cols);
    rowH[r] = Math.max(rowH[r] ?? 0, size(n).h);
  });
  const w = cols * colW + (cols - 1) * GRID_GAP + 2 * GRID_PAD;
  const h = rowH.reduce((sum, rh) => sum + rh, 0) + (rowH.length - 1) * GRID_GAP + 2 * GRID_PAD;
  return { kind: "grid", members, cols, colW, rowH, w, h };
}

export function layoutTree(doc: MindmapDocument, mode: ViewMode, sizeOf: (node: MindmapNode) => Size): Layout | null {
  const root = doc.nodes[ROOT];
  if (!root) return null;

  const sizes = new Map<NodeId, Size>();
  const measured = new Map<NodeId, { size: Size; subtreeH: number; blocks: Block[] }>();

  function measure(node: MindmapNode): number {
    const size = sizeOf(node);
    sizes.set(node.id, size);
    const children = visibleChildren(doc, node, mode);
    const subtreeHs = new Map(children.map((child) => [child.id, measure(child)]));
    const isLeaf = (child: MindmapNode) => measured.get(child.id)?.blocks.length === 0;

    // Consecutive leaves of the same branch (plan or HLD) form a run; long runs become grids.
    const blocks: Block[] = [];
    let run: MindmapNode[] = [];
    const flush = () => {
      if (run.length >= GRID_MIN) blocks.push(gridBlock(run, sizes));
      else blocks.push(...run.map((n): Block => ({ kind: "node", node: n, h: subtreeHs.get(n.id) ?? 0 })));
      run = [];
    };
    for (const child of children) {
      const first = run[0];
      if (first && (!isLeaf(child) || isHldBranchNode(doc, first) !== isHldBranchNode(doc, child))) flush();
      if (isLeaf(child)) run.push(child);
      else blocks.push({ kind: "node", node: child, h: subtreeHs.get(child.id) ?? 0 });
    }
    flush();

    const blocksH = blocks.reduce((sum, b) => sum + b.h, 0) + SIBLING_GAP * Math.max(0, blocks.length - 1);
    const subtreeH = Math.max(size.h, blocksH);
    measured.set(node.id, { size, subtreeH, blocks });
    return subtreeH;
  }

  const rootH = measure(root);

  const positions = new Map<NodeId, NodeBox>();
  const grids: Grid[] = [];
  function assign(node: MindmapNode, x: number, centerY: number, depth: number) {
    const m = measured.get(node.id);
    if (!m) return;
    const { size, blocks } = m;
    positions.set(node.id, { x, y: centerY, w: size.w, h: size.h, depth });
    if (blocks.length === 0) return;

    const childX = x + size.w + LEVEL_GAP;
    const totalH = blocks.reduce((sum, b) => sum + b.h, 0) + SIBLING_GAP * (blocks.length - 1);
    let cursorY = centerY - totalH / 2;
    for (const block of blocks) {
      if (block.kind === "node") {
        assign(block.node, childX, cursorY + block.h / 2, depth + 1);
      } else {
        // The frame reaches into the gap on the left, so grid cards line up with their siblings.
        grids.push({ parent: node.id, members: block.members.map((n) => n.id), x: childX - GRID_PAD, y: cursorY, w: block.w, h: block.h });
        let rowTop = cursorY + GRID_PAD;
        block.rowH.forEach((rh, r) => {
          block.members.slice(r * block.cols, (r + 1) * block.cols).forEach((n, c) => {
            const s = sizes.get(n.id) ?? { w: 0, h: 0 };
            positions.set(n.id, { x: childX + c * (block.colW + GRID_GAP), y: rowTop + rh / 2, w: s.w, h: s.h, depth: depth + 1 });
          });
          rowTop += rh + GRID_GAP;
        });
      }
      cursorY += block.h + SIBLING_GAP;
    }
  }

  assign(root, 60, Math.max(300, rootH / 2 + 40), 0);
  return { positions, grids };
}
