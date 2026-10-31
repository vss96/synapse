import { describe, it, beforeAll, afterAll, setSystemTime, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as store from "../src/store.js";
import { render } from "../src/renderer.js";
import { LinkId, MindmapDocument, MindmapId, ROOT_ID, now } from "../src/model/schema.js";
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

  it("counts only completed tasks as completed", async () => {
    const doc = emptyDoc("mm_counts", "Counts");
    addChild(doc, { type: "task", label: "Done", status: "completed" });
    addChild(doc, { type: "task", label: "Also done", status: "completed" });
    addChild(doc, { type: "task", label: "Open", status: "planned" });
    await store.save(doc);
    const item = (await store.list()).mindmaps.find((m) => m.id === doc.id);
    assert.equal(item?.completedTasks, 2);
    assert.equal(item?.totalTasks, 3);
    await store.remove(doc.id);
  });

  it("lists only JSON files, so nothing else in the folder looks like a damaged mindmap", async () => {
    await writeFile(path.join(tmpDir, "notes.txt"), "not a mindmap");
    await mkdir(path.join(tmpDir, "folder.json"));
    assert.deepEqual((await store.list()).unreadable, []);
    await rm(path.join(tmpDir, "notes.txt"));
    await rm(path.join(tmpDir, "folder.json"), { recursive: true });
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

  it("lets one caller at a time take over a stale lock", async () => {
    const doc = emptyDoc("mm_race", "Race");
    await store.save(doc);
    const lock = path.join(tmpDir, "mm_race.json.lock");
    const old = new Date(Date.now() - 60_000);
    for (let round = 0; round < 5; round++) {
      await writeFile(lock, "");
      await utimes(lock, old, old);
      // Each update reads the file and writes it back, so two inside the lock at once lose one of them.
      await Promise.all(Array.from({ length: 20 }, () => store.update(doc.id, (d) => store.recordActivity(d, "Update"))));
    }
    assert.equal((await store.load(doc.id))?.activityLog.length, 100);
    await store.remove(doc.id);
  });

  it("isn't stopped by a process that died while taking over a lock", async () => {
    const doc = emptyDoc("mm_guard", "Guard");
    await store.save(doc);
    const lock = path.join(tmpDir, "mm_guard.json.lock");
    await writeFile(lock, "");
    await writeFile(`${lock}.break`, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await utimes(`${lock}.break`, old, old);
    await store.update(doc.id, (d) => void (d.title = "Changed"));
    assert.equal((await store.load(doc.id))?.title, "Changed");
    assert.ok(!(await readdir(tmpDir)).some((f) => f.endsWith(".break")), "nothing is left behind");
    await store.remove(doc.id);
  });

  it("gives up on a lock its owner won't let go of, and says who holds it", async () => {
    const doc = emptyDoc("mm_stuck", "Stuck");
    await store.save(doc);
    const lock = path.join(tmpDir, "mm_stuck.json.lock");
    await writeFile(lock, String(process.pid));
    const update = store.update(doc.id, (d) => void (d.title = "Changed"));
    await new Promise((r) => setTimeout(r, 50));
    setSystemTime(new Date(Date.now() + 60_000));
    try {
      await assert.rejects(update, new RegExp(`waiting for process ${process.pid} to finish with mm_stuck\\.json.*delete ${lock}`));
    } finally {
      setSystemTime();
      await unlink(lock);
    }
    assert.equal((await store.load(doc.id))?.title, "Stuck");
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
    const junkDoc = { id: "mm_junk", title: "", nodes: {} }; // its first two issues read differently
    await writeFile(path.join(tmpDir, "mm_junk.json"), JSON.stringify(junkDoc));
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
    const firstIssue = MindmapDocument.safeParse(junkDoc).error?.issues[0]?.message;
    assert.equal(unreadable[0]?.error, `not a valid mindmap (${firstIssue})`);
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

  describe("a full activity log", () => {
    const fileEvent = (doc: MindmapDocument, i: number) => store.recordActivity(doc, `File modify: src/file-${i}.ts`, { nodeId: ROOT_ID, file: `src/file-${i}.ts` });
    const messages = (doc: MindmapDocument) => doc.activityLog.map((e) => e.message);

    it("keeps task history however many file events arrive", () => {
      const doc = emptyDoc("mm_busy_log");
      for (let i = 1; i <= 5; i++) store.recordActivity(doc, `Task ${i} marked completed`);
      for (let i = 1; i <= 300; i++) fileEvent(doc, i);
      assert.equal(doc.activityLog.length, 100);
      assert.equal(messages(doc).filter((m) => m.startsWith("Task ")).length, 5);
      assert.equal(messages(doc)[0], "File modify: src/file-300.ts");
    });

    it("gives up the oldest file event, not the oldest entry, for something newer", () => {
      const doc = emptyDoc("mm_mixed_log");
      store.recordActivity(doc, "Created mindmap");
      for (let i = 1; i <= 99; i++) fileEvent(doc, i);
      store.recordActivity(doc, "Task marked completed");
      assert.equal(doc.activityLog.length, 100);
      assert.equal(messages(doc)[0], "Task marked completed");
      assert.equal(messages(doc).at(-1), "Created mindmap");
      assert.ok(!messages(doc).includes("File modify: src/file-1.ts"));
      assert.ok(messages(doc).includes("File modify: src/file-2.ts"));
    });

    it("has no room for a file event once it holds nothing else, and drops its oldest entry for anything more", () => {
      const doc = emptyDoc("mm_task_log");
      for (let i = 1; i <= 100; i++) store.recordActivity(doc, `Event ${i}`);
      fileEvent(doc, 1);
      assert.equal(doc.activityLog.length, 100);
      assert.equal(messages(doc)[0], "Event 100");
      store.recordActivity(doc, "Event 101");
      assert.equal(messages(doc)[0], "Event 101");
      assert.equal(messages(doc).at(-1), "Event 2");
    });
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
    assert.match(mermaidOut, /n_step1\("◐ Implement JWT middleware"\)/);
    assert.match(mermaidOut, /n_step1_f0\("MODIFY src\/auth\.ts:10-45"\)/);

    const jsonOut = JSON.parse(render(doc, { format: "json" }));
    assert.equal(jsonOut.id, "mm_render");
  });

  it("gives every status the viewer's glyph in mermaid, and keeps the text format's badges", () => {
    const doc = emptyDoc("mm_glyphs", "Glyphs");
    addChild(doc, { id: "n_planned", type: "task", label: "Planned", status: "planned" });
    addChild(doc, { id: "n_doing", type: "plan", label: "Doing", status: "in_progress" });
    addChild(doc, { id: "n_done", type: "code", label: "Done", status: "completed" });
    addChild(doc, { id: "n_stuck", type: "task", label: "Stuck", status: "blocked" });
    addChild(doc, { id: "n_concept", type: "component", label: "Concept" });

    assert.deepEqual(render(doc, { format: "mermaid" }).split("\n"), [
      "mindmap",
      '  root("Glyphs")',
      '    n_planned("○ Planned")',
      '    n_doing("◐ Doing")',
      '    n_done("✔ Done")',
      '    n_stuck("✖ Stuck")',
      '    n_concept("📦 Concept")',
    ]);

    const textOut = render(doc, { format: "text" });
    for (const line of [/\[ \] Planned/, /\[~\] Doing/, /\[x\] Done/, /\[!\] Stuck/]) assert.match(textOut, line);
  });

  it("gives file nodes ids of their own in mermaid, numbered in file order under their node", () => {
    const doc = emptyDoc("mm_files", "Files");
    const timestamp = now();
    doc.nodes[ROOT_ID]!.files.push({ path: "README.md", action: "read", timestamp });
    addChild(doc, {
      id: "n_step",
      type: "note",
      label: "Step",
      files: [
        { path: "src/a.ts", action: "create", changes: [], timestamp },
        { path: "src/b.ts", action: "delete", lines: "1-2", changes: [], timestamp },
      ],
    });

    const expected = [
      "mindmap",
      '  root("Files")',
      '    root_f0("READ README.md")',
      '    n_step("Step")',
      '      n_step_f0("CREATE src/a.ts")',
      '      n_step_f1("DELETE src/b.ts:1-2")',
    ].join("\n");
    assert.equal(render(doc, { format: "mermaid" }), expected);
    assert.equal(render(doc, { format: "mermaid" }), expected, "the ids don't change between renders");
  });

  it("quotes mermaid labels, escaping only what a quoted string can't hold", () => {
    const cases = [
      ["src/a.ts:12 (b) [c] {d}", "src/a.ts:12 (b) [c] {d}"], // quoting keeps colons and brackets as written
      ['say "hi"', "say #34;hi#34;"], // Mermaid has no \" escape
      ["`code` first", "#96;code#96; first"], // a leading backtick would start a Markdown string
      ["%%{init: {}}%%", "#37;#37;{init: {}}#37;#37;"], // read as a directive even inside quotes
      ["Map<K, V>", "Map#60;K, V#62;"], // would be read as an HTML tag
      ["#1; #quot;", "#35;1; #35;quot;"], // would be read as an entity
      ["C:\\new\\table", "C:#92;new#92;table"], // flowcharts would draw \n as a line break
      ["two\n  lines", "two lines"],
    ] as const;

    for (const [label, escaped] of cases) {
      const doc = emptyDoc("mm_quotes", "Quotes");
      const node = addChild(doc, { id: "n_note", type: "note", label });
      doc.links.push({ id: LinkId.parse("l_1"), from: node.id, to: ROOT_ID, label, style: "solid" });

      assert.ok(render(doc, { format: "mermaid" }).includes(`n_note("${escaped}")`), label);
      const flowchart = render(doc, { format: "mermaid-flowchart" });
      assert.ok(flowchart.includes(`n1["${escaped}"]`), label);
      assert.ok(flowchart.includes(`n1 -->|"${escaped}"| n0`), label);
    }
  });

  it("renders mermaid-flowchart with the tree as lines and links as labeled arrows in their style", () => {
    const doc = emptyDoc("mm_flow", "Flow");
    const timestamp = now();
    const api = addChild(doc, { id: "n_api", type: "component", label: "API", files: [{ path: "src/api.ts", action: "read", lines: "1-9", timestamp }] });
    // A generated id can contain "--", which would start an edge in a flowchart
    const store = addChild(doc, { id: "n_ab--c", type: "task", label: "Store", status: "completed", parent: api.id });
    const bus = addChild(doc, { id: "n_bus", type: "data_flow", label: "Bus" });
    doc.links.push(
      { id: LinkId.parse("l_1"), from: api.id, to: store.id, label: "reads: data", style: "solid" },
      { id: LinkId.parse("l_2"), from: store.id, to: bus.id, label: 'emits "x"', style: "dashed" },
      { id: LinkId.parse("l_3"), from: bus.id, to: api.id, label: "streams", style: "animated" },
    );

    assert.deepEqual(render(doc, { format: "mermaid-flowchart" }).split("\n"), [
      "flowchart LR",
      '  n0["Flow"]',
      '  n1["📦 API"]',
      '  n1_f0("READ src/api.ts:1-9")',
      '  n2["✔ Store"]',
      '  n3["⇄ Bus"]',
      "  n0 --- n1",
      "  n1 --- n1_f0",
      "  n1 --- n2",
      "  n0 --- n3",
      '  n1 -->|"reads: data"| n2',
      '  n2 -.->|"emits #34;x#34;"| n3',
      '  n3 ==>|"streams"| n1',
    ]);
  });

  it("renders links only in mermaid-flowchart, not in mermaid mindmaps, which can't draw them", () => {
    const doc = emptyDoc("mm_nolinks", "No links");
    const a = addChild(doc, { type: "component", label: "A" });
    doc.links.push({ id: LinkId.parse("l_1"), from: a.id, to: ROOT_ID, label: "calls", style: "solid" });
    assert.doesNotMatch(render(doc, { format: "mermaid" }), /calls/);
    assert.match(render(doc, { format: "mermaid-flowchart" }), /calls/);
  });
});
