/**
 * Where flow links run on the canvas: curves that stay in the gaps between cards, and label pills that
 * don't cover each other. Pure, so it is unit-tested without a DOM. Coordinates are the layout's.
 */

import type { MindmapLink, NodeId } from "../src/model/schema.js";
import type { Box } from "./camera.js";
import type { NodeBox } from "./layout.js";

/** A quadratic curve and the pill that carries its label. */
export interface RoutedLink {
  link: MindmapLink;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  x2: number;
  y2: number;
  label: string;
  pill: Box;
}

const PILL_H = 18;
const PILL_GAP = 4;
const MAX_LABEL = 24;
/** Links between the same two cards fan out by this much, so none hides another. */
const PARALLEL_SPREAD = 28;
const SAME_COLUMN = 20;
const SAME_ROW = 20;
const GUTTER = 70;
/** A gutter label's distance from the column, so that it stays in the gap beside it. */
const GUTTER_PILL_INSET = 4;
const ARC_HEIGHT = 28;
/** A label gives up looking for a clear spot after this many steps and stays on its line. */
const MAX_NUDGES = 12;

export function pillLabel(label: string): string {
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

const pillWidth = (label: string) => Math.max(54, label.length * 6.2 + 14);

/**
 * The curve between two cards, and where along it the label sits. `spread` fans out parallel links either
 * side of the straight line, and `stack` lifts them above each other where a curve can only go one way.
 */
function curve(from: NodeBox, to: NodeBox, spread: number, stack: number) {
  if (from === to) {
    // A card linked to itself: a small loop off its right side.
    const x = from.x + from.w;
    const y1 = from.y - from.h / 4;
    const y2 = from.y + from.h / 4;
    return { x1: x, y1, cx: x + GUTTER + stack, cy: from.y, x2: x, y2, mx: x + GUTTER_PILL_INSET, my: from.y, inGutter: true };
  }
  const sameColumn = Math.abs(from.x - to.x) < SAME_COLUMN;
  const gap = Math.abs(to.y - from.y);

  if (sameColumn && gap > (from.h + to.h) / 2 + 45) {
    // Past the cards between them: along the column's right gutter.
    const x1 = from.x + from.w;
    const x2 = to.x + to.w;
    const cx = x1 + GUTTER + spread;
    const cy = (from.y + to.y) / 2;
    return { x1, y1: from.y, cx, cy, x2, y2: to.y, mx: x1 + GUTTER_PILL_INSET, my: cy, inGutter: true };
  }
  if (gap < SAME_ROW) {
    // Side by side (e.g. in a grid row): arc over their tops, in the gap above the row.
    const x1 = from.x + from.w / 2;
    const y1 = from.y - from.h / 2;
    const x2 = to.x + to.w / 2;
    const y2 = to.y - to.h / 2;
    const cx = (x1 + x2) / 2;
    const cy = Math.min(y1, y2) - ARC_HEIGHT - stack;
    return { x1, y1, cx, cy, x2, y2, mx: cx, my: 0.25 * y1 + 0.5 * cy + 0.25 * y2, inGutter: false };
  }
  if (sameColumn) {
    // Neighbours in a column: bottom of one to the top of the other.
    const goingDown = to.y >= from.y;
    const x1 = from.x + from.w / 2;
    const y1 = from.y + (goingDown ? from.h / 2 : -from.h / 2);
    const x2 = to.x + to.w / 2;
    const y2 = to.y + (goingDown ? -to.h / 2 : to.h / 2);
    const cx = x1 + spread;
    const cy = (y1 + y2) / 2;
    return { x1, y1, cx, cy, x2, y2, mx: cx, my: cy, inGutter: false };
  }
  // Across columns: from the side of one card to the facing side of the other, through the gap between them.
  const rightward = to.x > from.x;
  const x1 = rightward ? from.x + from.w : from.x;
  const x2 = rightward ? to.x : to.x + to.w;
  const cx = (x1 + x2) / 2;
  const cy = (from.y + to.y) / 2 + spread;
  return { x1, y1: from.y, cx, cy, x2, y2: to.y, mx: cx, my: 0.25 * from.y + 0.5 * cy + 0.25 * to.y, inGutter: false };
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Route every link with both ends drawn in this view. */
export function routeLinks(links: readonly MindmapLink[], positions: ReadonlyMap<NodeId, NodeBox>): RoutedLink[] {
  const pairKey = (l: MindmapLink) => [l.from, l.to].sort().join(" ");
  const drawn = links.filter((l) => positions.has(l.from) && positions.has(l.to));
  const pairSize = new Map<string, number>();
  for (const l of drawn) pairSize.set(pairKey(l), (pairSize.get(pairKey(l)) ?? 0) + 1);

  const seen = new Map<string, number>();
  const cards = [...positions.values()].map((p): Box => ({ x: p.x, y: p.y - p.h / 2, w: p.w, h: p.h }));
  const placed: Box[] = [];
  return drawn.flatMap((link) => {
    const from = positions.get(link.from);
    const to = positions.get(link.to);
    if (!from || !to) return [];
    const key = pairKey(link);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const spread = (index - ((pairSize.get(key) ?? 1) - 1) / 2) * PARALLEL_SPREAD;

    const { mx, my, inGutter, ...points } = curve(from, to, spread, index * PARALLEL_SPREAD);
    const label = pillLabel(link.label);
    const w = pillWidth(label);
    const pill = { x: inGutter ? mx : mx - w / 2, y: my - PILL_H / 2, w, h: PILL_H };
    // A label can land on another label or on a card it would hide, so it moves down to the next clear spot.
    const clear = (y: number) => ![...placed, ...cards].some((box) => overlaps({ ...pill, y }, box));
    const steps = Array.from({ length: MAX_NUDGES }, (_, i) => pill.y + i * (PILL_H + PILL_GAP));
    pill.y = steps.find(clear) ?? pill.y;
    placed.push(pill);
    return [{ link, ...points, label, pill }];
  });
}

/** The box around a route: a quadratic curve stays inside the triangle of its three points. */
export function routeBounds({ x1, y1, cx, cy, x2, y2, pill }: RoutedLink): Box {
  const x = Math.min(x1, cx, x2, pill.x);
  const y = Math.min(y1, cy, y2, pill.y);
  return { x, y, w: Math.max(x1, cx, x2, pill.x + pill.w) - x, h: Math.max(y1, cy, y2, pill.y + pill.h) - y };
}
