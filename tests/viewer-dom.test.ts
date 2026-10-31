/**
 * The viewer page, end to end: the built bundle running against a simulated DOM, with the server's
 * HTTP and live events stubbed. Pure logic has its own tests; these cover the state between the modules.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { z } from "zod";
import type { MindmapDocument, MindmapListItem } from "../src/model/schema.js";
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
  "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "SVGElement", "SVGSVGElement", "File", "setInterval",
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
  const server = { items: items ?? docs.map((d) => listItem(d)), unreadable, docs, requests, archived: archivedCalls };
  const fetchStub = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    server.requests.push(`${method} ${url}`);
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (url === "/api/mindmaps") return json({ mindmaps: server.items, unreadable: server.unreadable });
    if (url === "/api/archive") {
      const { mindmapId, archived } = ArchiveBody.parse(JSON.parse(init?.body ?? "{}"));
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
      box.dispatchEvent(new window.Event("input"));
    },
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
});
