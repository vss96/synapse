import { describe, expect, it } from "bun:test";
import { now } from "../src/model/schema.js";
import { matchesQuery, matchingFile } from "../viewer/search.js";
import { addChild, emptyDoc } from "./fixtures.js";

describe("viewer map search", () => {
  const doc = emptyDoc();
  const task = addChild(doc, { type: "task", label: "Add rate limiting", id: "n_task01" });
  task.files.push(
    { action: "read", path: "src/auth/session.ts", symbols: ["loadSession"], timestamp: now() },
    {
      action: "rename",
      path: "src/limits/limiter.ts",
      previousPath: "src/throttle.ts",
      changes: [{ kind: "rename", symbol: "rateLimit", previousSymbol: "throttle" }],
      timestamp: now(),
    },
  );
  const component = addChild(doc, { type: "component", label: "Session store", notes: "Redis behind ShedLock" });

  it("matches a card's label or ID, ignoring case and surrounding spaces", () => {
    expect(matchesQuery(task, "rate LIMIT")).toBe(true);
    expect(matchesQuery(task, "  n_task01 ")).toBe(true);
    expect(matchesQuery(component, "rate")).toBe(false);
  });

  it("matches the paths and symbols of the files a card touched, including what they were renamed from", () => {
    for (const q of ["limiter.ts", "src/auth", "loadSession", "ratelimit", "throttle"]) {
      expect(matchesQuery(task, q)).toBe(true);
    }
    expect(matchesQuery(component, "session.ts")).toBe(false);
  });

  it("matches a card's notes", () => {
    expect(matchesQuery(component, "shedlock")).toBe(true);
  });

  it("names the file behind a match, unless the card's own text matches", () => {
    expect(matchingFile(task, "limiter.ts")).toBe("src/limits/limiter.ts");
    expect(matchingFile(task, "loadSession")).toBe("src/auth/session.ts");
    expect(matchingFile(task, "rate limit")).toBeUndefined();
    expect(matchingFile(component, "shedlock")).toBeUndefined();
    expect(matchingFile(task, "")).toBeUndefined();
  });

  it("matches nothing for an empty query", () => {
    expect(matchesQuery(task, "")).toBe(false);
    expect(matchesQuery(task, "   ")).toBe(false);
  });
});
