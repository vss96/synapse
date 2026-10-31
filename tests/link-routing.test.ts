import { describe, expect, it } from "bun:test";
import { LinkId, NodeId, type MindmapLink } from "../src/model/schema.js";
import type { NodeBox } from "../viewer/layout.js";
import { pillLabel, routeBounds, routeLinks } from "../viewer/link-routing.js";

const id = (s: string) => NodeId.parse(s);
const card = (x: number, y: number, depth = 0): NodeBox => ({ x, y, w: 235, h: 60, depth });

function link(from: string, to: string, label = "calls", n = 1): MindmapLink {
  return { id: LinkId.parse(`l_${from}${to}${n}`), from: id(from), to: id(to), label, style: "solid" };
}

describe("viewer link routing", () => {
  const columns = new Map([
    [id("a"), card(0, 100)],
    [id("b"), card(400, 300)],
    [id("c"), card(0, 400)],
    [id("d"), card(0, 700)],
    [id("e"), card(240, 100)],
  ]);

  it("runs across columns from side to side, through the gap between them", () => {
    const [route] = routeLinks([link("a", "b")], columns);
    expect(route).toMatchObject({ x1: 235, y1: 100, x2: 400, y2: 300 });
    expect(route?.cx).toBe((235 + 400) / 2);
    expect(route?.pill.x).toBeGreaterThanOrEqual(235 - 30);
  });

  it("leaves the facing side when a link runs right to left", () => {
    const [route] = routeLinks([link("b", "a")], columns);
    expect(route).toMatchObject({ x1: 400, x2: 235 });
  });

  it("takes the gutter past the cards between two in a column", () => {
    const [route] = routeLinks([link("a", "d")], columns);
    expect(route?.x1).toBe(235);
    expect(route?.cx).toBeGreaterThan(235);
    expect(route?.pill.x).toBeGreaterThan(235);
  });

  it("arcs over two cards in a row", () => {
    const [route] = routeLinks([link("a", "e")], columns);
    expect(route?.cy).toBeLessThan(70);
  });

  it("fans out links between the same two cards, whichever way they point", () => {
    const routes = routeLinks([link("a", "b", "forwards JWT", 1), link("a", "b", "attaches id", 2), link("b", "a", "replies", 3)], columns);
    expect(new Set(routes.map((r) => r.cy)).size).toBe(3);
    for (const a of routes) {
      for (const b of routes) {
        if (a === b) continue;
        const clear = a.pill.y + a.pill.h <= b.pill.y || b.pill.y + b.pill.h <= a.pill.y || a.pill.x + a.pill.w <= b.pill.x || b.pill.x + b.pill.w <= a.pill.x;
        expect(clear).toBe(true);
      }
    }
  });

  it("keeps a label off the cards, so it can't hide their text", () => {
    const rows = new Map([
      [id("a"), card(0, 100)],
      [id("mid"), card(405, 150)],
      [id("b"), card(810, 200)],
    ]);
    const [route] = routeLinks([link("a", "b")], rows);
    const mid = { top: 120, bottom: 180 };
    expect(route && (route.pill.y >= mid.bottom || route.pill.y + route.pill.h <= mid.top)).toBe(true);
  });

  it("keeps a gutter label in the gap beside the column", () => {
    const [route] = routeLinks([link("a", "d", "attaches X-Request-Id to it")], columns);
    expect(route?.pill.x).toBeLessThanOrEqual(235 + 4);
  });

  it("keeps parallel links between cards in a row apart too", () => {
    const routes = routeLinks([link("a", "e", "one", 1), link("a", "e", "two", 2), link("e", "a", "back", 3)], columns);
    expect(new Set(routes.map((r) => r.cy)).size).toBe(3);
  });

  it("draws a card linked to itself as a loop, not a line of no width", () => {
    const [route] = routeLinks([link("a", "a")], columns);
    expect(route?.cx).toBeGreaterThan(route?.x1 ?? Infinity);
    expect(route?.y1).not.toBe(route?.y2);
  });

  it("skips links with an end this view doesn't draw", () => {
    expect(routeLinks([link("a", "missing")], columns)).toEqual([]);
  });

  it("measures everything a link draws, for Fit", () => {
    const [route] = routeLinks([link("a", "d", "throttles the fallback path")], columns);
    if (!route) throw new Error("not routed");
    const bounds = routeBounds(route);
    expect(bounds.x + bounds.w).toBeGreaterThanOrEqual(route.pill.x + route.pill.w);
    expect(bounds.x + bounds.w).toBeGreaterThanOrEqual(route.cx);
    expect(bounds.y).toBeLessThanOrEqual(Math.min(route.y1, route.y2));
  });

  it("shortens long labels", () => {
    expect(pillLabel("x".repeat(30))).toHaveLength(24);
    expect(pillLabel("short")).toBe("short");
  });
});
