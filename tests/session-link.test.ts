import { describe, expect, it } from "bun:test";
import { sessionHash, sessionIdFromHash } from "../viewer/session-link.js";

describe("viewer session links", () => {
  it("reads back the session ID it put in the hash", () => {
    for (const id of ["mm_Ab12Cd34", "mm_-geff7pU", "a b/c#d?é"]) {
      expect(sessionIdFromHash(sessionHash(id))).toBe(id);
    }
  });

  it("finds no session in an empty hash", () => {
    expect(sessionIdFromHash("")).toBe("");
    expect(sessionIdFromHash("#")).toBe("");
  });

  it("finds no session in a hash that isn't valid percent-encoding, rather than throwing", () => {
    expect(sessionIdFromHash("#%E0%A4%A")).toBe("");
  });
});
