import { describe, it, expect } from "bun:test";
import { combineTouches, fileTouchTarget, upsertFileTouch } from "../src/model/file-touch.js";
import { isTask } from "../src/model/kinds.js";
import { reparent, retype } from "../src/model/node.js";
import {
  CodeChange,
  FileTouch,
  LinkId,
  MindmapDocument,
  MindmapId,
  NodeId,
  ROOT_ID,
  now,
  type EditTouch,
  type TaskNode,
} from "../src/model/schema.js";
import { addChild, emptyDoc } from "./fixtures.js";

const touch = (action: EditTouch["action"], path = "a.ts", changes: CodeChange[] = []): FileTouch =>
  action === "rename" ? { action, path, previousPath: "old.ts", changes, timestamp: now() } : { action, path, changes, timestamp: now() };
const read = (path = "a.ts"): FileTouch => ({ action: "read", path, timestamp: now() });
const issues = (doc: unknown) => MindmapDocument.safeParse(doc).error?.issues.map((i) => i.message) ?? [];

describe("model: illegal states don't compile", () => {
  it("is enforced by the type checker (see @ts-expect-error lines)", () => {
    const node = addChild(emptyDoc(), { type: "component", label: "Gateway" });
    // @ts-expect-error concepts have no status
    node.status;
    // @ts-expect-error a plain string is not a NodeId
    const id: NodeId = "n_123";
    // @ts-expect-error a NodeId is not a MindmapId
    const mindmap: MindmapId = ROOT_ID;
    // @ts-expect-error a rename must say what was renamed
    const change: CodeChange = { kind: "rename", symbol: "b" };
    // @ts-expect-error a read can't carry changes
    const reading: FileTouch = { action: "read", path: "a.ts", changes: [], timestamp: now() };
    // @ts-expect-error tasks must have a status
    const task: TaskNode = { id: ROOT_ID, type: "task", parent: ROOT_ID, label: "x", files: [], children: [], updatedAt: now() };
    expect([id, mindmap, change, reading, task]).toHaveLength(5);
  });
});

describe("model: parsing", () => {
  it("rejects ids that could escape the data directory", () => {
    for (const bad of ["../x", "a/b", "", "x.json", "a b"]) expect(MindmapId.safeParse(bad).success).toBe(false);
    expect(MindmapId.safeParse("mm_Ab-9_").success).toBe(true);
  });

  it("rejects changes and touches that are missing what their kind needs", () => {
    expect(CodeChange.safeParse({ kind: "rename", symbol: "b" }).success).toBe(false);
    expect(CodeChange.safeParse({ kind: "rename", symbol: "b", previousSymbol: "a" }).success).toBe(true);
    expect(CodeChange.safeParse({ kind: "mystery", symbol: "b" }).success).toBe(false);
    expect(FileTouch.safeParse({ action: "rename", path: "b.ts", changes: [], timestamp: now() }).success).toBe(false);
    expect(FileTouch.safeParse({ action: "modify", path: "b.ts", timestamp: now() }).success).toBe(false);
  });

  it("accepts a valid document and round-trips it", () => {
    const doc = emptyDoc();
    const task = addChild(doc, { type: "task", label: "Step", status: "in_progress" });
    addChild(doc, { type: "risk", label: "Race", parent: task.id });
    expect(MindmapDocument.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it("rejects documents whose tree doesn't hold together", () => {
    const missingRoot = emptyDoc();
    delete missingRoot.nodes[ROOT_ID];
    expect(issues(missingRoot)).toContain(`Node "root" must exist and be the root`);

    const doubleListed = emptyDoc();
    const a = addChild(doubleListed, { type: "task", label: "A" });
    const b = addChild(doubleListed, { type: "task", label: "B" });
    b.children.push(a.id); // A listed under root and B
    expect(issues(doubleListed)).toContain(`Child "${a.id}" does not point back to "${b.id}"`);

    const cycle = emptyDoc();
    const c = addChild(cycle, { type: "task", label: "C" });
    const d = addChild(cycle, { type: "task", label: "D", parent: c.id });
    cycle.nodes[ROOT_ID]!.children = [];
    c.parent = d.id;
    d.children.push(c.id);
    expect(issues(cycle)).toContain(`Node "${c.id}" is not reachable from the root`);

    const danglingLink = emptyDoc();
    danglingLink.links.push({ id: LinkId.parse("l_1"), from: ROOT_ID, to: NodeId.parse("n_gone"), label: "calls", style: "solid" });
    expect(issues(danglingLink)).toContain(`Link target "n_gone" does not exist`);
  });
});

describe("model: file touches", () => {
  const fix = { kind: "fix", symbol: "f" } as const;
  const add = { kind: "add", symbol: "g" } as const;

  it("never lets a read downgrade an edit", () => {
    expect(combineTouches(touch("modify", "a.ts", [fix]), read()).action).toBe("modify");
    expect(combineTouches(read(), touch("modify", "a.ts", [fix]))).toMatchObject({ action: "modify", changes: [fix] });
  });

  it("keeps a created or renamed file's identity when it is modified later", () => {
    expect(combineTouches(touch("create"), touch("modify")).action).toBe("create");
    expect(combineTouches(touch("rename"), touch("modify"))).toMatchObject({ action: "rename", previousPath: "old.ts" });
    expect(combineTouches(touch("create"), touch("delete")).action).toBe("delete");
  });

  it("merges changes on kind + symbol, keeping the latest detail", () => {
    const merged = combineTouches(touch("modify", "a.ts", [{ ...fix, detail: "v1" }, add]), touch("modify", "a.ts", [{ ...fix, detail: "v2" }]));
    expect(merged.action !== "read" && merged.changes).toEqual([{ ...fix, detail: "v2" }, add]);
  });

  it("lets a rename take over the entry logged under the old path", () => {
    const node = addChild(emptyDoc(), { type: "task", label: "Step" });
    upsertFileTouch(node, touch("modify", "old.ts", [fix]));
    upsertFileTouch(node, touch("rename", "new.ts"));
    expect(node.files).toHaveLength(1);
    expect(node.files[0]).toMatchObject({ action: "rename", path: "new.ts", previousPath: "old.ts", changes: [fix] });
  });

  it("attaches to the active task, never a concept, and falls back to one Touched Files node", () => {
    const doc = emptyDoc();
    addChild(doc, { type: "component", label: "Gateway" });
    const fallback = fileTouchTarget(doc);
    expect(fallback).toMatchObject({ type: "file", label: "Touched Files" });
    expect(fileTouchTarget(doc)).toBe(fallback);
    const active = addChild(doc, { type: "task", label: "Step", status: "in_progress" });
    expect(fileTouchTarget(doc)).toBe(active);
    expect(MindmapDocument.safeParse(doc).success).toBe(true);
  });
});

describe("model: nodes", () => {
  it("adds or drops the status when a node changes family", () => {
    const doc = emptyDoc();
    const task = addChild(doc, { type: "task", label: "Step", status: "blocked" });
    const concept = retype(task, "risk");
    expect("status" in concept).toBe(false);
    const backToTask = retype(concept, "task");
    expect(isTask(backToTask) && backToTask.status).toBe("planned");
    const asCode = retype(task, "code");
    expect(isTask(asCode) && asCode.status).toBe("blocked"); // moving within the task family keeps the status
  });

  it("moves a node between parents without leaving it listed twice", () => {
    const doc = emptyDoc();
    const a = addChild(doc, { type: "component", label: "A" });
    const b = addChild(doc, { type: "component", label: "B" });
    reparent(doc, b, a.id);
    expect(doc.nodes[ROOT_ID]!.children).toEqual([a.id]);
    expect(a.children).toEqual([b.id]);
    expect(MindmapDocument.safeParse(doc).success).toBe(true);
  });
});
