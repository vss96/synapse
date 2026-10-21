import { describe, it, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
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

  it("archives and restores a mindmap without making it look recently updated", async () => {
    const doc = emptyDoc("mm_archive", "Old work");
    await store.save(doc);
    const { updatedAt } = doc;

    const archived = await store.setArchived(doc.id, true);
    assert.ok(archived?.archivedAt);
    assert.equal(archived.updatedAt, updatedAt);
    assert.equal((await store.list()).find((m) => m.id === doc.id)?.archivedAt, archived.archivedAt);

    const restored = await store.setArchived(doc.id, false);
    assert.equal(restored?.archivedAt, undefined);
    assert.equal((await store.load(doc.id))?.archivedAt, undefined);
    assert.equal(await store.setArchived(MindmapId.parse("mm_missing"), true), null);
    await store.remove(doc.id);
  });

  it("updates a mindmap under its lock, writing only when something changed", async () => {
    const doc = emptyDoc("mm_update", "Shared");
    await store.save(doc);

    await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(doc.id, (d) => addChild(d, { type: "task", label: `T${i}` }))));
    const updated = await store.load(doc.id);
    assert.equal(Object.keys(updated?.nodes ?? {}).length, 21, "no concurrent update was lost");

    assert.equal(await store.update(doc.id, () => "untouched"), "untouched");
    assert.equal((await store.load(doc.id))?.updatedAt, updated?.updatedAt, "an update that changes nothing isn't written");

    await assert.rejects(
      store.update(doc.id, (d) => {
        addChild(d, { type: "task", label: "Half done" });
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(Object.keys((await store.load(doc.id))?.nodes ?? {}).length, 21, "a failed update saves nothing");
    assert.equal(await store.update(MindmapId.parse("mm_missing"), () => "x"), null);
    await store.remove(doc.id);
  });

  it("keeps archive state when an agent saves a copy it loaded before the archive", async () => {
    const doc = emptyDoc("mm_stale", "Busy");
    await store.save(doc);
    const agentCopy = await store.load(doc.id);
    assert.ok(agentCopy);

    const archived = await store.setArchived(doc.id, true);
    addChild(agentCopy, { type: "task", label: "Agent kept working" });
    await store.save(agentCopy);
    const afterSave = await store.load(doc.id);
    assert.equal(afterSave?.archivedAt, archived?.archivedAt, "the stale copy doesn't undo the archive");
    assert.ok(Object.values(afterSave?.nodes ?? {}).some((n) => n.label === "Agent kept working"));

    await store.setArchived(doc.id, false);
    await store.save(afterSave!); // still carries archivedAt from before the restore
    assert.equal((await store.load(doc.id))?.archivedAt, undefined, "nor does it undo a restore");

    const files = await readdir(tmpDir);
    assert.ok(!files.some((f) => f.endsWith(".lock")), "no lock file is left behind");
    await store.remove(doc.id);
  });

  it("takes over a lock left behind by a process that died", async () => {
    const doc = emptyDoc("mm_lock", "Locked");
    const lock = path.join(tmpDir, "mm_lock.json.lock");
    await writeFile(lock, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await store.save(doc);
    assert.ok(await store.load(doc.id));
    await store.remove(doc.id);
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
