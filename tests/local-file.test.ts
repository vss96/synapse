import { describe, expect, it } from "bun:test";
import { ROOT_ID, now, type ChildNode, type MindmapDocument } from "../src/model/schema.js";
import { isMindmapDocument } from "../viewer/local-file.js";
import { addChild, emptyDoc } from "./fixtures.js";

describe("viewer local files", () => {
  const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

  it("accepts a stored mindmap", () => {
    const doc = emptyDoc();
    addChild(doc, { type: "task", label: "Step" });
    expect(isMindmapDocument(roundTrip(doc))).toBe(true);
  });

  /** A stored mindmap with one task, changed by `tweak`, as parsed JSON. */
  function tweaked(tweak: (doc: MindmapDocument, task: ChildNode) => void): unknown {
    const doc = emptyDoc();
    const task = addChild(doc, { type: "task", label: "Step" });
    tweak(doc, task);
    return roundTrip(doc);
  }
  const timestamp = now();

  it("rejects a file whose cards can't be drawn", () => {
    const badNodes: Array<(doc: MindmapDocument, task: ChildNode) => void> = [
      (_, task) => Reflect.deleteProperty(task, "status"),
      (_, task) => Reflect.set(task, "status", "nonsense"),
      (_, task) => Reflect.set(task, "type", 'x"><image onerror="alert(1)"/><g class="'),
      (_, task) => Reflect.set(task, "files", [null]),
      (_, task) => Reflect.set(task, "files", [{ path: "a.ts", action: "explode", changes: [], timestamp }]),
      (_, task) => Reflect.set(task, "files", [{ path: "a.ts", action: "modify", changes: [null], timestamp }]),
      (_, task) => Reflect.set(task, "files", [{ path: "a.ts", action: "rename", changes: [], timestamp }]),
      (doc) => Reflect.set(doc, "links", [null]),
      (doc, task) => Reflect.set(doc, "links", [{ id: "l_1", from: task.id, to: "n_gone", label: "calls", style: "solid" }]),
      (doc) => Reflect.set(doc, "activityLog", [null]),
    ];
    for (const breakIt of badNodes) expect(isMindmapDocument(tweaked(breakIt))).toBe(false);
  });

  it("rejects a file whose tree doesn't end, which would hang the page", () => {
    const cycle = tweaked((doc, task) => {
      const other = addChild(doc, { type: "task", label: "Other", parent: task.id });
      Reflect.set(task, "parent", other.id);
      task.children = [other.id];
      const root = doc.nodes[ROOT_ID];
      if (root) root.children = [];
    });
    expect(isMindmapDocument(cycle)).toBe(false);

    const rootWithParent = tweaked((doc, task) => {
      Reflect.set(doc.nodes[ROOT_ID] ?? {}, "parent", task.id);
    });
    expect(isMindmapDocument(rootWithParent)).toBe(false);

    const twoParents = tweaked((doc, task) => {
      const other = addChild(doc, { type: "task", label: "Other" });
      other.children = [task.id];
    });
    expect(isMindmapDocument(twoParents)).toBe(false);
  });

  it("rejects what would break rendering halfway through", () => {
    const doc = emptyDoc();
    const without = (field: string): unknown => {
      const copy = roundTrip(doc);
      if (typeof copy === "object" && copy) Reflect.deleteProperty(copy, field);
      return copy;
    };
    for (const value of [null, 42, [], {}, without("links"), without("activityLog"), without("nodes"), { ...doc, nodes: {} }]) {
      expect(isMindmapDocument(value)).toBe(false);
    }
    const broken = roundTrip(doc);
    expect(isMindmapDocument(JSON.parse(JSON.stringify(broken).replace('"files":[]', '"files":"none"')))).toBe(false);
  });
});
