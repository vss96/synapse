import { describe, expect, it } from "bun:test";
import { isMindmapDocument } from "../viewer/local-file.js";
import { addChild, emptyDoc } from "./fixtures.js";

describe("viewer local files", () => {
  const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

  it("accepts a stored mindmap", () => {
    const doc = emptyDoc();
    addChild(doc, { type: "task", label: "Step" });
    expect(isMindmapDocument(roundTrip(doc))).toBe(true);
  });

  it("rejects what would break rendering halfway through", () => {
    const doc = emptyDoc();
    const without = (field: string): unknown => {
      const copy = roundTrip(doc);
      if (typeof copy === "object" && copy) Reflect.deleteProperty(copy, field);
      return copy;
    };
    for (const value of [null, 42, [], {}, without("links"), without("activityLog"), without("nodes"), { ...doc, nodes: {} }]) {
      expect(isMindmapDocument(value)).toBe(false);
    }
    const broken = roundTrip(doc);
    expect(isMindmapDocument(JSON.parse(JSON.stringify(broken).replace('"files":[]', '"files":"none"')))).toBe(false);
  });
});
