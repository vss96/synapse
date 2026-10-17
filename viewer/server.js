#!/usr/bin/env bun
/**
 * HTTP + SSE server that serves the Synapse live mindmap viewer,
 * the mindmap data directory, and real-time file change events.
 * Run with: bun viewer/server.js
 */

import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectGitChanges, resolveTargetNodeForFile, upsertNodeFileTouch } from "../src/watcher.ts";
import { recordActivity } from "../src/store.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = __dirname;
const DATA_DIR = path.resolve(process.env.SYNAPSE_DATA_DIR || path.join(__dirname, "..", "data"));
const PORT = parseInt(process.env.PORT || "4040", 10);

if (!existsSync(DATA_DIR)) {
  await mkdir(DATA_DIR, { recursive: true });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/* ------------------------------------------------------------------ */
/*  SSE Live-Reload Broadcast                                          */
/* ------------------------------------------------------------------ */

const sseClients = new Set();

function broadcastSSE(eventData) {
  const payload = `data: ${JSON.stringify(eventData)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Debounce per file so concurrent sessions don't swallow each other's updates.
const watchDebounce = new Map();
try {
  watch(DATA_DIR, (eventType, filename) => {
    if (!filename || !filename.endsWith(".json")) return;
    clearTimeout(watchDebounce.get(filename));
    watchDebounce.set(filename, setTimeout(() => {
      watchDebounce.delete(filename);
      broadcastSSE({
        type: "mindmap_updated",
        id: filename.replace(/\.json$/, ""),
        filename,
        timestamp: new Date().toISOString(),
      });
    }, 80));
  });
} catch (err) {
  console.error("[synapse viewer] Warning: could not watch data directory:", err);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function serveFile(res, filePath, mime) {
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function serveDirectory(res, dirPath, prefix) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const items = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => `<a href="${prefix}/${encodeURIComponent(e.name)}">${e.name}</a>`);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<pre>${items.join("\n")}</pre>`);
  } catch {
    res.writeHead(500);
    res.end("Error listing directory");
  }
}

// Mirrors the viewer's task counting: HLD concepts, files and notes are not plan tasks.
const NON_TASK_TYPES = new Set(["file", "note", "component", "data_flow", "hypothesis", "decision", "risk"]);

async function listMindmapsMetadata() {
  const entries = await readdir(DATA_DIR, { withFileTypes: true });
  const list = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(DATA_DIR, entry.name), "utf-8");
      const doc = JSON.parse(raw);
      const nodes = Object.values(doc.nodes || {});
      const tasks = nodes.filter((n) => n.id !== "root" && !NON_TASK_TYPES.has(n.type));
      const completedTasks = tasks.filter((n) => n.status === "completed").length;
      const activeTask = tasks
        .filter((n) => n.status === "in_progress")
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
      const fileSet = new Set();
      for (const n of nodes) {
        for (const f of n.files || []) {
          if (f.path) fileSet.add(f.path);
        }
      }
      list.push({
        id: doc.id,
        title: doc.title || doc.id,
        updatedAt: doc.updatedAt || doc.createdAt || "",
        createdAt: doc.createdAt || "",
        workspacePath: doc.workspacePath || null,
        nodeCount: nodes.length,
        completedTasks,
        totalTasks: tasks.length,
        activeTask: activeTask ? activeTask.label : null,
        fileCount: fileSet.size,
      });
    } catch {
      // skip invalid json
    }
  }
  list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return list;
}

async function handleGitSync(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  const { mindmapId, workspacePath: overridePath } = JSON.parse(body || "{}");
  if (!mindmapId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "mindmapId is required" }));
  }

  const file = path.join(DATA_DIR, `${mindmapId}.json`);
  if (!existsSync(file)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Mindmap not found" }));
  }

  const doc = JSON.parse(await readFile(file, "utf-8"));
  const repoPath = overridePath || doc.workspacePath || path.resolve(__dirname, "..");

  const changes = await inspectGitChanges(repoPath);
  if (changes.length > 0) {
    const target = resolveTargetNodeForFile(doc);
    for (const ch of changes) upsertNodeFileTouch(target, ch);
    recordActivity(doc, `Synced ${changes.length} changed file(s) from git into "${target.label}"`, {
      nodeId: target.id,
    });
    doc.updatedAt = new Date().toISOString();
    await writeFile(file, JSON.stringify(doc, null, 2), "utf-8");
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ synced: changes.length, mindmap: doc }));
}

/* ------------------------------------------------------------------ */
/*  HTTP Server                                                        */
/* ------------------------------------------------------------------ */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let p = url.pathname;

  // ── Route: /events → SSE live updates ──
  if (p === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // ── Route: /api/mindmaps → JSON list with rich metadata ──
  if (p === "/api/mindmaps" && req.method === "GET") {
    const list = await listMindmapsMetadata();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(JSON.stringify(list));
  }

  // ── Route: /api/sync-git → trigger git status sync ──
  if (p === "/api/sync-git" && req.method === "POST") {
    try {
      return await handleGitSync(req, res);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: String(err) }));
    }
  }

  // ── Route: /data/ → serve the data directory ──
  if (p === "/data/" || p === "/data") {
    return serveDirectory(res, DATA_DIR, "/data");
  }

  if (p.startsWith("/data/")) {
    const relPath = decodeURIComponent(p.slice("/data/".length));
    const filePath = path.join(DATA_DIR, relPath);
    if (!filePath.startsWith(DATA_DIR)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    const ext = path.extname(filePath).toLowerCase();
    return serveFile(res, filePath, MIME[ext] || "application/octet-stream");
  }

  // ── Route: all other paths → serve from viewer directory ──
  if (p === "/") p = "/index.html";
  const filePath = path.join(VIEWER_DIR, p);
  if (!filePath.startsWith(VIEWER_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  const ext = path.extname(filePath).toLowerCase();
  return serveFile(res, filePath, MIME[ext] || "application/octet-stream");
});

server.listen(PORT, () => {
  console.error(`[synapse viewer] http://localhost:${PORT}`);
});