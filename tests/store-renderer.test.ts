import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as store from "../src/store.js";
import { render } from "../src/renderer.js";
import type { MindmapDocument } from "../src/types.js";

describe("store & renderer", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  before(async () => {
    originalDataDir = process.env.SYNAPSE_DATA_DIR;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "synapse-store-test-"));
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

  it("saves, loads, lists, and removes mindmap documents", async () => {
    const doc1: MindmapDocument = {
      id: "mm_test0001",
      title: "First Map",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: {
        root: { id: "root", label: "First Map", children: [], parent: null },
      },
    };

    await store.save(doc1);
    const loaded = await store.load("mm_test0001");
    assert.ok(loaded);
    assert.equal(loaded.title, "First Map");

    const items = await store.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "mm_test0001");
    assert.equal(items[0].nodeCount, 1);

    const removed = await store.remove("mm_test0001");
    assert.equal(removed, true);
    assert.equal(await store.load("mm_test0001"), null);
  });

  it("caps activityLog at 100 entries with newest first", () => {
    const doc: MindmapDocument = {
      id: "mm_act",
      title: "Activity Test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: { root: { id: "root", label: "Root", children: [], parent: null } },
    };

    for (let i = 1; i <= 110; i++) {
      store.recordActivity(doc, `Event ${i}`, { nodeId: "root" });
    }

    assert.equal(doc.activityLog?.length, 100);
    assert.equal(doc.activityLog?.[0].message, "Event 110");
    assert.equal(doc.activityLog?.[99].message, "Event 11");
  });

  it("renders mermaid, text, and json formats with status badges and file touches", () => {
    const doc: MindmapDocument = {
      id: "mm_render",
      title: "Auth Plan",
      workspacePath: "/repo/app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: {
        root: {
          id: "root",
          label: "Auth Plan",
          children: ["n_step1"],
          parent: null,
        },
        n_step1: {
          id: "n_step1",
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
            },
          ],
          children: [],
          parent: "root",
        },
      },
    };

    const textOut = render(doc, { format: "text" });
    assert.match(textOut, /# Auth Plan \(mm_render\)/);
    assert.match(textOut, /\[~\] Implement JWT middleware \[n_step1\]/);
    assert.match(textOut, /Validate Bearer header/);
    assert.match(textOut, /\[MODIFY\] src\/auth\.ts:10-45 \(verifyJwt\) — Added token verification/);

    const mermaidOut = render(doc, { format: "mermaid" });
    assert.match(mermaidOut, /^mindmap/);
    assert.match(mermaidOut, /n_step1\(~ Implement JWT middleware\)/);
    assert.match(mermaidOut, /\(MODIFY src\/auth\.ts:10-45\)/);

    const jsonOut = JSON.parse(render(doc, { format: "json" }));
    assert.equal(jsonOut.id, "mm_render");
  });
});
