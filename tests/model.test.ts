import { describe, it, expect } from "bun:test";
import { aggregateFiles, isAutoDetected, isFileEvent } from "../src/model/file-stats.js";
import { combineTouches, fileTouchTarget, isFinished, mergeChanges, upsertFileTouch, upsertFileTouches } from "../src/model/file-touch.js";
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
  Timestamp,
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

  it("lets what an agent logged outrank what the watcher saw", () => {
    const auto = { ...touch("modify"), summary: "Auto-detected file modify", source: "watcher" } as const;
    const logged = { ...touch("modify"), summary: "Fixed the retry" };

    expect(combineTouches(auto, auto)).toMatchObject({ summary: "Auto-detected file modify", source: "watcher" });
    expect(combineTouches(logged, auto)).toMatchObject({ summary: "Fixed the retry", source: undefined });
    expect(combineTouches(auto, logged)).toMatchObject({ summary: "Fixed the retry", source: undefined });
    const unsummarized = combineTouches(auto, touch("modify"));
    expect(unsummarized.summary).toBeUndefined();
    expect(isAutoDetected(unsummarized)).toBe(false);
  });

  it("counts a file as logged once an agent reads it, without calling the edit a read", () => {
    const auto = { ...touch("modify"), summary: "Auto-detected file modify", source: "watcher" } as const;
    expect(combineTouches(auto, { ...read(), summary: "Checked the retry" })).toMatchObject({ action: "modify", summary: "Checked the retry", source: undefined });
    const logged = { ...touch("modify"), summary: "Fixed the retry" };
    expect(combineTouches(logged, { ...read(), summary: "Checked it" }).summary).toBe("Fixed the retry");
  });

  it("treats a git sync as auto-detected, so it can't pass the files it finds off as logged", () => {
    const watcher = { ...touch("modify"), summary: "Auto-detected file modify", source: "watcher" } as const;
    const synced = { ...touch("modify"), summary: "Git modify (+1/-0 lines)", source: "git" } as const;
    expect(isAutoDetected(synced)).toBe(true);
    expect(combineTouches(watcher, synced)).toMatchObject({ summary: "Git modify (+1/-0 lines)", source: "git" });
    expect(combineTouches({ ...touch("modify"), summary: "Fixed it" }, synced)).toMatchObject({ summary: "Fixed it", source: undefined });
  });

  describe("across nodes", () => {
    const at = (touched: FileTouch, seconds: number): FileTouch => ({ ...touched, timestamp: Timestamp.parse(new Date(seconds * 1000).toISOString()) });
    /** The file a.ts, aggregated from two nodes in the given order. */
    function aggregated(first: FileTouch, second: FileTouch) {
      const doc = emptyDoc();
      const a = addChild(doc, { type: "task", label: "A" });
      const b = addChild(doc, { type: "task", label: "B" });
      a.files.push(first);
      b.files.push(second);
      const file = aggregateFiles([a, b]).get("a.ts");
      if (!file) throw new Error("a.ts not aggregated");
      return file;
    }

    it("doesn't let a later read on another node downgrade an edit", () => {
      const edit = at(touch("modify", "a.ts", [fix]), 1);
      const later = at(read(), 2);
      expect(aggregated(edit, later).touch.action).toBe("modify");
      expect(aggregated(later, edit).touch.action).toBe("modify");
    });

    it("keeps an agent's summary when the watcher sees the file later on another node", () => {
      const logged = at({ ...touch("modify"), summary: "By hand" }, 1);
      const auto = at({ ...touch("modify"), summary: "Auto-detected file modify", source: "watcher" }, 2);
      expect(aggregated(logged, auto).touch.summary).toBe("By hand");
      expect(aggregated(auto, logged).touch.summary).toBe("By hand");
    });

    it("gives the same result whichever node comes first", () => {
      const older = at({ ...touch("modify"), lines: "1-5", summary: "Older" }, 1);
      const newer = at(touch("modify"), 2);
      expect(aggregated(older, newer).touch).toMatchObject({ lines: "1-5", summary: "Older" });
      expect(aggregated(newer, older).touch).toMatchObject({ lines: "1-5", summary: "Older" });
    });
  });

  it("recognises auto-detected touches on mindmaps saved before they were marked", () => {
    expect(isAutoDetected({ ...touch("modify"), summary: "Auto-detected file create" })).toBe(true);
    expect(isAutoDetected({ ...touch("modify"), source: "watcher" })).toBe(true);
    expect(isAutoDetected({ ...touch("modify"), summary: "Auto-detected a race by hand" })).toBe(false);
    expect(isAutoDetected(touch("modify"))).toBe(false);
  });

  it("tells the watcher's activity entries from everything else", () => {
    const entry = (message: string) => ({ timestamp: now(), message });
    for (const action of ["create", "modify", "delete"]) expect(isFileEvent(entry(`File ${action}: src/a.ts`))).toBe(true);
    expect(isFileEvent(entry("[MODIFY] src/a.ts (on \"Task\")"))).toBe(false);
    expect(isFileEvent(entry("File modified by hand"))).toBe(false);
    expect(isFileEvent(entry('Task "File create: a" marked completed'))).toBe(false);
  });

  it("aggregates a file across nodes, counting it as logged if any agent logged it", () => {
    const doc = emptyDoc();
    const a = addChild(doc, { type: "task", label: "A" });
    const b = addChild(doc, { type: "task", label: "B" });
    const auto = { ...touch("modify"), summary: "Auto-detected file modify" };
    a.files.push(auto, { ...auto, path: "only-auto.ts" });
    b.files.push({ ...touch("modify", "a.ts", [fix]), summary: "By hand" });

    const files = aggregateFiles([a, b]);
    expect(files.get("a.ts")).toMatchObject({ autoDetected: false, changes: [{ ...fix, via: ["B"] }] });
    expect(files.get("a.ts")?.nodes.map((n) => n.label)).toEqual(["A", "B"]);
    expect(files.get("only-auto.ts")?.autoDetected).toBe(true);
  });

  it("merges changes on kind + symbol, keeping the latest detail", () => {
    const merged = combineTouches(touch("modify", "a.ts", [{ ...fix, detail: "v1" }, add]), touch("modify", "a.ts", [{ ...fix, detail: "v2" }]));
    expect(merged.action !== "read" && merged.changes).toEqual([{ ...fix, detail: "v2" }, add]);
  });

  it("keeps changes apart that share only a kind or only a symbol", () => {
    const addParse: CodeChange = { kind: "add", symbol: "parse" };
    const addFormat: CodeChange = { kind: "add", symbol: "format" };
    const fixParse: CodeChange = { kind: "fix", symbol: "parse" };
    expect(mergeChanges([addParse], [addFormat, fixParse])).toEqual([addParse, addFormat, fixParse]);
  });

  it("lets a rename take over the entry logged under the old path", () => {
    const node = addChild(emptyDoc(), { type: "task", label: "Step" });
    upsertFileTouch(node, touch("modify", "old.ts", [fix]));
    upsertFileTouch(node, touch("rename", "new.ts"));
    expect(node.files).toHaveLength(1);
    expect(node.files[0]).toMatchObject({ action: "rename", path: "new.ts", previousPath: "old.ts", changes: [fix] });
  });

  it("applies a batch in order: repeats merge, and a rename moves the entry to its new path", () => {
    const node = addChild(emptyDoc(), { type: "task", label: "Step" });
    upsertFileTouch(node, touch("modify", "old.ts", [fix]));
    upsertFileTouches(node, [
      touch("create", "b.ts"),
      touch("modify", "b.ts"),
      touch("rename", "new.ts"),
      touch("modify", "new.ts", [add]),
      touch("modify", "old.ts"),
    ]);
    expect(node.files.map((f) => `${f.action}:${f.path}`)).toEqual(["rename:new.ts", "create:b.ts", "modify:old.ts"]);
    expect(node.files[0]).toMatchObject({ previousPath: "old.ts", changes: [fix, add] });
  });

  it("merges a rename into an entry under its new path, leaving the old path's entry alone", () => {
    const node = addChild(emptyDoc(), { type: "task", label: "Step" });
    upsertFileTouches(node, [touch("modify", "old.ts"), touch("modify", "new.ts"), touch("rename", "new.ts")]);
    expect(node.files.map((f) => `${f.action}:${f.path}`)).toEqual(["modify:old.ts", "rename:new.ts"]);
  });

  it("merges into the first entry of a path listed twice", () => {
    const node = addChild(emptyDoc(), { type: "task", label: "Step", files: [touch("modify", "a.ts"), touch("modify", "a.ts")] });
    upsertFileTouches(node, [touch("modify", "a.ts", [fix])]);
    expect(node.files.map((f) => (f.action === "read" ? [] : f.changes))).toEqual([[fix], []]);
  });

  it("merges into a path's next entry once a rename has moved its first", () => {
    const files = [touch("modify", "old.ts"), touch("modify", "old.ts"), touch("modify", "old.ts")];
    const node = addChild(emptyDoc(), { type: "task", label: "Step", files });
    upsertFileTouches(node, [touch("rename", "new.ts"), touch("modify", "old.ts", [fix])]);
    expect(node.files.map((f) => `${f.action}:${f.path}`)).toEqual(["rename:new.ts", "modify:old.ts", "modify:old.ts"]);
    expect(node.files.map((f) => (f.action === "read" ? [] : f.changes))).toEqual([[], [fix], []]);
  });

  it("leaves a node stamped with the batch's last touch", () => {
    const node = addChild(emptyDoc(), { type: "task", label: "Step" });
    const last = { ...touch("modify", "b.ts"), timestamp: Timestamp.parse("2030-01-01T00:00:00.000Z") };
    upsertFileTouches(node, [touch("modify", "a.ts"), last]);
    expect(node.updatedAt).toBe(last.timestamp);
  });

  it("reads a node's files once per batch, not once per touch", () => {
    const files = Array.from({ length: 1000 }, (_, i) => touch("modify", `old${i}.ts`));
    const node = addChild(emptyDoc(), { type: "task", label: "Step", files });
    let reads = 0;
    node.files = new Proxy(node.files, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    upsertFileTouches(node, Array.from({ length: 1000 }, (_, i) => touch("modify", `new${i}.ts`)));
    expect(node.files).toHaveLength(2000);
    expect(reads).toBeLessThan(5000); // a scan per touch would be at least 1,000,000
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

  it("only takes a file node under the root called Touched Files for the fallback", () => {
    const doc = emptyDoc();
    const concept = addChild(doc, { type: "component", label: "Touched Files" });
    const otherFile = addChild(doc, { type: "file", label: "Other" });
    const nested = addChild(doc, { type: "file", label: "Touched Files", parent: concept.id });
    const fallback = fileTouchTarget(doc);
    expect([concept.id, otherFile.id, nested.id]).not.toContain(fallback.id);
    expect(fallback).toMatchObject({ type: "file", label: "Touched Files", parent: ROOT_ID });
  });
});

describe("model: finished mindmaps", () => {
  it("is finished once it has tasks and all of them are completed", () => {
    const doc = emptyDoc();
    addChild(doc, { type: "component", label: "Gateway" });
    addChild(doc, { type: "note", label: "Idea" });
    expect(isFinished(doc)).toBe(false); // no tasks: nothing has been finished
    addChild(doc, { type: "task", label: "Done", status: "completed" });
    expect(isFinished(doc)).toBe(true);
  });

  for (const status of ["planned", "in_progress", "blocked"] as const) {
    it(`isn't finished while a task is ${status}`, () => {
      const doc = emptyDoc();
      addChild(doc, { type: "task", label: "Done", status: "completed" });
      addChild(doc, { type: "task", label: "Open", status });
      expect(isFinished(doc)).toBe(false);
    });
  }
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
