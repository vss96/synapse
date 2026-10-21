import { describe, it, beforeAll, afterAll, expect, spyOn } from "bun:test";
import { createServer, request, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as store from "../src/store.js";
import { MindmapId } from "../src/model/schema.js";
import { missingAssets, startViewer, type RunningViewer } from "../src/viewer.js";
import { addChild, emptyDoc } from "./fixtures.js";

/** Raw HTTP so tests can set Host/Origin like a browser on another site would. */
function call(
  port: number,
  { method = "GET", path: urlPath = "/", headers = {}, body }: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path: urlPath, headers: { host: `localhost:${port}`, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function occupy(port = 0): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server is not listening on a TCP port");
  return address.port;
}
const close = (server: Server) => new Promise((resolve) => server.close(resolve));

describe("viewer server", () => {
  let tmpDir: string;
  let viewer: RunningViewer;
  const savedDataDir = process.env.SYNAPSE_DATA_DIR;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "synapse-viewer-test-"));
    process.env.SYNAPSE_DATA_DIR = tmpDir;
    const doc = emptyDoc("mm_test", "Viewer test");
    addChild(doc, { type: "task", label: "Step", status: "in_progress" });
    addChild(doc, { type: "component", label: "Gateway" });
    await store.save(doc);
    const free = await occupy();
    const port = portOf(free);
    await close(free);
    viewer = await startViewer({ port, strictPort: true });
  });

  afterAll(async () => {
    await viewer.close();
    if (savedDataDir === undefined) delete process.env.SYNAPSE_DATA_DIR;
    else process.env.SYNAPSE_DATA_DIR = savedDataDir;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("moves to the next free port when the requested one is taken, unless the port is strict", async () => {
    const taken = await occupy();
    const port = portOf(taken);
    try {
      const other = await startViewer({ port });
      expect(other.port).not.toBe(port);
      await other.close();
      await expect(startViewer({ port, strictPort: true })).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await close(taken);
    }
  });

  it("serves the session list and single mindmaps", async () => {
    const list = await call(viewer.port, { path: "/api/mindmaps" });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toMatchObject([{ id: "mm_test", totalTasks: 1, activeTask: "Step" }]);

    const doc = await call(viewer.port, { path: "/api/mindmaps/mm_test" });
    expect(JSON.parse(doc.body).title).toBe("Viewer test");
    expect((await call(viewer.port, { path: "/api/mindmaps/..%2F..%2Fsecret" })).status).toBe(404);
  });

  it("rejects requests from other hosts and cross-site writes", async () => {
    const sync = (headers: Record<string, string>, body = JSON.stringify({ mindmapId: "mm_test" })) =>
      call(viewer.port, { method: "POST", path: "/api/sync-git", headers, body });

    expect((await call(viewer.port, { path: "/api/mindmaps", headers: { host: "attacker.example" } })).status).toBe(403);
    expect((await sync({ "content-type": "application/json", origin: "https://attacker.example" })).status).toBe(403);
    expect((await sync({ "content-type": "text/plain" })).status).toBe(415);
    expect((await sync({ "content-type": "application/json" }, JSON.stringify({ mindmapId: "../../x" }))).status).toBe(400);
    // No workspacePath on this mindmap, so a legitimate request is refused without touching git.
    expect((await sync({ "content-type": "application/json", origin: `http://localhost:${viewer.port}` })).status).toBe(400);
  });

  it("archives and restores sessions, refusing cross-site and invalid requests", async () => {
    const archive = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
      call(viewer.port, { method: "POST", path: "/api/archive", headers, body: JSON.stringify(body) });

    const res = await archive({ mindmapId: "mm_test", archived: true });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).archivedAt).toBeString();
    const list = JSON.parse((await call(viewer.port, { path: "/api/mindmaps" })).body);
    expect(list[0].archivedAt).toBeString();

    expect(JSON.parse((await archive({ mindmapId: "mm_test", archived: false })).body)).toEqual({ id: "mm_test", archivedAt: null });
    expect((await archive({ mindmapId: "mm_nope", archived: true })).status).toBe(404);
    expect((await archive({ mindmapId: "mm_test" })).status).toBe(400);
    expect((await archive({ mindmapId: "mm_test", archived: true }, { "content-type": "text/plain" })).status).toBe(415);
    const crossSite = { "content-type": "application/json", origin: "https://attacker.example" };
    expect((await archive({ mindmapId: "mm_test", archived: true }, crossSite)).status).toBe(403);
    expect((await store.load(MindmapId.parse("mm_test")))?.archivedAt).toBeUndefined();
  });

  it("logs requests that fail with a 500", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = JSON.stringify({ mindmapId: "mm_test", workspacePath: path.join(tmpDir, "no-such-dir") });
      const res = await call(viewer.port, { method: "POST", path: "/api/sync-git", headers: { "content-type": "application/json" }, body });
      expect(res.status).toBe(500);
      expect(String(logged.mock.calls[0]?.[0])).toContain("POST /api/sync-git failed");
    } finally {
      logged.mockRestore();
    }
  });

  it("reports the files it serves that are missing", () => {
    expect(missingAssets(), "the test script builds the bundle first").toEqual([]);
    const fake = { "/app.js": { file: path.join(tmpDir, "dist", "web", "app.js") } };
    expect(missingAssets(fake)).toEqual([path.relative(path.resolve(import.meta.dir, ".."), fake["/app.js"].file)]);
  });
});
