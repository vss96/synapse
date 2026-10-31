import { describe, expect, it } from "bun:test";
import { LinkId, ROOT_ID, type MindmapDocument, type MindmapNode, type NodeId } from "../src/model/schema.js";
import { GRID_MIN, ancestors, finishedBranches, layoutTree, subtree, type Layout, type ViewMode } from "../viewer/layout.js";
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

  describe("views", () => {
    it("shows a concept recorded under a task in the HLD view, with the path that leads to it", () => {
      const doc = emptyDoc();
      const phase = addChild(doc, { type: "plan", label: "Phase" });
      const done = addChild(doc, { type: "task", label: "Sibling task", parent: phase.id });
      const hypothesis = addChild(doc, { type: "hypothesis", label: "TTL drift", parent: phase.id });

      const hld = layout(doc, "hld");
      expect(hld.positions.has(hypothesis.id)).toBe(true);
      expect(hld.positions.has(phase.id)).toBe(true);
      expect(hld.positions.has(done.id)).toBe(false);
      expect([...hld.context]).toEqual([phase.id]);

      const plan = layout(doc, "plan");
      expect(plan.positions.has(hypothesis.id)).toBe(false);
      expect(plan.context.size).toBe(0);
    });

    it("keeps a task nested in a component in the plan, and in the HLD branch it sits on", () => {
      const doc = emptyDoc();
      const component = addChild(doc, { type: "component", label: "Gateway" });
      const task = addChild(doc, { type: "task", label: "Audit it", parent: component.id });
      const risk = addChild(doc, { type: "risk", label: "Skew", parent: component.id });

      const plan = layout(doc, "plan");
      expect(plan.positions.has(task.id)).toBe(true);
      expect(plan.positions.has(risk.id)).toBe(false);
      expect([...plan.context]).toEqual([component.id]);
      expect(layout(doc, "hld").positions.has(task.id)).toBe(true);
    });

    it("keeps notes and files with what they annotate", () => {
      const doc = emptyDoc();
      const component = addChild(doc, { type: "component", label: "Gateway" });
      const note = addChild(doc, { type: "note", label: "About it", parent: component.id });
      const task = addChild(doc, { type: "task", label: "Task" });
      const file = addChild(doc, { type: "file", label: "a.ts", parent: task.id });

      expect(layout(doc, "plan").positions.has(note.id)).toBe(false);
      expect(layout(doc, "hld").positions.has(note.id)).toBe(true);
      expect(layout(doc, "plan").positions.has(file.id)).toBe(true);
      expect(layout(doc, "hld").positions.has(file.id)).toBe(false);
    });

    it("draws every node in at least one of the two views", () => {
      const doc = emptyDoc();
      const a = addChild(doc, { type: "plan", label: "A" });
      const b = addChild(doc, { type: "decision", label: "B", parent: a.id });
      const c = addChild(doc, { type: "task", label: "C", parent: b.id });
      const d = addChild(doc, { type: "note", label: "D", parent: c.id });
      const shown = new Set([...layout(doc, "plan").positions.keys(), ...layout(doc, "hld").positions.keys()]);
      for (const n of [a, b, c, d]) expect(shown.has(n.id)).toBe(true);
    });
  });

  describe("folding", () => {
    const folded = (doc: MindmapDocument, ids: string[], mode: ViewMode = "all") => {
      const result = layoutTree(doc, mode, sizeOf, new Set(ids));
      if (!result) throw new Error("no root");
      return result;
    };

    it("hides a folded branch and says how many cards it holds", () => {
      const doc = emptyDoc();
      const phase = addChild(doc, { type: "plan", label: "Phase" });
      const [first] = tasks(doc, 2, phase.id);
      tasks(doc, 1, first);

      const open = layout(doc);
      expect(open.branches.get(phase.id)).toBe(0);
      expect(open.positions.size).toBe(5);

      const closed = folded(doc, [phase.id]);
      expect(closed.positions.size).toBe(2);
      expect(closed.branches.get(phase.id)).toBe(3);
      expectNoOverlaps(closed);
    });

    it("offers no fold on a leaf or on the root, and a folded root stays open", () => {
      const doc = emptyDoc();
      const leaf = addChild(doc, { type: "task", label: "Leaf" });
      const l = folded(doc, ["root"]);
      expect(l.positions.has(leaf.id)).toBe(true);
      expect(l.branches.size).toBe(0);
    });

    it("only offers a fold for children the view draws", () => {
      const doc = emptyDoc();
      const task = addChild(doc, { type: "task", label: "Task" });
      addChild(doc, { type: "decision", label: "Why", parent: task.id });
      expect(layout(doc, "plan").branches.has(task.id)).toBe(false);
      expect(layout(doc, "hld").branches.get(task.id)).toBe(0);
    });

    it("finds the topmost finished branches, skipping those with open work and those with no tasks", () => {
      const doc = emptyDoc();
      const done = addChild(doc, { type: "plan", label: "Done", status: "completed" });
      addChild(doc, { type: "task", label: "Finished", status: "completed", parent: done.id });
      const mixed = addChild(doc, { type: "plan", label: "Mixed", status: "in_progress" });
      addChild(doc, { type: "task", label: "Open", parent: mixed.id });
      const inner = addChild(doc, { type: "plan", label: "Inner", status: "completed", parent: mixed.id });
      addChild(doc, { type: "task", label: "Also finished", status: "completed", parent: inner.id });
      const component = addChild(doc, { type: "component", label: "No tasks here" });
      addChild(doc, { type: "risk", label: "Skew", parent: component.id });
      addChild(doc, { type: "task", label: "A finished leaf", status: "completed" });

      expect(finishedBranches(doc)).toEqual([done.id, inner.id]);
    });
  });

  it("walks up to the root and down a branch", () => {
    const doc = emptyDoc();
    const a = addChild(doc, { type: "plan", label: "A" });
    const b = addChild(doc, { type: "task", label: "B", parent: a.id });
    expect(ancestors(doc, b).map((n): string => n.id)).toEqual(["root", a.id]);
    expect(subtree(doc, a).map((n) => n.id)).toEqual([a.id, b.id]);
  });

  it("widens the gaps between columns when they have to carry flow link labels", () => {
    const doc = emptyDoc();
    const a = addChild(doc, { type: "component", label: "A" });
    const gapWithoutLinks = box(layout(doc), a.id).left - box(layout(doc), ROOT_ID).right;
    doc.links.push({ id: LinkId.parse("l_1"), from: a.id, to: a.id, label: "x", style: "solid" });
    expect(box(layout(doc), a.id).left - box(layout(doc), ROOT_ID).right).toBeGreaterThan(gapWithoutLinks);
  });
});
