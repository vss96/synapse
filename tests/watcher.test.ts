import { describe, it, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { tools } from "../src/tools.js";
import * as store from "../src/store.js";
import { inspectGitChanges, shouldIgnorePath, watchedMindmap } from "../src/watcher.js";
import { MindmapId, type MindmapDocument } from "../src/model/schema.js";
import { addChild, emptyDoc } from "./fixtures.js";

const execFileAsync = promisify(execFile);

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await tools.find((t) => t.name === name)!.handler(args);
  assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
  return result.content[0]!.text;
}
async function createMindmap(args: Record<string, unknown>): Promise<MindmapId> {
  return z.object({ mindmapId: MindmapId }).parse(JSON.parse(await callTool("create_mindmap", args))).mindmapId;
}
/** Every file touch in the document, as sorted `action:path` strings. */
const touched = (doc: MindmapDocument) =>
  Object.values(doc.nodes)
    .flatMap((n) => n.files)
    .map((f) => `${f.action}:${f.path}`)
    .sort();

/** Polls until `check` passes on the stored document (fs events and the debounce take a moment). */
async function eventually(id: MindmapId, check: (doc: MindmapDocument) => void, timeoutMs = 8000): Promise<MindmapDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const doc = (await store.load(id))!;
    try {
      check(doc);
      return doc;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
const settle = () => new Promise((r) => setTimeout(r, 1500));

describe("shouldIgnorePath", () => {
  it("always skips git internals and atomic-write temp files", () => {
    for (const p of [".git/HEAD", "src/Foo.context.tsx.tmp.51496.f30edae39d38", "src/.!51496!index.ts", "a.ts~", ".a.ts.swp", "a.tmp"]) {
      assert.ok(shouldIgnorePath(p, true), p);
      assert.ok(shouldIgnorePath(p, false), p);
    }
    for (const p of ["src/index.ts", "src/target/x.ts", "src/tmp.ts", "docs/out.md"]) assert.ok(!shouldIgnorePath(p, false), p);
  });

  it("skips tool, dependency and build folders unless git tracks the file", () => {
    for (const p of [".gradle/9.8.1/fileHashes/fileHashes.lock", "buildSrc/.gradle/x", "app/__pycache__/m.pyc", ".idea/workspace.xml", "node_modules/x/index.js"]) {
      assert.ok(shouldIgnorePath(p, false), p);
      assert.ok(!shouldIgnorePath(p, true), p);
    }
  });
});

describe("workspace watcher", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  /** A repo with a.ts and b.ts on its default branch, and a branch `other` where b.ts differs. */
  async function makeRepo(name: string) {
    const repoDir = path.join(tmpDir, name);
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: repoDir });
    await mkdir(path.join(repoDir, "pkg"), { recursive: true });
    await git("init", "-q");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test User");
    await writeFile(path.join(repoDir, ".gitignore"), "*.log\n.gradle/\n");
    await writeFile(path.join(repoDir, "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(repoDir, "b.ts"), "export const b = 1;\n");
    await writeFile(path.join(repoDir, "pkg", "c.ts"), "export const c = 1;\n");
    await git("add", ".");
    await git("commit", "-qm", "initial");
    await git("checkout", "-qb", "other");
    await writeFile(path.join(repoDir, "b.ts"), "export const b = 2;\n");
    // An old commit: the checkout's time must come from the reflog, not from the commit
    const old = { ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" };
    await execFileAsync("git", ["commit", "-qam", "other b"], { cwd: repoDir, env: old });
    await git("checkout", "-q", "-");
    // So the checkout above isn't HEAD's latest move when the tests start
    await git("commit", "-q", "--allow-empty", "-m", "empty");
    return { repoDir, git };
  }

  beforeAll(async () => {
    originalDataDir = process.env.SYNAPSE_DATA_DIR;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "synapse-watcher-test-"));
    process.env.SYNAPSE_DATA_DIR = path.join(tmpDir, "data");
  });

  afterAll(async () => {
    if (originalDataDir === undefined) delete process.env.SYNAPSE_DATA_DIR;
    else process.env.SYNAPSE_DATA_DIR = originalDataDir;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("records atomic writes as modify and skips temp and gitignored files", async () => {
    const { repoDir } = await makeRepo("edits");
    const id = await createMindmap({ title: "Watch", workspacePath: repoDir, initialPlan: [{ label: "Edit", status: "in_progress" }] });
    await settle();

    // Atomic write over a tracked file, the way Claude Code's Edit tool and most editors save
    const temp = path.join(repoDir, "a.ts.tmp.51496.f30edae39d38");
    await writeFile(temp, "export const a = 2;\n");
    await rename(temp, path.join(repoDir, "a.ts"));
    // BSD sed -i temp, created and removed
    await writeFile(path.join(repoDir, ".!51496!b.ts"), "x");
    await unlink(path.join(repoDir, ".!51496!b.ts"));
    await mkdir(path.join(repoDir, ".gradle"));
    await writeFile(path.join(repoDir, ".gradle", "fileHashes.lock"), "x");
    await writeFile(path.join(repoDir, "debug.log"), "x");
    await writeFile(path.join(repoDir, "new.ts"), "export const n = 1;\n");

    const doc = await eventually(id, (d) => {
      const files = Object.values(d.nodes).flatMap((n) => n.files);
      assert.deepEqual(files.map((f) => `${f.action}:${f.path}`).sort(), ["create:new.ts", "modify:a.ts"]);
    });
    const step = Object.values(doc.nodes).find((n) => n.label === "Edit")!;
    assert.equal(step.files.length, 2, "attached to the in_progress task");
    await settle();
    const later = (await store.load(id))!;
    assert.deepEqual(Object.values(later.nodes).flatMap((n) => n.files).map((f) => f.path).sort(), ["a.ts", "new.ts"]);
  }, 20000);

  it("skips untracked files in the built-in folders even when the repo doesn't ignore them", async () => {
    const { repoDir, git } = await makeRepo("untracked-deps");
    await mkdir(path.join(repoDir, "dist"));
    await writeFile(path.join(repoDir, "dist", "bundle.js"), "1;\n");
    await git("add", ".");
    await git("commit", "-qm", "commit the bundle");
    const id = await createMindmap({ title: "Deps", workspacePath: repoDir, initialPlan: [{ label: "Edit", status: "in_progress" }] });
    await settle();

    // What `npm install` leaves in a repo with no node_modules rule. .idea is IDE state, so no exception for it.
    await mkdir(path.join(repoDir, "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(repoDir, "node_modules", "left-pad", "index.js"), "1;\n");
    await mkdir(path.join(repoDir, ".idea"));
    await writeFile(path.join(repoDir, ".idea", "workspace.xml"), "x");
    await writeFile(path.join(repoDir, "dist", "untracked.js"), "1;\n");
    // Git tracks this one, so it counts wherever it lives
    await writeFile(path.join(repoDir, "dist", "bundle.js"), "2;\n");
    await writeFile(path.join(repoDir, "new.ts"), "export const n = 1;\n");

    await eventually(id, (d) => assert.deepEqual(touched(d), ["create:new.ts", "modify:dist/bundle.js"]));
    await settle();
    assert.deepEqual(touched((await store.load(id))!), ["create:new.ts", "modify:dist/bundle.js"]);
  }, 20000);

  it("skips the same untracked folders in git sync, keeping tracked files inside them", async () => {
    const { repoDir, git } = await makeRepo("sync-deps");
    await mkdir(path.join(repoDir, "dist"));
    await writeFile(path.join(repoDir, "dist", "bundle.js"), "1;\n");
    await git("add", ".");
    await git("commit", "-qm", "commit the bundle");
    await mkdir(path.join(repoDir, "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(repoDir, "node_modules", "left-pad", "index.js"), "1;\n");
    await writeFile(path.join(repoDir, "dist", "bundle.js"), "2;\n");
    await writeFile(path.join(repoDir, "new.ts"), "export const n = 1;\n");

    const changes = await inspectGitChanges(repoDir);
    assert.deepEqual(changes.map((c) => `${c.action}:${c.path}`).sort(), ["create:new.ts", "modify:dist/bundle.js"]);
  }, 20000);

  it("falls back to the built-in ignore list outside git", async () => {
    const dir = path.join(tmpDir, "plain");
    await mkdir(path.join(dir, ".gradle"), { recursive: true });
    const id = await createMindmap({ title: "Plain", workspacePath: dir, initialPlan: [{ label: "Edit", status: "in_progress" }] });
    await settle();
    await writeFile(path.join(dir, ".gradle", "fileHashes.lock"), "x");
    await writeFile(path.join(dir, "main.py"), "print(1)\n");

    await eventually(id, (d) => assert.deepEqual(Object.values(d.nodes).flatMap((n) => n.files).map((f) => `${f.action}:${f.path}`), ["create:main.py"]));
    await settle();
    assert.deepEqual(Object.values((await store.load(id))!.nodes).flatMap((n) => n.files).map((f) => f.path), ["main.py"]);
  }, 20000);

  it("collapses a branch switch into one activity entry instead of file touches", async () => {
    const { repoDir, git } = await makeRepo("switch");
    const id = await createMindmap({ title: "Switch", workspacePath: repoDir, initialPlan: [{ label: "Work", status: "in_progress" }] });
    await settle();
    await git("checkout", "-q", "other");

    const doc = await eventually(id, (d) => assert.match(d.activityLog.map((e) => e.message).join("\n"), /^Git checkout: moving from .* to other/m));
    assert.deepEqual(Object.values(doc.nodes).flatMap((n) => n.files), []);

    // An edit right after the switch differs from HEAD, so it still counts
    await writeFile(path.join(repoDir, "a.ts"), "export const a = 3;\n");
    await eventually(id, (d) => assert.deepEqual(Object.values(d.nodes).flatMap((n) => n.files).map((f) => `${f.action}:${f.path}`), ["modify:a.ts"]));
  }, 30000);

  it("keeps edits after a branch switch when watching a subdirectory of the repo", async () => {
    const { repoDir, git } = await makeRepo("subdir");
    const id = await createMindmap({ title: "Subdir", workspacePath: path.join(repoDir, "pkg"), initialPlan: [{ label: "Work", status: "in_progress" }] });
    await settle();
    await git("checkout", "-q", "other");
    await writeFile(path.join(repoDir, "pkg", "c.ts"), "export const c = 2;\n");

    await eventually(id, (d) => assert.deepEqual(Object.values(d.nodes).flatMap((n) => n.files).map((f) => `${f.action}:${f.path}`), ["modify:c.ts"]));
  }, 30000);
  it("records into the mindmap last used for the workspace, not every mindmap that watched it", async () => {
    const { repoDir } = await makeRepo("shared");
    const first = await createMindmap({ title: "First", workspacePath: repoDir, initialPlan: [{ label: "Old work", status: "in_progress" }] });
    const second = await createMindmap({ title: "Second", workspacePath: repoDir, initialPlan: [{ label: "New work", status: "in_progress" }] });
    await settle();
    await writeFile(path.join(repoDir, "a.ts"), "export const a = 2;\n");
    await eventually(second, (d) => assert.deepEqual(touched(d), ["modify:a.ts"]));

    // A tool call on the first mindmap makes it the one being worked on again
    await callTool("add_node", { mindmapId: first, parentId: "root", label: "Back to it" });
    await writeFile(path.join(repoDir, "b.ts"), "export const b = 2;\n");
    await eventually(first, (d) => assert.deepEqual(touched(d), ["modify:b.ts"]));
    await settle();
    assert.deepEqual(touched((await store.load(first))!), ["modify:b.ts"], "the first mindmap never got the second one's edit");
    assert.deepEqual(touched((await store.load(second))!), ["modify:a.ts"], "nor the other way round");
  }, 30000);

  it("stops recording into a mindmap once it is archived", async () => {
    const { repoDir } = await makeRepo("archived");
    const id = await createMindmap({ title: "Archived", workspacePath: repoDir, initialPlan: [{ label: "Work", status: "in_progress" }] });
    await settle();
    await store.setArchived(id, true);
    await writeFile(path.join(repoDir, "a.ts"), "export const a = 2;\n");
    // The archive happens in the viewer's process, so the watcher finds out when it next has changes to record
    await eventually(id, () => assert.equal(watchedMindmap(repoDir), undefined));
    assert.deepEqual(touched((await store.load(id))!), []);
  }, 30000);

  it("stops watching when its mindmap is deleted", async () => {
    const { repoDir } = await makeRepo("deleted");
    const id = await createMindmap({ title: "Deleted", workspacePath: repoDir });
    assert.equal(watchedMindmap(repoDir), id);
    await callTool("delete_mindmap", { mindmapId: id });
    assert.equal(watchedMindmap(repoDir), undefined);
  });

  it("drops a deleted mindmap's unrecorded edits instead of giving them to the next mindmap", async () => {
    const { repoDir } = await makeRepo("replaced");
    const first = await createMindmap({ title: "First", workspacePath: repoDir, initialPlan: [{ label: "Work", status: "in_progress" }] });
    await settle();
    // An edit the first watcher has seen but not recorded yet (batches wait 600 ms)
    await writeFile(path.join(repoDir, "a.ts"), "export const a = 2;\n");
    await new Promise((r) => setTimeout(r, 300));
    await callTool("delete_mindmap", { mindmapId: first });
    const second = await createMindmap({ title: "Second", workspacePath: repoDir, initialPlan: [{ label: "Work", status: "in_progress" }] });
    await settle();
    assert.deepEqual(touched((await store.load(second))!), []);
  }, 30000);

  it("stops watching a mindmap's old workspace when it moves to another one", async () => {
    const { repoDir: oldDir } = await makeRepo("moved-from");
    const { repoDir: newDir } = await makeRepo("moved-to");
    const id = await createMindmap({ title: "Moved", workspacePath: oldDir, initialPlan: [{ label: "Work", status: "in_progress" }] });
    await writeFile(path.join(newDir, "a.ts"), "export const a = 2;\n"); // so sync_git_status has a change to save
    await callTool("sync_git_status", { mindmapId: id, workspacePath: newDir });
    assert.equal(watchedMindmap(newDir), id);
    assert.equal(watchedMindmap(oldDir), undefined);
  }, 30000);

  it("starts watching when a tool changes a mindmap an earlier server process created", async () => {
    const { repoDir } = await makeRepo("restarted");
    // Stored by an earlier MCP server process, so nothing in this one watches it yet
    const doc = emptyDoc("mm_restarted", "Earlier");
    doc.workspacePath = repoDir;
    addChild(doc, { type: "task", label: "Work", status: "in_progress" });
    await store.save(doc);

    await callTool("add_node", { mindmapId: doc.id, parentId: "root", label: "Next" });
    await settle();
    await writeFile(path.join(repoDir, "a.ts"), "export const a = 2;\n");
    await eventually(doc.id, (d) => assert.deepEqual(touched(d), ["modify:a.ts"]));
  }, 30000);
});
