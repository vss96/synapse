import { describe, it, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as store from "../src/store.js";
import { render } from "../src/renderer.js";
import { MindmapId, ROOT_ID, now } from "../src/model/schema.js";
import { addChild, emptyDoc } from "./fixtures.js";

describe("store & renderer", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    originalDataDir = process.env.SYNAPSE_DATA_DIR;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "synapse-store-test-"));
    process.env.SYNAPSE_DATA_DIR = tmpDir;
  });

  afterAll(async () => {
    if (originalDataDir === undefined) {
      delete process.env.SYNAPSE_DATA_DIR;
    } else {
      process.env.SYNAPSE_DATA_DIR = originalDataDir;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects mindmap ids that could escape the data directory", () => {
    for (const id of ["../outside", "a/b", "..", "", "x.json"]) {
      assert.equal(MindmapId.safeParse(id).success, false, id);
    }
  });

  it("saves, loads, lists, and removes mindmap documents", async () => {
    const doc = emptyDoc("mm_test0001", "First Map");
    addChild(doc, { type: "task", label: "Step", status: "in_progress" });
    addChild(doc, { type: "component", label: "API" });
    await store.save(doc);

    const id = MindmapId.parse("mm_test0001");
    const loaded = await store.load(id);
    assert.ok(loaded);
    assert.equal(loaded.title, "First Map");

    const items = await store.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.id, "mm_test0001");
    assert.equal(items[0]!.nodeCount, 3);
    assert.equal(items[0]!.totalTasks, 1, "HLD concepts are not tasks");
    assert.equal(items[0]!.activeTask, "Step");

    assert.equal(await store.remove(id), true);
    assert.equal(await store.load(id), null);
  });

  it("refuses to save a document that breaks the tree", async () => {
    const doc = emptyDoc("mm_broken");
    const node = addChild(doc, { type: "task", label: "Orphan" });
    doc.nodes[ROOT_ID]!.children = []; // parent no longer lists its child
    await assert.rejects(store.save(doc), /does not list it as a child/);
    assert.equal(await store.load(doc.id), null, "nothing was written");
    assert.ok(node);
  });

  it("skips files on disk that aren't valid mindmaps", async () => {
    await writeFile(path.join(tmpDir, "mm_junk.json"), JSON.stringify({ id: "mm_junk", nodes: {} }));
    assert.equal(await store.load(MindmapId.parse("mm_junk")), null);
    assert.ok((await store.list()).every((m) => m.id !== "mm_junk"));
  });

  it("caps activityLog at 100 entries with newest first", () => {
    const doc = emptyDoc("mm_act");
    for (let i = 1; i <= 110; i++) store.recordActivity(doc, `Event ${i}`, { nodeId: ROOT_ID });
    assert.equal(doc.activityLog.length, 100);
    assert.equal(doc.activityLog[0]!.message, "Event 110");
    assert.equal(doc.activityLog[99]!.message, "Event 11");
  });

  it("renders mermaid, text, and json formats with status badges and file touches", () => {
    const doc = emptyDoc("mm_render", "Auth Plan");
    addChild(doc, {
      id: "n_step1",
      type: "task",
      label: "Implement JWT middleware",
      status: "in_progress",
      notes: "Validate Bearer header",
      files: [
        {
          path: "src/auth.ts",
          action: "modify",
          lines: "10-45",
          symbols: ["verifyJwt"],
          summary: "Added token verification",
          changes: [],
          timestamp: now(),
        },
      ],
    });
    addChild(doc, { type: "component", label: "Gateway" });

    const textOut = render(doc, { format: "text" });
    assert.match(textOut, /# Auth Plan \(mm_render\)/);
    assert.match(textOut, /\[~\] Implement JWT middleware \[n_step1\]/);
    assert.match(textOut, /Validate Bearer header/);
    assert.match(textOut, /\[MODIFY\] src\/auth\.ts:10-45 \(verifyJwt\) — Added token verification/);
    assert.match(textOut, /├─ 📦 Gateway/, "concepts have no status badge");

    const mermaidOut = render(doc, { format: "mermaid" });
    assert.match(mermaidOut, /^mindmap/);
    assert.match(mermaidOut, /n_step1\(~ Implement JWT middleware\)/);
    assert.match(mermaidOut, /\(MODIFY src\/auth\.ts:10-45\)/);

    const jsonOut = JSON.parse(render(doc, { format: "json" }));
    assert.equal(jsonOut.id, "mm_render");
  });
});
