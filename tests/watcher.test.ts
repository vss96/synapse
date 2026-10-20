import { describe, it, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { tools } from "../src/tools.js";
import * as store from "../src/store.js";
import { shouldIgnorePath } from "../src/watcher.js";
import { MindmapId, type MindmapDocument } from "../src/model/schema.js";

const execFileAsync = promisify(execFile);

async function createMindmap(args: Record<string, unknown>): Promise<MindmapId> {
  const result = await tools.find((t) => t.name === "create_mindmap")!.handler(args);
  return MindmapId.parse(JSON.parse(result.content[0]!.text).mindmapId);
}

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

  it("skips tool caches only outside git, where no ignore rules apply", () => {
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
    // Not in this repo's .gitignore, so it counts even though it's in the built-in list
    await mkdir(path.join(repoDir, ".idea"));
    await writeFile(path.join(repoDir, ".idea", "workspace.xml"), "x");
    await writeFile(path.join(repoDir, "new.ts"), "export const n = 1;\n");

    const doc = await eventually(id, (d) => {
      const files = Object.values(d.nodes).flatMap((n) => n.files);
      assert.deepEqual(files.map((f) => `${f.action}:${f.path}`).sort(), ["create:.idea/workspace.xml", "create:new.ts", "modify:a.ts"]);
    });
    const step = Object.values(doc.nodes).find((n) => n.label === "Edit")!;
    assert.equal(step.files.length, 3, "attached to the in_progress task");
    await settle();
    const later = (await store.load(id))!;
    assert.deepEqual(Object.values(later.nodes).flatMap((n) => n.files).map((f) => f.path).sort(), [".idea/workspace.xml", "a.ts", "new.ts"]);
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
});
