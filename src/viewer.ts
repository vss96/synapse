/**
 * HTTP + SSE server for the Synapse live mindmap viewer.
 * Serves the viewer page, a JSON API over the mindmap store, and live update events.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { errorCode } from "./errors.js";
import * as store from "./store.js";
import { fileTouchTarget, upsertFileTouches } from "./model/file-touch.js";
import { MindmapId, type MindmapList } from "./model/schema.js";
import { inspectGitChanges, repoRoot } from "./watcher.js";

export const DEFAULT_VIEWER_PORT = 4040;
/** Ports tried after the default before letting the OS pick one. */
const PORT_SEARCH_RANGE = 20;
const HOST = "127.0.0.1";

// src/viewer.ts and dist/viewer.js both sit one level below the package root.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: path.join(PACKAGE_ROOT, "viewer", "index.html"), type: "text/html; charset=utf-8" },
  "/app.js": { file: path.join(PACKAGE_ROOT, "dist", "web", "app.js"), type: "text/javascript; charset=utf-8" },
  "/logo.png": { file: path.join(PACKAGE_ROOT, "docs", "public", "logo.png"), type: "image/png" },
  "/favicon.png": { file: path.join(PACKAGE_ROOT, "docs", "public", "favicon.png"), type: "image/png" },
};

/** The files the viewer serves that don't exist, relative to the package root (e.g. a build that skipped the bundle). */
export function missingAssets(files: Record<string, { file: string }> = STATIC_FILES): string[] {
  return Object.values(files)
    .filter((asset) => !existsSync(asset.file))
    .map((asset) => path.relative(PACKAGE_ROOT, asset.file));
}

export interface ViewerOptions {
  /** Port to listen on. Defaults to 4040, moving to the next free port when it is taken. */
  port?: number;
  /** Fail instead of moving to another port when `port` is taken. */
  strictPort?: boolean;
}

export interface RunningViewer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(JSON.stringify(body));
}

/**
 * The viewer is a local tool: only answer requests addressed to localhost (blocks DNS rebinding)
 * and only accept writes from our own page (blocks cross-site requests from other websites).
 */
function isTrustedRequest(req: IncomingMessage, port: number): boolean {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  if (!allowedHosts.has(req.headers.host ?? "")) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.origin;
  return origin === undefined || allowedHosts.has(origin.replace(/^http:\/\//, ""));
}

const SyncGitRequest = z.object({ mindmapId: MindmapId, workspacePath: z.string().optional() });
const ArchiveRequest = z.object({ mindmapId: MindmapId, archived: z.boolean() });

/** Remembered per workspace: the list is read after every change, and a workspace stays in its repository. */
const repoRoots = new Map<string, Promise<string | undefined>>();

/** The session list. Mindmaps saved before `repoPath` existed don't have one, so look it up for them. */
async function listWithRepos(): Promise<MindmapList> {
  const list = await store.list();
  const mindmaps = await Promise.all(
    list.mindmaps.map(async (m) => {
      if (m.repoPath || !m.workspacePath) return m;
      const root = repoRoots.get(m.workspacePath) ?? repoRoot(m.workspacePath);
      repoRoots.set(m.workspacePath, root);
      return { ...m, repoPath: await root };
    }),
  );
  return { ...list, mindmaps };
}

/** Read a JSON request body, or answer the request with an error and return undefined. */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    sendJson(res, 415, { error: "Expected application/json" });
    return undefined;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    sendJson(res, 400, { error: "Body must be JSON" });
    return undefined;
  }
}

async function handleGitSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const json = await readJsonBody(req, res);
  if (json === undefined) return;
  const request = SyncGitRequest.safeParse(json);
  if (!request.success) return sendJson(res, 400, { error: "A valid mindmapId is required" });
  const { mindmapId, workspacePath } = request.data;

  const loaded = await store.load(mindmapId);
  if (!loaded) return sendJson(res, 404, { error: "Mindmap not found" });

  const repoPath = workspacePath || loaded.workspacePath;
  if (!repoPath) return sendJson(res, 400, { error: "This mindmap has no workspacePath to sync from" });

  // Ask git first: store.update holds the mindmap's lock only for the quick change itself.
  const changes = await inspectGitChanges(repoPath);
  if (changes.length === 0) return sendJson(res, 200, { synced: 0, mindmap: loaded });
  const doc = await store.update(mindmapId, (doc) => {
    const target = fileTouchTarget(doc);
    upsertFileTouches(target, changes);
    store.recordActivity(doc, `Synced ${changes.length} changed file(s) from git into "${target.label}"`, {
      nodeId: target.id,
    });
    return doc;
  });
  if (!doc) return sendJson(res, 404, { error: "Mindmap not found" });
  sendJson(res, 200, { synced: changes.length, mindmap: doc });
}

async function handleArchive(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const json = await readJsonBody(req, res);
  if (json === undefined) return;
  const request = ArchiveRequest.safeParse(json);
  if (!request.success) return sendJson(res, 400, { error: "A valid mindmapId and archived flag are required" });
  const doc = await store.setArchived(request.data.mindmapId, request.data.archived);
  if (!doc) return sendJson(res, 404, { error: "Mindmap not found" });
  sendJson(res, 200, { id: doc.id, archivedAt: doc.archivedAt ?? null });
}

/** Watch the data directory and tell connected pages which mindmap changed. */
function watchMindmaps(dataDir: string, onChange: (id: string) => void): FSWatcher | null {
  // Debounce per file so concurrent sessions don't swallow each other's updates.
  const pending = new Map<string, NodeJS.Timeout>();
  try {
    return watch(dataDir, (_event, filename) => {
      const name = filename?.toString();
      if (!name || !name.endsWith(".json")) return;
      clearTimeout(pending.get(name));
      pending.set(
        name,
        setTimeout(() => {
          pending.delete(name);
          onChange(name.replace(/\.json$/, ""));
        }, 80),
      );
    });
  } catch (err) {
    console.error("[synapse viewer] Warning: could not watch data directory:", err);
    return null;
  }
}

function acceptsConnections(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

/**
 * Binding alone can't tell whether a port is free: macOS lets us bind 127.0.0.1:<port> while another
 * server listens on the wildcard address, and browsers may send `localhost` to ::1 first. So a port
 * counts as taken when anything answers on either loopback address.
 */
async function listen(server: Server, port: number): Promise<number> {
  if (port !== 0) {
    const answered = await Promise.all(["127.0.0.1", "::1"].map((host) => acceptsConnections(host, port)));
    if (answered.some(Boolean)) {
      throw Object.assign(new Error(`Port ${port} is already in use`), { code: "EADDRINUSE" });
    }
  }
  return listenIPv4(server, port);
}

function listenIPv4(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

/** Try `start`, then the next ports, then any free port. */
async function listenOnFreePort(server: Server, start: number): Promise<number> {
  for (let port = start; port < start + PORT_SEARCH_RANGE; port++) {
    try {
      return await listen(server, port);
    } catch (err) {
      if (errorCode(err) !== "EADDRINUSE") throw err;
    }
  }
  return listen(server, 0);
}

export async function startViewer(options: ViewerOptions = {}): Promise<RunningViewer> {
  // Without these the page loads but stays on its empty state, which looks like "no mindmaps yet".
  const missing = missingAssets();
  if (missing.length > 0) {
    throw new Error(`viewer files are missing: ${missing.join(", ")}. Rebuild with "npm run build".`);
  }

  const dataDir = await store.ensureDataDir();
  const sseClients = new Set<ServerResponse>();
  let port = 0;

  const broadcast = (event: Record<string, unknown>) => {
    const payload = `data: ${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n\n`;
    for (const client of sseClients) client.write(payload);
  };
  const watcher = watchMindmaps(dataDir, (id) => broadcast({ type: "mindmap_updated", id }));

  const server = createServer(async (req, res) => {
    try {
      if (!isTrustedRequest(req, port)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }
      const { pathname } = new URL(req.url ?? "/", `http://${HOST}`);

      if (pathname === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      if (pathname === "/api/mindmaps" && req.method === "GET") {
        return sendJson(res, 200, await listWithRepos());
      }
      if (pathname.startsWith("/api/mindmaps/") && req.method === "GET") {
        const id = MindmapId.safeParse(decodeURIComponent(pathname.slice("/api/mindmaps/".length)));
        const doc = id.success ? await store.load(id.data) : null;
        return doc ? sendJson(res, 200, doc) : sendJson(res, 404, { error: "Mindmap not found" });
      }
      if (pathname === "/api/sync-git" && req.method === "POST") {
        return await handleGitSync(req, res);
      }
      if (pathname === "/api/archive" && req.method === "POST") {
        return await handleArchive(req, res);
      }

      const asset = STATIC_FILES[pathname === "/index.html" ? "/" : pathname];
      if (!asset || req.method !== "GET") {
        res.writeHead(404);
        return res.end("Not found");
      }
      const content = await readFile(asset.file);
      res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-cache" });
      res.end(content);
    } catch (err) {
      console.error(`[synapse viewer] ${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      else res.end();
    }
  });

  try {
    port = options.strictPort
      ? await listen(server, options.port ?? DEFAULT_VIEWER_PORT)
      : await listenOnFreePort(server, options.port ?? DEFAULT_VIEWER_PORT);
  } catch (err) {
    watcher?.close();
    throw err;
  }

  return {
    url: `http://localhost:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        watcher?.close();
        for (const client of sseClients) client.end();
        server.close(() => resolve());
      }),
  };
}
