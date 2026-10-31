/**
 * The viewer page, end to end: the built bundle running against a simulated DOM, with the server's
 * HTTP and live events stubbed. Pure logic has its own tests; these cover the state between the modules.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { z } from "zod";
import { NodeId, now, type MindmapDocument, type MindmapListItem } from "../src/model/schema.js";
import { addChild, emptyDoc } from "./fixtures.js";

const ROOT_DIR = path.resolve(import.meta.dir, "..");
const PAGE = readFileSync(path.join(ROOT_DIR, "viewer", "index.html"), "utf-8");
const BUNDLE = readFileSync(path.join(ROOT_DIR, "dist", "web", "app.js"), "utf-8");

function listItem(doc: MindmapDocument, fields: Partial<MindmapListItem> = {}): MindmapListItem {
  const { id, title, updatedAt, createdAt } = doc;
  const counts = { nodeCount: 1, completedTasks: 0, totalTasks: 0, blockedTasks: 0, fileCount: 0, loggedFileCount: 0, searchText: "" };
  return { id, title, updatedAt, createdAt, ...counts, ...fields };
}

interface Server {
  docs: MindmapDocument[];
  items?: MindmapListItem[];
  unreadable?: { id: string; error: string }[];
  hash?: string;
}

/** The names the bundle reads from its environment, supplied from the simulated window. */
const GLOBALS = [
  "window", "document", "location", "history", "localStorage", "matchMedia", "ResizeObserver", "getComputedStyle", "navigator", "CSS",
  "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "SVGElement", "SVGSVGElement", "InputEvent", "File", "setInterval",
] as const;

const ArchiveBody = z.object({ mindmapId: z.string(), archived: z.boolean() });

const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.abort()));
});

function openViewer({ docs, items, unreadable = [], hash = "" }: Server) {
  const window = new Window({ url: `http://localhost:4040/${hash}` });
  windows.push(window);
  window.document.write(PAGE);

  const requests: string[] = [];
  const archivedCalls: [string, boolean][] = [];
  /** Requests to these URLs wait until `release()` is called. */
  const held = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();
  const server = {
    items: items ?? docs.map((d) => listItem(d)),
    unreadable,
    docs,
    requests,
    archived: archivedCalls,
    /** Sessions the server refuses to archive. */
    refuseArchive: new Set<string>(),
    hold: (url: string) => gates.set(url, new Promise((resolve) => held.set(url, resolve))),
    release: (url: string) => {
      gates.delete(url);
      held.get(url)?.();
    },
  };
  const fetchStub = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    server.requests.push(`${method} ${url}`);
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    // The response is settled now, as the server would; the page just doesn't get it until the gate opens.
    const listed = { mindmaps: server.items, unreadable: server.unreadable };
    await gates.get(url);
    if (url === "/api/mindmaps") return json(listed);
    if (url === "/api/sync-git") return json({ synced: 1, mindmap: server.docs[0] });
    if (method === "DELETE") {
      server.items = server.items.filter((s) => url !== `/api/mindmaps/${s.id}`);
      return json({ deleted: true });
    }
    if (url === "/api/archive") {
      const { mindmapId, archived } = ArchiveBody.parse(JSON.parse(init?.body ?? "{}"));
      if (server.refuseArchive.has(mindmapId)) return json({ error: "Nope" }, 500);
      server.archived.push([mindmapId, archived]);
      server.items = server.items.map((s) => (s.id === mindmapId ? { ...s, archivedAt: archived ? s.updatedAt : undefined } : s));
      return json({ id: mindmapId });
    }
    const doc = server.docs.find((d) => url === `/api/mindmaps/${d.id}`);
    return doc ? json(doc) : json({ error: "Mindmap not found" }, 404);
  };

  const streams: Array<{ onmessage?: (e: { data: string }) => void }> = [];
  class EventSourceStub {
    onopen?: () => void;
    onerror?: () => void;
    onmessage?: (e: { data: string }) => void;
    constructor() {
      streams.push(this);
    }
  }

  const values = [...GLOBALS.map((name) => (name === "window" ? window : Reflect.get(window, name))), fetchStub, EventSourceStub];
  new Function(...GLOBALS, "fetch", "EventSource", BUNDLE)(...values);

  const { document } = window;
  return {
    window,
    document,
    server,
    /** Clicks `selector` the way a mouse does: SVG elements have no click() method. */
    click: (selector: string) => document.querySelector(selector)?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    type(selector: string, value: string) {
      const box = document.querySelector(selector);
      if (!(box instanceof window.HTMLInputElement)) throw new Error(`${selector} is not an input`);
      box.value = value;
      box.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    press: (selector: string, key: string) => document.querySelector(selector)?.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })),
    transform: () => document.querySelector(".scene")?.getAttribute("transform"),
    /** Lets the page's pending requests and renders finish. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
    emit: (event: unknown) => streams[0]?.onmessage?.({ data: JSON.stringify(event) }),
    row: (id: string) => document.querySelector(`.session-item[data-session-id="${id}"]`),
  };
}

function plan(id: string) {
  const doc = emptyDoc(id, `Session ${id}`);
  const parent = addChild(doc, { type: "plan", label: "Phase", status: "in_progress", id: `${id}_phase` });
  addChild(doc, { type: "task", label: "First", id: `${id}_first`, parent: parent.id });
  addChild(doc, { type: "task", label: "Second", id: `${id}_second`, parent: parent.id });
  return doc;
}

describe("viewer page", () => {
  it("opens the first session and marks its cards up for the keyboard", async () => {
    const page = openViewer({ docs: [plan("mm_one")] });
    await page.settle();
    expect(page.window.location.hash).toBe("#mm_one");
    const cards = page.document.querySelectorAll(".node-group");
    expect(cards.length).toBe(4);
    expect(page.document.querySelectorAll('.node-group[tabindex="0"]').length).toBe(1);
    expect(page.document.querySelector("#svg")?.getAttribute("role")).toBe("tree");
    expect(page.document.querySelector(".node-group.selected")?.getAttribute("aria-selected")).toBe("true");
  });

  it("doesn't open a file it can't read, and opens the next session that can be", async () => {
    const page = openViewer({ docs: [] });
    await page.settle();
    page.emit({ type: "mindmap_unreadable", id: "mm_bad", error: "damaged" });
    await page.settle();
    expect(page.window.location.hash).toBe("");
    expect(page.document.querySelector("#sessions-unreadable")?.textContent).toContain("mm_bad");

    const doc = plan("mm_good");
    page.server.docs.push(doc);
    page.emit({ type: "mindmap_updated", id: "mm_good", item: listItem(doc) });
    await page.settle();
    expect(page.window.location.hash).toBe("#mm_good");
    expect(page.document.querySelector("#session-name")?.textContent).toBe("Session mm_good");
  });

  it("updates one row from a live event without reading the whole list again", async () => {
    const [one, two] = [plan("mm_one"), plan("mm_two")];
    const page = openViewer({ docs: [one, two] });
    await page.settle();
    const listReads = () => page.server.requests.filter((r) => r === "GET /api/mindmaps").length;
    const before = listReads();

    page.emit({ type: "mindmap_updated", id: "mm_two", item: listItem(two, { title: "Renamed", blockedTasks: 2 }) });
    await page.settle();
    expect(page.row("mm_two")?.textContent).toContain("Renamed");
    expect(page.row("mm_two")?.textContent).toContain("2 blocked");
    expect(listReads()).toBe(before);

    page.emit({ type: "mindmap_deleted", id: "mm_two" });
    await page.settle();
    expect(page.row("mm_two")).toBeNull();
  });

  it("reads the list again after reconnecting, when events may have been missed", async () => {
    const page = openViewer({ docs: [plan("mm_one")] });
    await page.settle();
    page.emit({ type: "connected" });
    await page.settle();
    const reads = page.server.requests.filter((r) => r === "GET /api/mindmaps").length;
    page.emit({ type: "connected" });
    await page.settle();
    expect(page.server.requests.filter((r) => r === "GET /api/mindmaps").length).toBe(reads + 1);
  });

  it("follows a pasted link to a session the page hasn't heard of yet", async () => {
    const page = openViewer({ docs: [plan("mm_one")] });
    await page.settle();
    page.server.docs.push(plan("mm_new"));
    page.server.items.push(listItem(plan("mm_new")));
    page.window.location.hash = "#mm_new";
    page.window.dispatchEvent(new page.window.Event("hashchange"));
    await page.settle();
    expect(page.window.location.hash).toBe("#mm_new");
    expect(page.document.querySelector("#session-name")?.textContent).toBe("Session mm_new");
  });

  it("puts back the URL for a session that doesn't exist", async () => {
    const page = openViewer({ docs: [plan("mm_one")] });
    await page.settle();
    page.window.location.hash = "#mm_nope";
    page.window.dispatchEvent(new page.window.Event("hashchange"));
    await page.settle();
    expect(page.window.location.hash).toBe("#mm_one");
  });

  it("moves to the neighbour after archiving the open session, and Undo comes back", async () => {
    const page = openViewer({ docs: [plan("mm_one"), plan("mm_two")] });
    await page.settle();
    page.click('.session-item[data-session-id="mm_one"] [data-action="archive"]');
    await page.settle();
    expect(page.window.location.hash).toBe("#mm_two");
    expect(page.server.archived).toEqual([["mm_one", true]]);
    expect(page.document.querySelector("#archived-toggle")?.textContent).toBe("Archived 1");

    page.click(".toast button");
    await page.settle();
    expect(page.server.archived).toEqual([["mm_one", true], ["mm_one", false]]);
    expect(page.window.location.hash).toBe("#mm_one");
  });

  it("archives a group's finished sessions together", async () => {
    const [one, two, three] = [plan("mm_one"), plan("mm_two"), plan("mm_three")];
    const items = [listItem(one, { totalTasks: 1, completedTasks: 1 }), listItem(two, { totalTasks: 1, completedTasks: 1 }), listItem(three)];
    const page = openViewer({ docs: [one, two, three], items });
    await page.settle();
    page.click("[data-archive-finished]");
    await page.settle();
    expect(page.server.archived.map(([id]) => id).sort()).toEqual(["mm_one", "mm_two"]);
    expect(page.document.querySelector(".toast")?.textContent).toContain("Archived 2 sessions");
  });

  it("shows the count while filtering, and finds a session by what's inside it", async () => {
    const [one, two] = [plan("mm_one"), plan("mm_two")];
    const page = openViewer({ docs: [one, two], items: [listItem(one, { searchText: "shedlock contention" }), listItem(two)] });
    await page.settle();
    page.type("#session-search", "shedlock");
    expect(page.document.querySelector("#sessions-count")?.textContent).toBe("Sessions (1 of 2)");
    expect(page.row("mm_two")).toBeNull();
  });

  describe("opening a session with the keyboard", () => {
    const titleLink = (page: ReturnType<typeof openViewer>, id: string) => {
      const link = page.row(id)?.querySelector("a.session-title-text");
      if (!(link instanceof page.window.HTMLElement)) throw new Error(`No title link on ${id}`);
      return link;
    };

    it("makes each title a link to the session, and keeps focus on it after opening", async () => {
      const page = openViewer({ docs: [plan("mm_one"), plan("mm_two")] });
      await page.settle();
      expect(titleLink(page, "mm_two").getAttribute("href")).toBe("#mm_two");
      expect(titleLink(page, "mm_one").getAttribute("aria-current")).toBe("true");
      expect(titleLink(page, "mm_two").hasAttribute("aria-current")).toBe(false);

      titleLink(page, "mm_two").focus();
      titleLink(page, "mm_two").click(); // what Enter does on a link
      await page.settle();
      expect(page.window.location.hash).toBe("#mm_two");
      expect(page.document.querySelector("#session-name")?.textContent).toBe("Session mm_two");
      expect(page.document.activeElement?.getAttribute("data-focus")).toBe("open:mm_two");
      expect(titleLink(page, "mm_two").getAttribute("aria-current")).toBe("true");
    });

    it("leaves a new-tab click on a title to the browser", async () => {
      const page = openViewer({ docs: [plan("mm_one"), plan("mm_two")] });
      await page.settle();
      const opened: string[] = [];
      // happy-dom follows an unhandled link click with window.open, where a browser would open the tab.
      Reflect.set(page.window, "open", (url: string) => opened.push(url));
      const event = new page.window.MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
      titleLink(page, "mm_two").dispatchEvent(event);
      await page.settle();
      expect(opened).toEqual(["http://localhost:4040/#mm_two"]);
      expect(page.document.querySelector("#session-name")?.textContent).toBe("Session mm_one");
    });

    it("hands focus to the sessions button when a keyboard pick closes the drawer", async () => {
      const page = openViewer({ docs: [plan("mm_one"), plan("mm_two")] });
      await page.settle();
      page.document.body.classList.add("sessions-open");
      titleLink(page, "mm_two").focus();
      titleLink(page, "mm_two").click();
      await page.settle();
      expect(page.document.body.classList.contains("sessions-open")).toBe(false);
      expect(page.document.activeElement?.id).toBe("sessions-toggle");
    });
  });

  describe("flat session lists", () => {
    const inRepo = (name: string) => ({ repoPath: `/code/${name}`, workspacePath: `/code/${name}` });
    const order = (page: ReturnType<typeof openViewer>) => [...page.document.querySelectorAll(".session-item")].map((el) => el.getAttribute("data-session-id"));

    /** Newest first across two repositories, so grouping pulls mm_c up beside mm_a, above the newer mm_b. */
    function twoRepos() {
      const [a, b, c] = [plan("mm_a"), plan("mm_b"), plan("mm_c")];
      return openViewer({ docs: [a, b, c], items: [listItem(a, inRepo("one")), listItem(b, { ...inRepo("two"), blockedTasks: 1 }), listItem(c, { ...inRepo("one"), blockedTasks: 1 })] });
    }

    it("shows every session newest first in the Recent view, says which repository each is from, and remembers the choice", async () => {
      const page = twoRepos();
      await page.settle();
      expect(order(page)).toEqual(["mm_a", "mm_c", "mm_b"]);

      page.click("#recent-toggle");
      expect(order(page)).toEqual(["mm_a", "mm_b", "mm_c"]);
      expect(page.document.querySelector(".session-group")).toBeNull();
      expect(page.row("mm_b")?.querySelector(".session-sub")?.textContent).toContain("two");
      expect(page.document.querySelector("#recent-toggle")?.getAttribute("aria-pressed")).toBe("true");
      expect(page.window.localStorage.getItem("synapse.sessionsRecent")).toBe("1");

      page.click("#recent-toggle");
      expect(order(page)).toEqual(["mm_a", "mm_c", "mm_b"]);
      expect(page.window.localStorage.getItem("synapse.sessionsRecent")).toBe("0");
    });

    it("lists text matches flat, newest first", async () => {
      const page = twoRepos();
      await page.settle();
      page.type("#session-search", "session");
      expect(order(page)).toEqual(["mm_a", "mm_b", "mm_c"]);
      expect(page.document.querySelector(".session-group")).toBeNull();
      page.type("#session-search", "");
      expect(page.document.querySelectorAll(".session-group").length).toBe(2);
    });

    it("lists status matches flat, newest first", async () => {
      const page = twoRepos();
      await page.settle();
      page.click('#session-status [data-status="blocked"]');
      expect(order(page)).toEqual(["mm_b", "mm_c"]);
      expect(page.document.querySelector(".session-group")).toBeNull();
    });

    it("says so when a flat list includes an archived session", async () => {
      const [one, two] = [plan("mm_one"), plan("mm_two")];
      const page = openViewer({ docs: [one, two], items: [listItem(one), listItem(two, { archivedAt: two.updatedAt })] });
      await page.settle();
      page.type("#session-search", "mm_two");
      expect(page.row("mm_two")?.classList.contains("archived")).toBe(true);
      expect(page.row("mm_two")?.querySelector(".session-sub")?.textContent).toContain("archived");
      expect(page.row("mm_two")?.querySelector('[data-action="restore"]')).not.toBeNull();
    });
  });

  describe("holding the list still", () => {
    const order = (page: ReturnType<typeof openViewer>) => [...page.document.querySelectorAll(".session-item")].map((el) => el.getAttribute("data-session-id"));
    const list = (page: ReturnType<typeof openViewer>) => {
      const el = page.document.querySelector("#session-list");
      if (!el) throw new Error("No list");
      return el;
    };
    const point = (page: ReturnType<typeof openViewer>, type: "pointerenter" | "pointerleave") => list(page).dispatchEvent(new page.window.Event(type));
    /** An update that makes `id` the newest session, under a new title. */
    const touch = (page: ReturnType<typeof openViewer>, doc: MindmapDocument) =>
      page.emit({ type: "mindmap_updated", id: doc.id, item: listItem(doc, { title: "Touched", updatedAt: new Date(Date.now() + 60_000).toISOString() }) });
    const inRepo = (name: string) => ({ repoPath: `/code/${name}`, workspacePath: `/code/${name}` });

    it("keeps rows where they are while the pointer is over the list, then applies the order", async () => {
      const [one, two, three] = [plan("mm_one"), plan("mm_two"), plan("mm_three")];
      const page = openViewer({ docs: [one, two, three] });
      await page.settle();
      point(page, "pointerenter");
      touch(page, three);
      await page.settle();
      expect(order(page)).toEqual(["mm_one", "mm_two", "mm_three"]);
      expect(page.row("mm_three")?.textContent).toContain("Touched");

      point(page, "pointerleave");
      expect(order(page)).toEqual(["mm_three", "mm_one", "mm_two"]);
    });

    it("keeps groups in place too", async () => {
      const [one, two] = [plan("mm_one"), plan("mm_two")];
      const page = openViewer({ docs: [one, two], items: [listItem(one, inRepo("a")), listItem(two, inRepo("b"))] });
      await page.settle();
      point(page, "pointerenter");
      page.emit({ type: "mindmap_updated", id: "mm_two", item: listItem(two, { ...inRepo("b"), updatedAt: new Date(Date.now() + 60_000).toISOString() }) });
      await page.settle();
      expect(order(page)).toEqual(["mm_one", "mm_two"]);
      point(page, "pointerleave");
      expect(order(page)).toEqual(["mm_two", "mm_one"]);
    });

    it("holds the Recent view and adds a new session at the end", async () => {
      const [one, two] = [plan("mm_one"), plan("mm_two")];
      const page = openViewer({ docs: [one, two] });
      await page.settle();
      page.click("#recent-toggle");
      point(page, "pointerenter");
      const added = plan("mm_new");
      page.server.docs.push(added);
      touch(page, two);
      page.emit({ type: "mindmap_updated", id: "mm_new", item: listItem(added, { updatedAt: new Date(Date.now() + 120_000).toISOString() }) });
      await page.settle();
      expect(order(page)).toEqual(["mm_one", "mm_two", "mm_new"]);

      point(page, "pointerleave");
      expect(order(page)).toEqual(["mm_new", "mm_two", "mm_one"]);
    });

    it("keeps holding after the sessions are read again, as they are after archiving a row", async () => {
      const [one, two, three] = [plan("mm_one"), plan("mm_two"), plan("mm_three")];
      const page = openViewer({ docs: [one, two, three] });
      await page.settle();
      point(page, "pointerenter");
      page.server.items = [listItem(three), listItem(one), listItem(two)];
      page.click("#refresh-btn");
      await page.settle();
      expect(order(page)).toEqual(["mm_one", "mm_two", "mm_three"]);
    });

    it("holds while a row has keyboard focus, through redraws, until focus leaves the list", async () => {
      const [one, two, three] = [plan("mm_one"), plan("mm_two"), plan("mm_three")];
      const page = openViewer({ docs: [one, two, three] });
      await page.settle();
      const link = page.row("mm_two")?.querySelector("a");
      if (!(link instanceof page.window.HTMLElement)) throw new Error("No link");
      link.focus();
      touch(page, three);
      await page.settle();
      touch(page, three);
      await page.settle();
      expect(order(page)).toEqual(["mm_one", "mm_two", "mm_three"]);

      const search = page.document.querySelector("#session-search");
      if (!(search instanceof page.window.HTMLElement)) throw new Error("No search box");
      search.focus();
      await page.settle();
      expect(order(page)).toEqual(["mm_three", "mm_one", "mm_two"]);
    });
  });

  describe("the Activity tab", () => {
    const entries = (page: ReturnType<typeof openViewer>) => [...page.document.querySelectorAll(".activity-item")].map((el) => el.textContent ?? "");
    const toggle = "[data-toggle-file-events]";

    function busyDoc() {
      const doc = plan("mm_one");
      const timestamp = now();
      doc.activityLog = [
        { timestamp, message: "File modify: src/a.ts", nodeId: NodeId.parse("mm_one_first"), file: "src/a.ts" },
        { timestamp, message: 'Task "First" marked completed', nodeId: NodeId.parse("mm_one_first") },
        { timestamp, message: "[MODIFY] src/b.ts — logged by the agent", nodeId: NodeId.parse("mm_one_second"), file: "src/b.ts" },
        { timestamp, message: "File delete: src/c.ts", nodeId: NodeId.parse("mm_one_second"), file: "src/c.ts" },
      ];
      return doc;
    }

    it("shows task history first, and what the agent logged, with file events a click away", async () => {
      const page = openViewer({ docs: [busyDoc()] });
      await page.settle();
      page.click('.sidebar-tab[data-tab="activity"]');
      expect(entries(page).some((e) => e.includes("File "))).toBe(false);
      expect(entries(page).some((e) => e.includes("marked completed"))).toBe(true);
      expect(entries(page).some((e) => e.includes("logged by the agent"))).toBe(true);
      expect(page.document.querySelector(toggle)?.textContent).toContain("(2)");
      expect(page.document.querySelector(toggle)?.getAttribute("aria-expanded")).toBe("false");

      page.click(toggle);
      expect(entries(page).length).toBe(4);
      expect(page.document.querySelector(toggle)?.getAttribute("aria-expanded")).toBe("true");
    });

    it("keeps file events showing while stepping through them", async () => {
      const page = openViewer({ docs: [busyDoc()] });
      await page.settle();
      page.click('.sidebar-tab[data-tab="activity"]');
      page.click(toggle);
      page.click(".activity-item");
      expect(page.document.querySelector(".node-group.selected")?.getAttribute("data-node-id")).toBe("mm_one_first");
      expect(entries(page).length).toBe(4);
    });

    it("explains a log that holds only file events", async () => {
      const doc = plan("mm_one");
      doc.activityLog = [{ timestamp: now(), message: "File create: src/a.ts", file: "src/a.ts" }];
      const page = openViewer({ docs: [doc] });
      await page.settle();
      page.click('.sidebar-tab[data-tab="activity"]');
      expect(entries(page)).toEqual([]);
      expect(page.document.querySelector("#sidebar-content")?.textContent).toContain("Only auto-detected file changes so far");
    });

    it("has no toggle without file events", async () => {
      const page = openViewer({ docs: [plan("mm_one")] });
      await page.settle();
      page.click('.sidebar-tab[data-tab="activity"]');
      expect(page.document.querySelector(toggle)).toBeNull();
    });
  });

  it("clears a file highlight when another card is picked", async () => {
    const doc = plan("mm_one");
    const worked = addChild(doc, { type: "task", label: "With a file", id: "mm_one_file" });
    worked.files.push({ path: "a.ts", action: "modify", changes: [], timestamp: doc.updatedAt });
    const page = openViewer({ docs: [doc] });
    await page.settle();
    const card = (id: string) => `.node-group[data-node-id="${id}"]`;
    page.click(card("mm_one_file"));
    page.click(".file-path");
    expect(page.document.querySelector(card("mm_one_file"))?.classList.contains("file-highlighted")).toBe(true);

    page.click(card("mm_one_phase"));
    expect(page.document.querySelector(".node-group.file-highlighted")).toBeNull();
  });

  it("walks the map with the arrow keys", async () => {
    const page = openViewer({ docs: [plan("mm_one")] });
    await page.settle();
    const press = (key: string) => page.document.activeElement?.dispatchEvent(new page.window.KeyboardEvent("keydown", { key, bubbles: true }));
    const selected = () => page.document.querySelector(".node-group.selected")?.getAttribute("data-node-id");

    const start = page.document.querySelector('.node-group[tabindex="0"]');
    if (!(start instanceof page.window.SVGElement)) throw new Error("No card to start from");
    start.focus();
    press("ArrowRight");
    expect(selected()).toBe("mm_one_phase");
    press("ArrowRight");
    expect(selected()).toBe("mm_one_first");
    press("ArrowDown");
    expect(selected()).toBe("mm_one_second");
    press("ArrowLeft");
    expect(selected()).toBe("mm_one_phase");
    press("-");
    expect(page.document.querySelectorAll(".node-group").length).toBe(2);
    press("+");
    expect(page.document.querySelectorAll(".node-group").length).toBe(4);
  });

  it("unfolds the branch hiding a card picked from the sidebar", async () => {
    const page = openViewer({ docs: [plan("mm_one")] });
    await page.settle();
    page.click('.node-group[data-node-id="mm_one_phase"] .fold-pill');
    expect(page.document.querySelector('.node-group[data-node-id="mm_one_first"]')).toBeNull();

    page.type("#map-search", "First");
    expect(page.document.querySelector('.node-group[data-node-id="mm_one_first"].selected')).not.toBeNull();
  });

  it("explains an empty view, and hides the canvas tools with no session open", async () => {
    const page = openViewer({ docs: [] });
    await page.settle();
    expect(page.document.body.classList.contains("no-session")).toBe(true);
    expect(page.document.querySelector("#sync-git-btn")?.hasAttribute("disabled")).toBe(true);

    const doc = plan("mm_one");
    page.server.docs.push(doc);
    page.emit({ type: "mindmap_updated", id: "mm_one", item: listItem(doc) });
    await page.settle();
    expect(page.document.body.classList.contains("no-session")).toBe(false);
    page.click('#view-switcher [data-mode="hld"]');
    expect(page.document.querySelector("#view-empty")?.textContent).toBe("No code mental model in this session");
    expect(page.document.querySelector("#view-empty")?.hasAttribute("hidden")).toBe(false);
  });

  describe("edge cases", () => {
    const card = (id: string) => `.node-group[data-node-id="${id}"]`;

    it("keeps a hostile node type from breaking out of its attribute", async () => {
      const doc = plan("mm_one");
      const hostile = addChild(doc, { type: "note", label: "Hostile", id: "mm_one_x" });
      Reflect.set(hostile, "type", 'x"><image href="x" onerror="alert(1)"/><g class="');
      const page = openViewer({ docs: [doc] });
      await page.settle();
      expect(page.document.querySelector("#svg image")).toBeNull();
      expect(page.document.querySelector(card("mm_one_x"))).not.toBeNull();
    });

    it("leaves a session that was deleted while the stream was down", async () => {
      const [one, two] = [plan("mm_one"), plan("mm_two")];
      const page = openViewer({ docs: [one, two] });
      await page.settle();
      page.emit({ type: "connected" });
      await page.settle();
      page.server.items = page.server.items.filter((s) => s.id !== "mm_one");
      page.server.docs = [two];
      page.emit({ type: "connected" });
      await page.settle();
      expect(page.window.location.hash).toBe("#mm_two");
      expect(page.document.querySelector("#session-name")?.textContent).toBe("Session mm_two");
    });

    it("doesn't let a list that was already on its way undo a live event", async () => {
      const [one, two] = [plan("mm_one"), plan("mm_two")];
      const page = openViewer({ docs: [one, two] });
      await page.settle();
      page.server.hold("/api/mindmaps");
      page.click("#refresh-btn");
      await page.settle();
      page.emit({ type: "mindmap_deleted", id: "mm_two" });
      await page.settle();
      expect(page.row("mm_two")).toBeNull();

      page.server.release("/api/mindmaps");
      await page.settle();
      expect(page.row("mm_two")).toBeNull();
    });

    it("ignores a Sync Git reply for a session the page has moved on from", async () => {
      const [one, two] = [plan("mm_one"), plan("mm_two")];
      const page = openViewer({ docs: [one, two] });
      await page.settle();
      page.server.hold("/api/sync-git");
      page.click("#sync-git-btn");
      page.click('.session-item[data-session-id="mm_two"]');
      await page.settle();
      page.server.release("/api/sync-git");
      await page.settle();
      expect(page.document.querySelector("#session-name")?.textContent).toBe("Session mm_two");
      expect(page.window.location.hash).toBe("#mm_two");
    });

    it("keeps the camera where it is when folding the branch with the active task", async () => {
      const doc = plan("mm_one");
      const phase = doc.nodes[NodeId.parse("mm_one_phase")];
      if (phase?.type !== "plan") throw new Error("No phase");
      const page = openViewer({ docs: [doc] });
      await page.settle();
      page.click("#zoom-in");
      const zoomed = page.transform();
      page.click(`${card("mm_one_phase")} .fold-pill`);
      expect(page.transform()).toBe(zoomed);
      page.click(`${card("mm_one_phase")} .fold-pill`);
      expect(page.transform()).toBe(zoomed);
    });

    it("remembers a fold around the active task when coming back to a session", async () => {
      const [one, two] = [plan("mm_one"), plan("mm_two")];
      const page = openViewer({ docs: [one, two] });
      await page.settle();
      page.click(`${card("mm_one_phase")} .fold-pill`);
      expect(page.document.querySelectorAll(".node-group").length).toBe(2);

      page.click('.session-item[data-session-id="mm_two"]');
      await page.settle();
      page.click('.session-item[data-session-id="mm_one"]');
      await page.settle();
      expect(page.document.querySelectorAll(".node-group").length).toBe(2);
    });

    it("unfolds when the agent starts a task in a folded branch, and says so on the fold button", async () => {
      const doc = plan("mm_one");
      const page = openViewer({ docs: [doc] });
      await page.settle();
      page.click(`${card("mm_one_phase")} .fold-pill`);
      expect(page.document.querySelector("#fold-btn")?.textContent).toBe("Unfold");

      const task = doc.nodes[NodeId.parse("mm_one_first")];
      if (task?.type !== "task") throw new Error("No task");
      task.status = "in_progress";
      task.updatedAt = now();
      page.emit({ type: "mindmap_updated", id: "mm_one", item: listItem(doc) });
      await page.settle();
      expect(page.document.querySelector(card("mm_one_first"))).not.toBeNull();
      expect(page.document.querySelector("#fold-btn")?.textContent).toBe("Fold done");
    });

    it("doesn't fold a card with nothing below it", async () => {
      const page = openViewer({ docs: [plan("mm_one")] });
      await page.settle();
      page.press(card("mm_one_first"), "-");
      expect(page.document.querySelector("#fold-btn")?.textContent).toBe("Fold done");
      page.press(card("root"), "-");
      expect(page.document.querySelectorAll(".node-group").length).toBe(4);
    });

    it("moves with the arrow keys in the order cards are drawn", async () => {
      const doc = emptyDoc("mm_one", "Order");
      addChild(doc, { type: "component", label: "Below", id: "mm_one_hld" });
      addChild(doc, { type: "task", label: "Above", id: "mm_one_task" });
      const page = openViewer({ docs: [doc] });
      await page.settle();
      page.press(card("root"), "ArrowRight");
      expect(page.document.querySelector(".node-group.selected")?.getAttribute("data-node-id")).toBe("mm_one_task");
    });

    it("doesn't let a double-click delete a session for good", async () => {
      const doc = plan("mm_one");
      const page = openViewer({ docs: [doc], items: [listItem(doc, { archivedAt: doc.updatedAt })], hash: "#mm_one" });
      await page.settle();
      page.click("#archived-toggle");
      const del = '.session-item [data-action="delete"]';
      page.click(del);
      page.click(del);
      await page.settle();
      expect(page.server.requests.filter((r) => r.startsWith("DELETE"))).toEqual([]);
      expect(page.document.querySelector(del)?.textContent).toBe("Confirm");

      await new Promise((resolve) => setTimeout(resolve, 520));
      page.click(del);
      await page.settle();
      expect(page.server.requests.filter((r) => r.startsWith("DELETE"))).toEqual(["DELETE /api/mindmaps/mm_one"]);
    });

    it("only offers Delete on an unreadable file the server can delete", async () => {
      const unreadable = [{ id: "mm_bad", error: "damaged" }, { id: "backup.old", error: "damaged" }];
      const page = openViewer({ docs: [plan("mm_one")], unreadable });
      await page.settle();
      expect(page.document.querySelector('[data-session-id="mm_bad"] [data-action="delete"]')).not.toBeNull();
      expect(page.document.querySelector('[data-session-id="backup.old"] [data-action="delete"]')).toBeNull();
    });

    it("offers Undo for the sessions that did archive when others failed", async () => {
      const [one, two] = [plan("mm_one"), plan("mm_two")];
      const finished = { totalTasks: 1, completedTasks: 1 };
      const page = openViewer({ docs: [one, two], items: [listItem(one, finished), listItem(two, finished)] });
      await page.settle();
      page.server.refuseArchive.add("mm_one");
      page.click("[data-archive-finished]");
      await page.settle();
      const messages = [...page.document.querySelectorAll(".toast")].map((t) => t.textContent);
      expect(messages.some((m) => m.includes("Could not archive"))).toBe(true);
      expect(messages.some((m) => m.includes("Archived 1 of 2 sessions"))).toBe(true);

      page.click(".toast button");
      await page.settle();
      expect(page.server.archived).toEqual([["mm_two", true], ["mm_two", false]]);
    });

    it("closes the drawer with Esc from the filter box", async () => {
      const page = openViewer({ docs: [plan("mm_one")] });
      await page.settle();
      page.document.body.classList.add("sessions-open");
      page.press("#session-search", "Escape");
      expect(page.document.body.classList.contains("sessions-open")).toBe(false);
    });

    it("keeps the path filter box in place while typing, and turns the auto-detected toggle off", async () => {
      const doc = plan("mm_one");
      const task = addChild(doc, { type: "task", label: "Busy", id: "mm_one_busy" });
      for (let i = 0; i < 12; i++) {
        task.files.push({ path: `gen/file-${i}.js`, action: "modify", changes: [], summary: "Auto-detected file modify", timestamp: doc.updatedAt });
      }
      const page = openViewer({ docs: [doc] });
      await page.settle();
      page.click(card("mm_one_busy"));
      const box = page.document.querySelector("#file-filter");
      expect(page.document.querySelectorAll(".file-item").length).toBe(0);

      page.type("#file-filter", "file-1");
      expect(page.document.querySelector("#file-filter")).toBe(box);
      expect(page.document.querySelectorAll(".file-item").length).toBe(3);
      expect(page.document.querySelector("[data-toggle-auto]")?.hasAttribute("disabled")).toBe(true);
    });
  });
});
