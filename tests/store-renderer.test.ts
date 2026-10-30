import { describe, it, beforeAll, afterAll, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
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

    const items = (await store.list()).mindmaps;
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
    assert.equal((await store.list()).mindmaps.find((m) => m.id === doc.id)?.archivedAt, archived.archivedAt);

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

  it("waits for a lock whose owner is still running, however old the lock", async () => {
    const doc = emptyDoc("mm_busy", "Busy");
    await store.save(doc);
    const lock = path.join(tmpDir, "mm_busy.json.lock");
    await writeFile(lock, String(process.pid));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    let finished = false;
    const update = store.update(doc.id, (d) => {
      d.title = "Changed";
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(finished, false, "the owner may just be blocking its event loop");
    await unlink(lock);
    await update;
    assert.equal((await store.load(doc.id))?.title, "Changed");
    await store.remove(doc.id);
  });

  it("takes over a fresh lock whose owner has exited", async () => {
    const doc = emptyDoc("mm_gone", "Gone");
    const { pid } = spawnSync("git", ["--version"]);
    await writeFile(path.join(tmpDir, "mm_gone.json.lock"), String(pid));
    await store.save(doc);
    assert.ok(await store.load(doc.id));
    await store.remove(doc.id);
  });

  it("gives every write its own temp file", async () => {
    const doc = emptyDoc("mm_tmp", "Temp");
    const shared = path.join(tmpDir, `mm_tmp.json.${process.pid}.tmp`);
    await mkdir(shared); // A write to one temp name per process would fail here
    await store.save(doc);
    assert.ok(await store.load(doc.id));
    await rm(shared, { recursive: true });
    await store.remove(doc.id);
  });

  it("reports files on disk it can't read instead of treating them as missing", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const junk = MindmapId.parse("mm_junk");
    const tail = MindmapId.parse("mm_tail");
    await writeFile(path.join(tmpDir, "mm_junk.json"), JSON.stringify({ id: "mm_junk", nodes: {} }));
    await writeFile(path.join(tmpDir, "mm_tail.json"), `${JSON.stringify(emptyDoc("mm_tail", "Tail"))}\n"/fileHashes.bin"\n}`);

    for (const id of [junk, tail]) {
      await assert.rejects(store.load(id), store.UnreadableMindmapError);
      await assert.rejects(store.update(id, () => "x"), store.UnreadableMindmapError);
      await assert.rejects(store.setArchived(id, true), store.UnreadableMindmapError);
    }
    await store.list();
    const { mindmaps, unreadable } = await store.list();
    assert.ok(mindmaps.every((m) => m.id !== junk && m.id !== tail));
    assert.deepEqual(unreadable.map((m) => m.id), [junk, tail]);
    assert.match(unreadable[0]?.error ?? "", /not a valid mindmap/);
    assert.match(unreadable[1]?.error ?? "", /SyntaxError/);
    assert.equal(errors.mock.calls.filter(([line]) => String(line).includes("mm_tail")).length, 1, "logged once, not on every listing");

    assert.equal(await store.remove(tail), true, "it can still be deleted");
    await store.remove(junk);
    errors.mockRestore();
  });

  // Root can read a file whatever its permissions
  it.skipIf(process.getuid?.() === 0)("reports a file it isn't allowed to read instead of treating it as missing", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const doc = emptyDoc("mm_denied", "Denied");
    await store.save(doc);
    const file = path.join(tmpDir, "mm_denied.json");
    await chmod(file, 0o000);
    try {
      await assert.rejects(store.load(doc.id), store.UnreadableMindmapError);
      await assert.rejects(store.update(doc.id, () => "x"), store.UnreadableMindmapError);
      assert.deepEqual((await store.list()).unreadable.map((m) => m.id), [doc.id]);
    } finally {
      await chmod(file, 0o600);
      errors.mockRestore();
    }
    await store.remove(doc.id);
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
