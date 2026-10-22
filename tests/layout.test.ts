import { describe, expect, it } from "bun:test";
import type { MindmapDocument, MindmapNode, NodeId } from "../src/model/schema.js";
import { GRID_MIN, layoutTree, type Layout, type ViewMode } from "../viewer/layout.js";
import { addChild, emptyDoc } from "./fixtures.js";

/** Cards of two heights, so grid rows have to size to their tallest card. */
const sizeOf = (node: MindmapNode) => ({ w: 235, h: node.label.endsWith("!") ? 110 : 60 });

function layout(doc: MindmapDocument, mode: ViewMode = "all"): Layout {
  const result = layoutTree(doc, mode, sizeOf);
  if (!result) throw new Error("no root");
  return result;
}

function box(l: Layout, id: NodeId) {
  const p = l.positions.get(id);
  if (!p) throw new Error(`${id} not laid out`);
  return { left: p.x, right: p.x + p.w, top: p.y - p.h / 2, bottom: p.y + p.h / 2 };
}

function expectNoOverlaps(l: Layout) {
  const boxes = [...l.positions.keys()].map((id) => ({ id, ...box(l, id) }));
  for (const a of boxes) {
    for (const b of boxes) {
      if (a.id >= b.id) continue;
      const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      expect(overlap ? `${a.id} overlaps ${b.id}` : "").toBe("");
    }
  }
}

function tasks(doc: MindmapDocument, n: number, parent?: NodeId) {
  return Array.from({ length: n }, (_, i) => addChild(doc, { type: "task", label: i % 3 === 1 ? `Step ${i}!` : `Step ${i}`, parent }).id);
}

describe("viewer layout", () => {
  it("keeps a short plan in one column", () => {
    const doc = emptyDoc();
    const ids = tasks(doc, GRID_MIN - 1);
    const l = layout(doc);
    expect(l.grids).toEqual([]);
    expect(new Set(ids.map((id) => box(l, id).left)).size).toBe(1);
    expectNoOverlaps(l);
  });

  it("wraps a long flat plan into rows, in reading order, inside one frame", () => {
    const doc = emptyDoc();
    const ids = tasks(doc, 13);
    const l = layout(doc);
    expect(l.grids).toHaveLength(1);
    const grid = l.grids[0];
    if (!grid) throw new Error("no grid");
    expect(grid.members).toEqual(ids);

    // Left to right, then top to bottom.
    const [first, second] = ids.map((id) => box(l, id));
    expect(second?.left).toBeGreaterThan(first?.right ?? Infinity);
    const rows = new Set(ids.map((id) => l.positions.get(id)?.y));
    expect(rows.size).toBeLessThan(ids.length);
    expect(rows.size).toBeGreaterThan(1);

    for (const id of ids) {
      const b = box(l, id);
      expect(b.left).toBeGreaterThanOrEqual(grid.x);
      expect(b.right).toBeLessThanOrEqual(grid.x + grid.w);
      expect(b.top).toBeGreaterThanOrEqual(grid.y);
      expect(b.bottom).toBeLessThanOrEqual(grid.y + grid.h);
    }
    expectNoOverlaps(l);
  });

  it("puts the plan before the mental model in split view", () => {
    const doc = emptyDoc();
    const before = tasks(doc, 2);
    const component = addChild(doc, { type: "component", label: "Store" }).id;
    addChild(doc, { type: "risk", label: "Races", parent: component });
    const after = tasks(doc, 2);
    const l = layout(doc);
    for (const id of [...before, ...after]) expect(box(l, id).bottom).toBeLessThan(box(l, component).top);
    expectNoOverlaps(l);
  });

  it("only wraps runs of leaves, so a task with children splits the run", () => {
    const doc = emptyDoc();
    const head = tasks(doc, GRID_MIN);
    const parent = addChild(doc, { type: "task", label: "Has subtasks" }).id;
    tasks(doc, 2, parent);
    const tail = tasks(doc, GRID_MIN);
    const l = layout(doc);
    expect(l.grids.map((g) => g.members)).toEqual([head, tail]);
    expectNoOverlaps(l);
  });

  it("wraps long runs at any depth and in each view", () => {
    const doc = emptyDoc();
    const component = addChild(doc, { type: "component", label: "Viewer" }).id;
    const concepts = Array.from({ length: 8 }, (_, i) => addChild(doc, { type: "decision", label: `D${i}`, parent: component }).id);
    const plan = tasks(doc, 3);

    const hld = layout(doc, "hld");
    expect(hld.grids.map((g) => g.members)).toEqual([concepts]);
    for (const id of plan) expect(hld.positions.has(id)).toBe(false);
    expectNoOverlaps(hld);

    const planView = layout(doc, "plan");
    expect(planView.grids).toEqual([]);
    expect(planView.positions.has(component)).toBe(false);
    expectNoOverlaps(layout(doc));
  });
});
