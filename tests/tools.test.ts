import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { tools } from "../src/tools.js";
import type { MindmapDocument } from "../src/types.js";

const execFileAsync = promisify(execFile);

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `Tool "${name}" should exist`);
  const res = await tool.handler(args);
  return res.content[0].text;
}

describe("MCP tools integration", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  before(async () => {
    originalDataDir = process.env.SYNAPSE_DATA_DIR;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "synapse-tools-test-"));
    process.env.SYNAPSE_DATA_DIR = tmpDir;
  });

  after(async () => {
    if (originalDataDir === undefined) {
      delete process.env.SYNAPSE_DATA_DIR;
    } else {
      process.env.SYNAPSE_DATA_DIR = originalDataDir;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("bootstraps initialPlan, tracks file touches, transitions statuses, and generates plan summaries", async () => {
    const raw = await callTool("create_mindmap", {
      title: "Feature X",
      initialPlan: [
        {
          label: "Step 1: Design schema",
          status: "in_progress",
          notes: "Define core interfaces",
          children: [{ label: "Substep 1a: Validate types", status: "planned" }],
        },
        {
          label: "Step 2: Implement API",
          status: "planned",
        },
      ],
    });

    const doc = JSON.parse(raw) as MindmapDocument;
    assert.ok(doc.id.startsWith("mm_"));
    assert.equal(doc.nodes.root.children.length, 2);

    const [step1Id, step2Id] = doc.nodes.root.children;
    assert.equal(doc.nodes[step1Id].status, "in_progress");
    assert.equal(doc.nodes[step1Id].children.length, 1);

    // Log file touch without specifying nodeId -> should attach to active in_progress node (step1Id)
    const afterTouchRaw = await callTool("log_file_touch", {
      mindmapId: doc.id,
      path: "src/schema.ts",
      action: "create",
      lines: "1-50",
      symbols: ["UserSchema"],
      summary: "Created UserSchema definition",
      createChildNode: true,
    });
    const afterTouchDoc = JSON.parse(afterTouchRaw) as MindmapDocument;
    assert.equal(afterTouchDoc.nodes[step1Id].files?.length, 1);
    assert.equal(afterTouchDoc.nodes[step1Id].files?.[0].path, "src/schema.ts");
    // Also created a child file node
    assert.equal(afterTouchDoc.nodes[step1Id].children.length, 2);

    // Transition step1 -> completed and step2 -> in_progress
    const afterStatusRaw = await callTool("update_plan_status", {
      mindmapId: doc.id,
      nodeId: step1Id,
      status: "completed",
      notes: "Schema finalized",
      nextNodeId: step2Id,
    });
    const afterStatusDoc = JSON.parse(afterStatusRaw) as MindmapDocument;
    assert.equal(afterStatusDoc.nodes[step1Id].status, "completed");
    assert.equal(afterStatusDoc.nodes[step1Id].notes, "Schema finalized");
    assert.equal(afterStatusDoc.nodes[step2Id].status, "in_progress");

    // Check get_plan_summary output
    const summary = await callTool("get_plan_summary", { mindmapId: doc.id });
    assert.match(summary, /Progress: 1\/3 tasks completed \(33%\)/);
    assert.match(summary, /Step 2: Implement API/);
    assert.match(summary, /src\/schema\.ts:1-50/);
  });

  it("supports add_node, update_node, remove_node, list_mindmaps, and delete_mindmap", async () => {
    const doc = JSON.parse(await callTool("create_mindmap", { title: "CRUD Map" })) as MindmapDocument;

    // Add parent & child node
    const withParent = JSON.parse(
      await callTool("add_node", {
        mindmapId: doc.id,
        parentId: "root",
        label: "Parent Task",
        status: "planned",
      }),
    ) as MindmapDocument;
    const parentId = withParent.nodes.root.children[0];

    const withChild = JSON.parse(
      await callTool("add_node", {
        mindmapId: doc.id,
        parentId,
        label: "Child Task",
      }),
    ) as MindmapDocument;
    const childId = withChild.nodes[parentId].children[0];

    // Update node
    const updated = JSON.parse(
      await callTool("update_node", {
        mindmapId: doc.id,
        nodeId: childId,
        label: "Updated Child Task",
        status: "blocked",
        notes: "Waiting on dependency",
      }),
    ) as MindmapDocument;
    assert.equal(updated.nodes[childId].label, "Updated Child Task");
    assert.equal(updated.nodes[childId].status, "blocked");

    // Prevent removing root
    const rootRemoveMsg = await callTool("remove_node", {
      mindmapId: doc.id,
      nodeId: "root",
    });
    assert.match(rootRemoveMsg, /Cannot remove the root node/);

    // Remove parent -> should also remove child recursively
    const afterRemove = JSON.parse(
      await callTool("remove_node", {
        mindmapId: doc.id,
        nodeId: parentId,
      }),
    ) as MindmapDocument;
    assert.equal(afterRemove.nodes[parentId], undefined);
    assert.equal(afterRemove.nodes[childId], undefined);
    assert.equal(afterRemove.nodes.root.children.length, 0);

    // List and delete
    const listText = await callTool("list_mindmaps");
    assert.match(listText, new RegExp(doc.id));

    const delText = await callTool("delete_mindmap", { mindmapId: doc.id });
    assert.match(delText, /deleted/);
  });

  it("syncs uncommitted git status & diff stats via sync_git_status", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "synapse-git-test-"));
    try {
      await execFileAsync("git", ["init"], { cwd: repoDir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoDir });

      const trackedFile = path.join(repoDir, "index.ts");
      await writeFile(trackedFile, "export const a = 1;\n", "utf-8");
      await execFileAsync("git", ["add", "index.ts"], { cwd: repoDir });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoDir });

      // Modify tracked file and create untracked file
      await writeFile(trackedFile, "export const a = 2;\nexport const b = 3;\n", "utf-8");
      await writeFile(path.join(repoDir, "new-helper.ts"), "export function help() {}\n", "utf-8");

      const doc = JSON.parse(
        await callTool("create_mindmap", {
          title: "Git Sync Map",
          initialPlan: [{ label: "Edit repo files", status: "in_progress" }],
        }),
      ) as MindmapDocument;

      const syncedDoc = JSON.parse(
        await callTool("sync_git_status", {
          mindmapId: doc.id,
          workspacePath: repoDir,
        }),
      ) as MindmapDocument;

      const activeId = syncedDoc.nodes.root.children[0];
      const files = syncedDoc.nodes[activeId].files || [];
      assert.equal(files.length, 2);

      const modFile = files.find((f) => f.path === "index.ts");
      const newFile = files.find((f) => f.path === "new-helper.ts");
      assert.ok(modFile);
      assert.equal(modFile.action, "modify");
      assert.match(modFile.summary || "", /\+2\/-1 lines/);

      assert.ok(newFile);
      assert.equal(newFile.action, "create");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("records symbol-level changes and file renames, and surfaces them in summaries", async () => {
    const doc = JSON.parse(
      await callTool("create_mindmap", {
        title: "Fix token expiry",
        initialPlan: [{ label: "Fix expiry check", status: "in_progress" }],
      }),
    ) as MindmapDocument;
    const stepId = doc.nodes.root.children[0];

    await callTool("log_file_touch", {
      mindmapId: doc.id,
      path: "src/auth.ts",
      changes: [
        { kind: "fix", symbol: "validateToken", detail: "compare in UTC" },
        { kind: "add", symbol: "isExpired" },
      ],
    });
    // Same kind+symbol replaces; new entries append
    await callTool("log_file_touch", {
      mindmapId: doc.id,
      path: "src/auth.ts",
      changes: [
        { kind: "fix", symbol: "validateToken", detail: "compare in UTC, inclusive bound" },
        { kind: "rename", previousSymbol: "checkAuth", symbol: "requireAuth" },
      ],
    });
    await callTool("log_file_touch", {
      mindmapId: doc.id,
      path: "tests/auth-old.test.ts",
      changes: [{ kind: "test", symbol: "rejects expired tokens" }],
    });
    const afterRename = JSON.parse(
      await callTool("log_file_touch", {
        mindmapId: doc.id,
        path: "tests/auth.test.ts",
        action: "rename",
        previousPath: "tests/auth-old.test.ts",
      }),
    ) as MindmapDocument;

    const files = afterRename.nodes[stepId].files || [];
    assert.equal(files.length, 2, "rename absorbs the entry logged under the old path");

    const auth = files.find((f) => f.path === "src/auth.ts")!;
    assert.deepEqual(
      auth.changes?.map((c) => `${c.kind}:${c.symbol}`),
      ["fix:validateToken", "add:isExpired", "rename:requireAuth"],
    );
    assert.equal(auth.changes?.[0].detail, "compare in UTC, inclusive bound");

    const renamed = files.find((f) => f.path === "tests/auth.test.ts")!;
    assert.equal(renamed.action, "rename");
    assert.equal(renamed.previousPath, "tests/auth-old.test.ts");
    assert.equal(renamed.changes?.[0].kind, "test");

    const summary = await callTool("get_plan_summary", { mindmapId: doc.id });
    assert.match(summary, /Code Changes: 1 add, 1 fix, 1 rename, 1 test/);
    assert.match(summary, /tests\/auth-old\.test\.ts → tests\/auth\.test\.ts/);
    assert.match(summary, /rename: `checkAuth → requireAuth`/);

    const text = await callTool("render_mindmap", { mindmapId: doc.id, format: "text" });
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

      const doc = JSON.parse(
        await callTool("create_mindmap", {
          title: "Git Rename Map",
          initialPlan: [{ label: "Rename module", status: "in_progress" }],
        }),
      ) as MindmapDocument;
      const synced = JSON.parse(
        await callTool("sync_git_status", { mindmapId: doc.id, workspacePath: repoDir }),
      ) as MindmapDocument;

      const file = synced.nodes[synced.nodes.root.children[0]].files?.[0];
      assert.equal(file?.path, "new.ts");
      assert.equal(file?.action, "rename");
      assert.equal(file?.previousPath, "old.ts");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("maps HLD mental model concepts and directed flow links via map_architecture and link_nodes", async () => {
    const doc = JSON.parse(
      await callTool("create_mindmap", { title: "Mental Model Test" }),
    ) as MindmapDocument;

    const afterHld = JSON.parse(
      await callTool("map_architecture", {
        mindmapId: doc.id,
        nodes: [
          {
            key: "api",
            label: "API Gateway",
            type: "component",
            notes: "Handles incoming requests",
            files: [{ path: "src/api.ts", action: "read" }],
          },
          {
            key: "worker",
            label: "Event Stream",
            type: "data_flow",
            notes: "Publishes SSE events",
          },
          {
            key: "dec1",
            label: "Keep TypeScript over Rust",
            type: "decision",
            parentKey: "api",
            notes: "Sub-ms JSON I/O; LLM latency dominates",
          },
        ],
        links: [
          {
            from: "api",
            to: "worker",
            label: "emits events to",
            style: "animated",
          },
        ],
      }),
    ) as MindmapDocument;

    assert.equal(afterHld.links?.length, 1);
    assert.equal(afterHld.links?.[0].label, "emits events to");
    assert.equal(afterHld.links?.[0].style, "animated");

    // Verify rendered text includes the directed flow link and semantic icons
    const rendered = await callTool("render_mindmap", {
      mindmapId: doc.id,
      format: "text",
    });
    assert.match(rendered, /📦 API Gateway/);
    assert.match(rendered, /⚖️ Keep TypeScript over Rust/);
    assert.match(rendered, /──\[emits events to\]──▶/);
  });
});

