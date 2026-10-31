import { describe, it, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import * as store from "../src/store.js";
import { RENDER_FORMATS } from "../src/renderer.js";
import { tools, type ToolResult } from "../src/tools.js";
import { stopWorkspaceWatcher, watchedMindmap } from "../src/watcher.js";
import { isTask } from "../src/model/kinds.js";
import { z } from "zod";
import { MindmapDocument, MindmapId, NodeId, ROOT_ID, type FileTouch, type MindmapNode, type TaskNode } from "../src/model/schema.js";
import { emptyDoc } from "./fixtures.js";

const execFileAsync = promisify(execFile);

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `Tool "${name}" should exist`);
  return tool.handler(args);
}
const textOf = (result: ToolResult) => result.content[0]?.text ?? "";

/** Calls a tool that must succeed and returns its text. */
async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await callTool(name, args);
  assert.ok(!result.isError, `${name} failed: ${textOf(result)}`);
  return textOf(result);
}
/** Calls a tool that must fail and returns its error message. */
async function fails(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await callTool(name, args);
  assert.equal(result.isError, true, `${name} should have failed but returned: ${textOf(result).slice(0, 200)}`);
  return textOf(result);
}
/** A node as an acknowledgement reports it. */
const NodeRef = z.object({ id: NodeId, label: z.string(), type: z.string(), parent: NodeId.nullable(), status: z.string().optional() });
/** The compact acknowledgement of a tool that changes a mindmap (the fields these tests read). */
const Ack = z.object({
  mindmapId: MindmapId,
  summary: z.string(),
  hint: z.string().optional(),
  node: NodeRef.optional(),
  fileNode: NodeRef.optional(),
  nodes: z.array(NodeRef).optional(),
});
/** Calls a tool that changes a mindmap and returns its compact acknowledgement. */
const ackFrom = async (name: string, args: Record<string, unknown>) => Ack.parse(JSON.parse(await ok(name, args)));
/** Calls a tool, then reads back the whole document with get_mindmap (which must be a valid document). */
async function docFrom(name: string, args: Record<string, unknown>): Promise<MindmapDocument> {
  const reply: unknown = JSON.parse(await ok(name, args));
  return MindmapDocument.parse(name === "get_mindmap" ? reply : JSON.parse(await ok("get_mindmap", { mindmapId: Ack.parse(reply).mindmapId })));
}

function nodeOf(doc: MindmapDocument, id: NodeId | undefined): MindmapNode {
  const node = id && doc.nodes[id];
  assert.ok(node, `node ${id} should exist`);
  return node;
}
function taskOf(doc: MindmapDocument, id: NodeId | undefined): TaskNode {
  const node = nodeOf(doc, id);
  assert.ok(isTask(node), `${node.label} should be a task`);
  return node;
}
const childrenOf = (doc: MindmapDocument, id: NodeId = ROOT_ID) => nodeOf(doc, id).children;
const changesOf = (f: FileTouch | undefined) => (!f || f.action === "read" ? [] : f.changes);

/** Stops the repo's watcher first, or it could flush after the data directory has been restored. */
async function removeRepo(repoDir: string): Promise<void> {
  const watched = watchedMindmap(repoDir);
  if (watched) stopWorkspaceWatcher(watched);
  await rm(repoDir, { recursive: true, force: true });
}

describe("MCP tools integration", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    originalDataDir = process.env.SYNAPSE_DATA_DIR;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "synapse-tools-test-"));
    process.env.SYNAPSE_DATA_DIR = tmpDir;
  });

  afterAll(async () => {
    if (originalDataDir === undefined) delete process.env.SYNAPSE_DATA_DIR;
    else process.env.SYNAPSE_DATA_DIR = originalDataDir;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("bootstraps initialPlan, tracks file touches, transitions statuses, and generates plan summaries", async () => {
    const doc = await docFrom("create_mindmap", {
      title: "Feature X",
      initialPlan: [
        {
          label: "Step 1: Design schema",
          status: "in_progress",
          notes: "Define core interfaces",
          children: [{ label: "Substep 1a: Validate types", status: "planned" }],
        },
        { label: "Step 2: Implement API", status: "planned" },
      ],
    });
    assert.ok(doc.id.startsWith("mm_"));
    const [step1Id, step2Id] = childrenOf(doc);
    assert.equal(taskOf(doc, step1Id).status, "in_progress");
    assert.equal(childrenOf(doc, step1Id).length, 1);

    // Without nodeId the touch attaches to the active in_progress task
    const afterTouch = await docFrom("log_file_touch", {
      mindmapId: doc.id,
      path: "src/schema.ts",
      action: "create",
      lines: "1-50",
      symbols: ["UserSchema"],
      summary: "Created UserSchema definition",
      createChildNode: true,
    });
    const step1 = nodeOf(afterTouch, step1Id);
    assert.deepEqual(step1.files.map((f) => f.path), ["src/schema.ts"]);
    assert.equal(step1.children.length, 2, "also created a child file node");

    const afterStatus = await docFrom("update_plan_status", {
      mindmapId: doc.id,
      nodeId: step1Id,
      status: "completed",
      notes: "Schema finalized",
      nextNodeId: step2Id,
    });
    assert.equal(taskOf(afterStatus, step1Id).status, "completed");
    assert.equal(taskOf(afterStatus, step1Id).notes, "Schema finalized");
    assert.equal(taskOf(afterStatus, step2Id).status, "in_progress");

    const summary = await ok("get_plan_summary", { mindmapId: doc.id });
    assert.match(summary, /Progress: 1\/3 tasks completed \(33%\)/, "the file node is not a task");
    assert.match(summary, /Step 2: Implement API/);
    assert.match(summary, /src\/schema\.ts:1-50/);
  });

  it("supports add_node, update_node, remove_node, list_mindmaps, and delete_mindmap", async () => {
    const doc = await docFrom("create_mindmap", { title: "CRUD Map" });
    const withParent = await docFrom("add_node", { mindmapId: doc.id, parentId: "root", label: "Parent Task", status: "planned" });
    const parentId = childrenOf(withParent)[0];
    const withChild = await docFrom("add_node", { mindmapId: doc.id, parentId, label: "Child Task" });
    const childId = childrenOf(withChild, parentId)[0];

    const updated = await docFrom("update_node", {
      mindmapId: doc.id,
      nodeId: childId,
      label: "Updated Child Task",
      status: "blocked",
      notes: "Waiting on dependency",
    });
    assert.equal(taskOf(updated, childId).label, "Updated Child Task");
    assert.equal(taskOf(updated, childId).status, "blocked");

    // Changing a task into a concept drops its status; changing it back starts it as planned
    const asConcept = await docFrom("update_node", { mindmapId: doc.id, nodeId: childId, type: "risk" });
    assert.equal("status" in nodeOf(asConcept, childId), false);
    const asTask = await docFrom("update_node", { mindmapId: doc.id, nodeId: childId, type: "task" });
    assert.equal(taskOf(asTask, childId).status, "planned");

    assert.match(await fails("remove_node", { mindmapId: doc.id, nodeId: "root" }), /Cannot remove the root node/);

    const afterRemove = await docFrom("remove_node", { mindmapId: doc.id, nodeId: parentId });
    assert.equal(parentId && afterRemove.nodes[parentId], undefined);
    assert.equal(childId && afterRemove.nodes[childId], undefined, "descendants go too");
    assert.equal(childrenOf(afterRemove).length, 0);

    assert.match(await ok("list_mindmaps"), new RegExp(doc.id));
    assert.match(await ok("delete_mindmap", { mindmapId: doc.id }), /deleted/);
    assert.match(await fails("delete_mindmap", { mindmapId: doc.id }), /not found/);
  });

  it("says a damaged mindmap can't be read, rather than that it doesn't exist", async () => {
    const file = path.join(tmpDir, "mm_damaged.json");
    await writeFile(file, "{ not json");
    assert.match(await fails("get_mindmap", { mindmapId: "mm_damaged" }), /can't be read/);
    assert.match(await fails("add_node", { mindmapId: "mm_damaged", parentId: "root", label: "x", type: "task" }), /can't be read/);
    assert.match(await ok("list_mindmaps"), /mm_damaged {2}– {2}can't be read/);
    await ok("delete_mindmap", { mindmapId: "mm_damaged" });
  });

  it("rejects invalid input and impossible requests with isError", async () => {
    const doc = await docFrom("create_mindmap", { title: "Strict", initialPlan: [{ label: "Task", status: "in_progress" }] });
    const taskId = childrenOf(doc)[0];

    assert.match(await fails("get_mindmap", { mindmapId: "mm_missing" }), /not found/);
    assert.match(await fails("get_mindmap", { mindmapId: "../etc/passwd" }), /Invalid input/);
    assert.match(await fails("add_node", { mindmapId: doc.id, parentId: "n_nope", label: "x" }), /Parent node "n_nope" not found/);
    assert.match(await fails("add_node", { mindmapId: doc.id, parentId: "root", label: "x", type: "bogus" }), /Invalid input/);
    assert.match(await fails("log_file_touch", { mindmapId: doc.id, path: "a.ts", action: "rename" }), /previousPath/);
    assert.match(
      await fails("log_file_touch", { mindmapId: doc.id, path: "a.ts", changes: [{ kind: "rename", symbol: "b" }] }),
      /previousSymbol/,
    );

    // Only tasks have a status
    assert.match(
      await fails("add_node", { mindmapId: doc.id, parentId: "root", label: "Gateway", type: "component", status: "completed" }),
      /only plan\/task\/code nodes have a status/,
    );
    const withConcept = await docFrom("add_node", { mindmapId: doc.id, parentId: "root", label: "Gateway", type: "component" });
    const conceptId = childrenOf(withConcept).at(-1);
    assert.match(await fails("update_plan_status", { mindmapId: doc.id, nodeId: conceptId, status: "completed" }), /component node/);
    assert.match(
      await fails("update_plan_status", { mindmapId: doc.id, nodeId: taskId, status: "completed", nextNodeId: conceptId }),
      /component node/,
    );
    assert.equal(taskOf(await docFrom("get_mindmap", { mindmapId: doc.id }), taskId).status, "in_progress", "a failed call changes nothing");
  });

  it("syncs uncommitted git status & diff stats via sync_git_status", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "synapse-git-test-"));
    try {
      const git = (...args: string[]) => execFileAsync("git", args, { cwd: repoDir });
      await git("init");
      await git("config", "user.email", "test@example.com");
      await git("config", "user.name", "Test User");
      const trackedFile = path.join(repoDir, "index.ts");
      await writeFile(trackedFile, "export const a = 1;\n", "utf-8");
      await git("add", "index.ts");
      await git("commit", "-m", "initial");
      await writeFile(trackedFile, "export const a = 2;\nexport const b = 3;\n", "utf-8");
      await writeFile(path.join(repoDir, "new-helper.ts"), "export function help() {}\n", "utf-8");

      const doc = await docFrom("create_mindmap", { title: "Git Sync Map", initialPlan: [{ label: "Edit repo files", status: "in_progress" }] });
      const synced = await docFrom("sync_git_status", { mindmapId: doc.id, workspacePath: repoDir });
      const files = nodeOf(synced, childrenOf(synced)[0]).files;
      assert.equal(files.length, 2);

      const modFile = files.find((f) => f.path === "index.ts");
      assert.equal(modFile?.action, "modify");
      assert.match(modFile?.summary ?? "", /\+2\/-1 lines/);
      assert.equal(files.find((f) => f.path === "new-helper.ts")?.action, "create");
    } finally {
      await removeRepo(repoDir);
    }
  });

  it("records symbol-level changes and file renames, and surfaces them in summaries", async () => {
    const doc = await docFrom("create_mindmap", { title: "Fix token expiry", initialPlan: [{ label: "Fix expiry check", status: "in_progress" }] });
    const stepId = childrenOf(doc)[0];

    await ok("log_file_touch", {
      mindmapId: doc.id,
      path: "src/auth.ts",
      changes: [
        { kind: "fix", symbol: "validateToken", detail: "compare in UTC" },
        { kind: "add", symbol: "isExpired" },
      ],
    });
    // Same kind+symbol replaces; new entries append
    await ok("log_file_touch", {
      mindmapId: doc.id,
      path: "src/auth.ts",
      changes: [
        { kind: "fix", symbol: "validateToken", detail: "compare in UTC, inclusive bound" },
        { kind: "rename", previousSymbol: "checkAuth", symbol: "requireAuth" },
      ],
    });
    // Reading a file afterwards doesn't downgrade the edit
    await ok("log_file_touch", { mindmapId: doc.id, path: "src/auth.ts", action: "read" });
    await ok("log_file_touch", { mindmapId: doc.id, path: "tests/auth-old.test.ts", changes: [{ kind: "test", symbol: "rejects expired tokens" }] });
    const afterRename = await docFrom("log_file_touch", {
      mindmapId: doc.id,
      path: "tests/auth.test.ts",
      action: "rename",
      previousPath: "tests/auth-old.test.ts",
    });

    const files = nodeOf(afterRename, stepId).files;
    assert.equal(files.length, 2, "rename absorbs the entry logged under the old path");

    const auth = files.find((f) => f.path === "src/auth.ts");
    assert.equal(auth?.action, "modify");
    assert.deepEqual(changesOf(auth).map((c) => `${c.kind}:${c.symbol}`), ["fix:validateToken", "add:isExpired", "rename:requireAuth"]);
    assert.equal(changesOf(auth)[0]?.detail, "compare in UTC, inclusive bound");

    const renamed = files.find((f) => f.path === "tests/auth.test.ts");
    assert.ok(renamed?.action === "rename");
    assert.equal(renamed.previousPath, "tests/auth-old.test.ts");
    assert.equal(renamed.changes[0]?.kind, "test");

    // The same change logged on a second node (e.g. an HLD component) is counted once
    const withComponent = await docFrom("add_node", { mindmapId: doc.id, parentId: "root", label: "Auth", type: "component" });
    await ok("log_file_touch", {
      mindmapId: doc.id,
      nodeId: childrenOf(withComponent).at(-1),
      path: "src/auth.ts",
      changes: [{ kind: "fix", symbol: "validateToken" }],
    });

    const summary = await ok("get_plan_summary", { mindmapId: doc.id });
    assert.match(summary, /Code Changes: 1 add, 1 fix, 1 rename, 1 test/);
    assert.equal(summary.match(/fix: `validateToken`/g)?.length, 1);
    assert.match(summary, /fix: `validateToken` — compare in UTC, inclusive bound/);
    assert.match(summary, /tests\/auth-old\.test\.ts → tests\/auth\.test\.ts/);
    assert.match(summary, /rename: `checkAuth → requireAuth`/);

    const text = await ok("render_mindmap", { mindmapId: doc.id, format: "text" });
    assert.match(text, /✱ fix validateToken — compare in UTC, inclusive bound/);
  });

  it("detects staged renames in sync_git_status", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "synapse-git-rename-"));
    try {
      const git = (...args: string[]) => execFileAsync("git", args, { cwd: repoDir });
      await git("init");
      await git("config", "user.email", "test@example.com");
      await git("config", "user.name", "Test User");
      await writeFile(path.join(repoDir, "old.ts"), "export const a = 1;\n", "utf-8");
      await git("add", "old.ts");
      await git("commit", "-m", "initial");
      await git("mv", "old.ts", "new.ts");

      const doc = await docFrom("create_mindmap", { title: "Git Rename Map", initialPlan: [{ label: "Rename module", status: "in_progress" }] });
      const synced = await docFrom("sync_git_status", { mindmapId: doc.id, workspacePath: repoDir });
      const file = nodeOf(synced, childrenOf(synced)[0]).files[0];
      assert.equal(file?.path, "new.ts");
      assert.ok(file?.action === "rename");
      assert.equal(file.previousPath, "old.ts");
    } finally {
      await removeRepo(repoDir);
    }
  });

  it("acknowledges changes compactly and starts a planned task that gets an explicit file touch", async () => {
    const created = await ackFrom("create_mindmap", {
      title: "Compact",
      initialPlan: [{ label: "Step 1", status: "in_progress" }, { label: "Step 2" }],
    });
    const [step1, step2] = created.nodes ?? [];
    assert.deepEqual([step1?.label, step1?.status, step2?.label, step2?.status], ["Step 1", "in_progress", "Step 2", "planned"]);
    assert.ok(step2);

    const added = await ackFrom("add_node", { mindmapId: created.mindmapId, parentId: "root", label: "Step 3" });
    assert.equal(added.node?.label, "Step 3");
    assert.equal(added.node?.status, "planned");

    // Make the document big; acknowledgements stay small
    for (let i = 0; i < 50; i++) await ok("log_file_touch", { mindmapId: created.mindmapId, path: `src/file${i}.ts`, summary: "x".repeat(200) });
    const touched = await ackFrom("log_file_touch", {
      mindmapId: created.mindmapId,
      nodeId: step2.id,
      path: "src/b.ts",
      summary: "y".repeat(5000),
      createChildNode: true,
    });
    assert.ok(JSON.stringify(touched).length < 1000, "the agent's own summary isn't echoed back");
    assert.equal(touched.node?.id, step2.id);
    assert.deepEqual([touched.fileNode?.type, touched.fileNode?.label, touched.fileNode?.parent], ["file", "src/b.ts", step2.id]);
    assert.equal(touched.node?.status, "in_progress", "a planned task that gets a touch has started");
    assert.match(touched.hint ?? "", /Also in_progress: "Step 1"/);

    const doc = await docFrom("get_mindmap", { mindmapId: created.mindmapId });
    assert.ok(JSON.stringify(doc).length > 10_000);
    assert.equal(taskOf(doc, step2.id).status, "in_progress");
  });

  it("keeps every change when calls on one mindmap overlap", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "synapse-git-test-"));
    try {
      const git = (...args: string[]) => execFileAsync("git", args, { cwd: repoDir });
      await git("init");
      await writeFile(path.join(repoDir, "untracked.ts"), "export {};\n", "utf-8");
      const created = await ackFrom("create_mindmap", { title: "Busy", workspacePath: repoDir, initialPlan: [{ label: "Step", status: "in_progress" }] });
      const mindmapId = created.mindmapId;

      // sync_git_status waits on git between reading and writing the mindmap, the widest window for a lost update
      await Promise.all([
        ok("sync_git_status", { mindmapId }),
        ...Array.from({ length: 10 }, (_, i) => ok("log_file_touch", { mindmapId, path: `src/f${i}.ts` })),
        ...Array.from({ length: 5 }, (_, i) => ok("add_node", { mindmapId, parentId: "root", label: `Added ${i}` })),
      ]);

      const doc = await docFrom("get_mindmap", { mindmapId });
      const paths = nodeOf(doc, created.nodes?.[0]?.id).files.map((f) => f.path).sort();
      assert.deepEqual(paths, [...Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`), "untracked.ts"].sort());
      assert.equal(Object.values(doc.nodes).filter((n) => n.label.startsWith("Added ")).length, 5);

      // A target removed while sync_git_status waits on git is an error, not a reason to attach elsewhere
      const targetId = (await ackFrom("add_node", { mindmapId, parentId: "root", label: "Target" })).node?.id;
      assert.ok(targetId);
      const [synced] = await Promise.all([
        callTool("sync_git_status", { mindmapId, targetNodeId: targetId }),
        ok("remove_node", { mindmapId, nodeId: targetId }),
      ]);
      assert.equal(synced.isError, true);
      assert.match(textOf(synced), /not found/);
    } finally {
      await removeRepo(repoDir);
    }
  });

  it("maps HLD mental model concepts and directed flow links via map_architecture and link_nodes", async () => {
    const doc = await docFrom("create_mindmap", { title: "Mental Model Test" });
    const afterHld = await docFrom("map_architecture", {
      mindmapId: doc.id,
      nodes: [
        { key: "api", label: "API Gateway", type: "component", notes: "Handles incoming requests", files: [{ path: "src/api.ts", action: "read" }] },
        { key: "worker", label: "Event Stream", type: "data_flow", notes: "Publishes SSE events" },
        { key: "dec1", label: "Keep TypeScript over Rust", type: "decision", parentKey: "api", notes: "Sub-ms JSON I/O; LLM latency dominates" },
      ],
      links: [{ from: "api", to: "worker", label: "emits events to", style: "animated" }],
    });
    assert.equal(afterHld.links.length, 1);
    assert.equal(afterHld.links[0]?.label, "emits events to");
    assert.equal(afterHld.links[0]?.style, "animated");

    // Moving an existing node keeps the tree consistent (it used to stay listed under its old parent)
    const workerId = Object.values(afterHld.nodes).find((n) => n.label === "Event Stream")?.id;
    const apiId = Object.values(afterHld.nodes).find((n) => n.label === "API Gateway")?.id;
    const moved = await docFrom("map_architecture", {
      mindmapId: doc.id,
      nodes: [{ key: workerId, label: "Event Stream", type: "data_flow", parentKey: apiId }],
    });
    assert.equal(nodeOf(moved, workerId).parent, apiId);
    assert.equal(Object.values(moved.nodes).filter((n) => workerId && n.children.includes(workerId)).length, 1);
    assert.match(
      await fails("map_architecture", { mindmapId: doc.id, nodes: [{ key: apiId, label: "API Gateway", parentKey: workerId }] }),
      /own descendant/,
    );

    const rendered = await ok("render_mindmap", { mindmapId: doc.id, format: "text" });
    assert.match(rendered, /📦 API Gateway/);
    assert.match(rendered, /⚖️ Keep TypeScript over Rust/);
    assert.match(rendered, /──\[emits events to\]──▶/);

    const flowchart = await ok("render_mindmap", { mindmapId: doc.id, format: "mermaid-flowchart" });
    assert.match(flowchart, /^flowchart LR/);
    assert.match(flowchart, /==>\|"emits events to"\|/);
    assert.match(await fails("render_mindmap", { mindmapId: doc.id, format: "svg" }), /Invalid input/);
  });

  it("names every render format in render_mindmap's description, which is all an agent sees", () => {
    const description = tools.find((t) => t.name === "render_mindmap")?.description ?? "";
    for (const format of RENDER_FORMATS) assert.ok(description.includes(`${format} (`) || description.includes(`or ${format}`), format);
  });

  it("clears an existing node's notes with an empty string in map_architecture, and keeps them when omitted", async () => {
    const doc = await docFrom("create_mindmap", { title: "Notes" });
    const mapped = await ackFrom("map_architecture", { mindmapId: doc.id, nodes: [{ key: "api", label: "API", notes: "Handles requests" }] });
    const apiId = mapped.nodes?.find((n) => n.label === "API")?.id;
    assert.ok(apiId);

    const kept = await docFrom("map_architecture", { mindmapId: doc.id, nodes: [{ key: apiId, label: "API v2" }] });
    assert.equal(nodeOf(kept, apiId).notes, "Handles requests");
    const cleared = await docFrom("map_architecture", { mindmapId: doc.id, nodes: [{ key: apiId, label: "API v2", notes: "" }] });
    assert.equal(nodeOf(cleared, apiId).notes, "");
  });

  it("removes links by id, or by from and to with an optional label, via unlink_nodes", async () => {
    const created = await ackFrom("create_mindmap", { title: "Links", initialPlan: [{ label: "A" }, { label: "B" }, { label: "C" }] });
    const { mindmapId } = created;
    const [a, b, c] = created.nodes ?? [];
    assert.ok(a && b && c);
    for (const [from, to, label] of [[a, b, "calls?"], [a, b, "streams SSE to"], [a, b, "reads"], [b, a, "calls?"], [a, c, "calls?"]] as const) {
      await ok("link_nodes", { mindmapId, from: from.id, to: to.id, label });
    }
    const labels = (doc: MindmapDocument) => doc.links.map((l) => `${nodeOf(doc, l.from).label}→${nodeOf(doc, l.to).label} ${l.label}`);

    // With a label, only that link goes: not its siblings, not the one going the other way, and not one to another node
    const byLabel = await docFrom("unlink_nodes", { mindmapId, from: a.id, to: b.id, label: "calls?" });
    assert.deepEqual(labels(byLabel), ["A→B streams SSE to", "A→B reads", "B→A calls?", "A→C calls?"]);
    assert.equal(byLabel.activityLog[0]?.message, 'Unlinked "A" ──[calls?]──▶ "B"');
    assert.equal(byLabel.activityLog[0]?.nodeId, a.id);

    const byId = await docFrom("unlink_nodes", { mindmapId, linkId: byLabel.links[0]?.id });
    assert.deepEqual(labels(byId), ["A→B reads", "B→A calls?", "A→C calls?"]);

    await ok("link_nodes", { mindmapId, from: a.id, to: b.id, label: "writes" });
    const all = await docFrom("unlink_nodes", { mindmapId, from: a.id, to: b.id });
    assert.deepEqual(labels(all), ["B→A calls?", "A→C calls?"], "without a label, every link in that direction goes");
    assert.equal(all.activityLog[0]?.message, 'Unlinked "A" ──[reads, writes]──▶ "B"');

    // Nothing matched: an error that says what was looked for, and nothing changes
    assert.match(await fails("unlink_nodes", { mindmapId, linkId: "l_missing" }), /No link "l_missing" found/);
    assert.match(await fails("unlink_nodes", { mindmapId, from: a.id, to: b.id }), new RegExp(`No link from "${a.id}" to "${b.id}" found`));
    assert.match(await fails("unlink_nodes", { mindmapId, from: b.id, to: a.id, label: "nope" }), /labeled "nope"/);
    assert.deepEqual(labels(await docFrom("get_mindmap", { mindmapId })), ["B→A calls?", "A→C calls?"]);

    // Exactly one way of saying which links
    for (const args of [{}, { from: a.id }, { to: b.id }, { label: "calls?" }, { from: a.id, label: "calls?" }, { linkId: "l_x", from: a.id, to: b.id }, { linkId: "l_x", label: "x" }]) {
      assert.match(await fails("unlink_nodes", { mindmapId, ...args }), /Give either linkId, or from and to/, JSON.stringify(args));
    }
  });

  it("removes file touches from a node with removeFiles on update_node", async () => {
    const created = await ackFrom("create_mindmap", { title: "Files", initialPlan: [{ label: "Step", status: "in_progress" }] });
    const { mindmapId } = created;
    const nodeId = created.nodes?.[0]?.id;
    await ok("log_file_touch", { mindmapId, nodeId, path: "src/wrong.ts" });
    await ok("log_file_touch", { mindmapId, nodeId, path: "src/right.ts", changes: [{ kind: "fix", symbol: "f" }] });
    await ok("log_file_touch", { mindmapId, nodeId, path: "src/other.ts" });
    const paths = (doc: MindmapDocument) => nodeOf(doc, nodeId).files.map((f) => f.path);

    const removed = await docFrom("update_node", { mindmapId, nodeId, removeFiles: ["src/wrong.ts", "src/other.ts"] });
    assert.deepEqual(paths(removed), ["src/right.ts"]);
    assert.match(removed.activityLog[0]?.message ?? "", /removed 2 file touch/);
    assert.equal(nodeOf(removed, nodeId).id, nodeId, "the node itself stays");

    // A path the node doesn't have is an error, and the whole call changes nothing
    assert.match(
      await fails("update_node", { mindmapId, nodeId, label: "Renamed", removeFiles: ["src/right.ts", "src/nope.ts"] }),
      /no file touch for: src\/nope\.ts/,
    );
    const unchanged = await docFrom("get_mindmap", { mindmapId });
    assert.deepEqual(paths(unchanged), ["src/right.ts"]);
    assert.equal(nodeOf(unchanged, nodeId).label, "Step");

    // Removal runs first, so a path in both starts afresh (merged, a read wouldn't replace an edit)
    const replaced = await docFrom("update_node", { mindmapId, nodeId, removeFiles: ["src/right.ts"], files: [{ path: "src/right.ts", action: "read" }] });
    assert.equal(nodeOf(replaced, nodeId).files[0]?.action, "read");
  });

  it("moves a node and its subtree with parentId on update_node", async () => {
    const created = await ackFrom("create_mindmap", {
      title: "Move",
      initialPlan: [{ label: "A", children: [{ label: "A1" }] }, { label: "B" }],
    });
    const { mindmapId } = created;
    const byLabel = (label: string) => created.nodes?.find((n) => n.label === label)?.id;
    const [a, a1, b] = [byLabel("A"), byLabel("A1"), byLabel("B")];
    assert.ok(a && a1 && b);

    // Under the current parent: not an error, and it doesn't change the order of the siblings
    const stayed = await ackFrom("update_node", { mindmapId, nodeId: a, parentId: "root" });
    assert.doesNotMatch(stayed.summary, /moved/);
    assert.deepEqual(childrenOf(await docFrom("get_mindmap", { mindmapId })), [a, b]);

    // Moves that would cut a subtree off from the root
    assert.match(await fails("update_node", { mindmapId, nodeId: a, parentId: a }), /under itself/);
    assert.match(await fails("update_node", { mindmapId, nodeId: a, parentId: a1 }), /own descendant "A1"/);
    assert.match(await fails("update_node", { mindmapId, nodeId: a, parentId: "n_nope" }), /Parent node "n_nope" not found/);
    assert.match(await fails("update_node", { mindmapId, nodeId: "root", parentId: b }), /root node can't be changed/);
    assert.match(await fails("update_node", { mindmapId, nodeId: a, label: "Half done", parentId: a1 }), /own descendant/);
    assert.equal(nodeOf(await docFrom("get_mindmap", { mindmapId }), a).label, "A", "a failed move changes nothing");

    const movedAck = await ackFrom("update_node", { mindmapId, nodeId: a, parentId: b });
    assert.equal(movedAck.node?.parent, b);
    assert.match(movedAck.summary, /moved under "B"/);
    const moved = await docFrom("get_mindmap", { mindmapId });
    assert.equal(nodeOf(moved, a).parent, b);
    assert.deepEqual(childrenOf(moved), [b]);
    assert.deepEqual(childrenOf(moved, b), [a]);
    assert.deepEqual(childrenOf(moved, a), [a1], "the subtree moves with it");

    // A retype replaces the node object; the move has to land on the new one
    const retyped = await docFrom("update_node", { mindmapId, nodeId: a1, type: "risk", parentId: "root" });
    assert.deepEqual([nodeOf(retyped, a1).type, nodeOf(retyped, a1).parent], ["risk", ROOT_ID]);
    assert.deepEqual(childrenOf(retyped), [b, a1]);
    assert.deepEqual(childrenOf(retyped, a), []);
  });

  it("filters list_mindmaps by workspace and repository, and can leave out archived mindmaps", async () => {
    const mine = { workspacePath: "/code/app", repoPath: "/code/app" };
    const main = { ...emptyDoc("mm_list_main", "Main checkout"), ...mine };
    const tree = { ...emptyDoc("mm_list_tree", "Worktree"), workspacePath: "/code/app/.claude/worktrees/x", repoPath: "/code/app" };
    const old = { ...emptyDoc("mm_list_old", "Archived"), ...mine };
    const other = { ...emptyDoc("mm_list_other", "Other repo"), workspacePath: "/code/other" };
    const docs = [main, tree, old, other];
    for (const doc of docs) await store.save(doc);
    await store.setArchived(old.id, true);
    const listed = async (args: Record<string, unknown> = {}) => [...(await ok("list_mindmaps", args)).matchAll(/mm_list_\w+/g)].map(([id]) => id).sort();

    try {
      assert.deepEqual(await listed(), [old.id, main.id, other.id, tree.id].sort(), "no filters: everything, as before");
      assert.match(await ok("list_mindmaps"), /mm_list_old .*, archived\)/);
      assert.deepEqual(await listed({ includeArchived: true }), await listed());
      assert.deepEqual(await listed({ includeArchived: false }), [main.id, other.id, tree.id].sort());

      assert.deepEqual(await listed({ workspacePath: "/code/app" }), [old.id, main.id, tree.id].sort(), "repoPath matches its worktrees too");
      assert.deepEqual(await listed({ workspacePath: "/code/app/.claude/worktrees/x" }), [tree.id], "workspacePath matches on its own");
      assert.deepEqual(await listed({ workspacePath: "/code/other" }), [other.id], "a mindmap without a repoPath still matches");
      assert.deepEqual(await listed({ workspacePath: "/code/app/" }), await listed({ workspacePath: "/code/app" }), "a trailing slash is the same path");
      assert.deepEqual(await listed({ workspacePath: "/code/app", includeArchived: false }), [main.id, tree.id].sort());

      assert.equal(await ok("list_mindmaps", { workspacePath: "/code/app/x" }), "No mindmaps match.");
      assert.match(await fails("list_mindmaps", { workspacePath: "" }), /Invalid input/);

      // Nothing says which workspace a damaged file belongs to, so a filter can't rule it out
      const damaged = path.join(tmpDir, "mm_list_damaged.json");
      await writeFile(damaged, "{ not json");
      assert.match(await ok("list_mindmaps", { workspacePath: "/code/other", includeArchived: false }), /mm_list_damaged {2}– {2}can't be read/);
      await rm(damaged);
    } finally {
      await Promise.all(docs.map((d) => store.remove(d.id)));
    }
  });
});
