import { describe, expect, it } from "bun:test";
import { fitLine, wrapLines } from "../viewer/text-fit.js";

/** Every character is 10px wide, except capitals, which are 20px: a proportional font in miniature. */
const measure = (text: string) => [...text].reduce((w, c) => w + (c >= "A" && c <= "Z" ? 20 : 10), 0);

describe("viewer text fitting", () => {
  it("leaves text that fits alone", () => {
    expect(fitLine("short", 50, measure)).toBe("short");
    expect(wrapLines("short", 50, 2, measure)).toEqual(["short"]);
  });

  it("cuts by width, not by character count", () => {
    expect(fitLine("aaaaaaaaaa", 60, measure)).toBe("aaaaa…");
    expect(fitLine("AAAAAAAAAA", 60, measure)).toBe("AA…");
  });

  it("wraps at spaces, so siblings that share a prefix stay distinct", () => {
    expect(wrapLines("Session token storage for edge", 170, 2, measure)).toEqual(["Session token", "storage for edge"]);
    expect(wrapLines("Session token storage for origin", 170, 2, measure)).toEqual(["Session token", "storage for orig…"]);
  });

  it("breaks a word too long for the line", () => {
    expect(wrapLines("WWWW_TRANSPORT", 100, 2, measure)).toEqual(["WWWW_", "TRAN…"]);
  });

  it("cuts the last line when text runs past the allowed lines", () => {
    const lines = wrapLines("one two three four five six seven eight", 80, 2, measure);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith("…")).toBe(true);
  });

  it("never returns a line wider than asked", () => {
    for (const text of ["WWWW_HTTP_TRANSPORT_CONFIG_INITIALIZER", "a b c d e f g h i j", "  padded  text  "]) {
      for (const line of wrapLines(text, 120, 2, measure)) expect(measure(line)).toBeLessThanOrEqual(120);
    }
  });

  it("has no lines for empty text", () => {
    expect(wrapLines("   ", 100, 2, measure)).toEqual([]);
  });
});
