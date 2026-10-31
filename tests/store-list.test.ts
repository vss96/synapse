import { describe, it, beforeAll, afterAll, afterEach, expect, spyOn } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as store from "../src/store.js";
import { MindmapId } from "../src/model/schema.js";
import { emptyDoc } from "./fixtures.js";

describe("listing stored mindmaps", () => {
  let tmpDir: string;
  const savedDataDir = process.env.SYNAPSE_DATA_DIR;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "synapse-list-test-"));
    process.env.SYNAPSE_DATA_DIR = tmpDir;
  });

  afterAll(async () => {
    if (savedDataDir === undefined) delete process.env.SYNAPSE_DATA_DIR;
    else process.env.SYNAPSE_DATA_DIR = savedDataDir;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Each test counts what's listed, so a failure mustn't leave files for the next one.
  afterEach(async () => {
    await Promise.all((await readdir(tmpDir)).map((name) => rm(path.join(tmpDir, name), { force: true })));
  });

  // Whole seconds: a file's own mtime can be finer than the milliseconds a Date holds, so it couldn't be put back exactly.
  const EARLIER = new Date("2026-01-01T00:00:00Z");
  const LATER = new Date("2026-01-01T00:00:05Z");

  /** Rewrites a stored file without changing its size, then sets its mtime. */
  async function retitle(file: string, from: string, to: string, mtime: Date) {
    expect(to.length).toBe(from.length);
    await writeFile(file, (await readFile(file, "utf-8")).replaceAll(from, to));
    await utimes(file, mtime, mtime);
  }

  it("reads a file again only when its mtime or size changed", async () => {
    await store.save(emptyDoc("mm_cached", "Before"));
    const file = path.join(tmpDir, "mm_cached.json");
    await utimes(file, EARLIER, EARLIER);
    await store.list();

    await retitle(file, "Before", "Sneaky", EARLIER);
    expect((await store.list()).mindmaps.find((m) => m.id === "mm_cached")?.title).toBe("Before");

    await retitle(file, "Sneaky", "Edited", LATER);
    expect((await store.list()).mindmaps.find((m) => m.id === "mm_cached")?.title).toBe("Edited");
  });

  it("stops listing a removed file and keeps reporting an unreadable one", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeFile(path.join(tmpDir, "mm_broken.json"), "{ nope");
      await store.save(emptyDoc("mm_gone", "Gone"));
      expect(await store.list()).toMatchObject({ mindmaps: [{ id: "mm_gone" }], unreadable: [{ id: "mm_broken" }] });
      expect((await store.list()).unreadable).toMatchObject([{ id: "mm_broken" }]);

      await store.remove(MindmapId.parse("mm_gone"));
      await rm(path.join(tmpDir, "mm_broken.json"));
      expect(await store.list()).toEqual({ mindmaps: [], unreadable: [] });
    } finally {
      logged.mockRestore();
    }
  });

  // Permissions don't stop root, so a test run as root can't see this.
  it.skipIf(process.getuid?.() === 0)("notices a file becoming unreadable and readable again, which leaves its mtime alone", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const file = path.join(tmpDir, "mm_perms.json");
    try {
      await store.save(emptyDoc("mm_perms", "Perms"));
      expect((await store.list()).mindmaps).toHaveLength(1);

      await chmod(file, 0o000);
      expect(await store.list()).toMatchObject({ mindmaps: [], unreadable: [{ id: "mm_perms" }] });

      await chmod(file, 0o644);
      expect(await store.list()).toMatchObject({ mindmaps: [{ id: "mm_perms" }], unreadable: [] });
    } finally {
      await chmod(file, 0o644);
      await store.remove(MindmapId.parse("mm_perms"));
      logged.mockRestore();
    }
  });

  it("summarizes one file: a mindmap, an unreadable file, or nothing", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await store.save(emptyDoc("mm_one", "One"));
      await writeFile(path.join(tmpDir, "mm_bad.json"), "[]");

      expect(await store.summaryOf("mm_one")).toMatchObject({ id: "mm_one", title: "One" });
      const bad = await store.summaryOf("mm_bad");
      expect(bad && store.isUnreadable(bad)).toBe(true);
      expect(await store.summaryOf("mm_missing")).toBeNull();

      await store.remove(MindmapId.parse("mm_one"));
      expect(await store.summaryOf("mm_one")).toBeNull();
      await rm(path.join(tmpDir, "mm_bad.json"));
    } finally {
      logged.mockRestore();
    }
  });

  it("lists more files than it reads at once", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `mm_many${i}`);
    await Promise.all(ids.map((id) => store.save(emptyDoc(id, id))));
    expect((await store.list()).mindmaps.map((m): string => m.id).sort()).toEqual([...ids].sort());
    await Promise.all(ids.map((id) => store.remove(MindmapId.parse(id))));
  });

  it("doesn't let a write under way bring back a removed mindmap", async () => {
    const id = MindmapId.parse("mm_race");
    await store.save(emptyDoc(id, "Race"));
    await Promise.all([store.update(id, (doc) => (doc.title = "Changed")), store.remove(id)]);
    expect(await store.load(id)).toBeNull();
  });

  it("writes once and bumps updatedAt only when something changed", async () => {
    const id = MindmapId.parse("mm_stamp");
    await store.save(emptyDoc(id, "Stamp"));
    const before = await store.load(id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.update(id, () => {});
    expect((await store.load(id))?.updatedAt).toBe(before?.updatedAt);

    await store.update(id, (doc) => (doc.title = "Stamped"));
    const after = await store.load(id);
    expect(after?.title).toBe("Stamped");
    expect(after?.updatedAt).not.toBe(before?.updatedAt);
    await store.remove(id);
  });
});
