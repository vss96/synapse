import { describe, expect, it } from "bun:test";
import { dayLabel } from "../viewer/time.js";

// Local dates, so the tests pass in any time zone.
const now = new Date(2026, 9, 22, 9, 30);
const at = (...args: [number, number, number, number?, number?]) => new Date(...args).toISOString();

describe("viewer day labels", () => {
  it("names today and yesterday by local day, not by 24-hour distance", () => {
    expect(dayLabel(at(2026, 9, 22, 0, 5), now)).toBe("Today");
    expect(dayLabel(at(2026, 9, 21, 23, 55), now)).toBe("Yesterday");
    expect(dayLabel(at(2026, 9, 21, 0, 5), now)).toBe("Yesterday");
  });

  it("dates older days, adding the year only when it isn't this year", () => {
    const older = new Date(2026, 9, 17, 20, 23);
    expect(dayLabel(older.toISOString(), now)).toBe(older.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));
    const lastYear = new Date(2025, 11, 31, 12, 0);
    const label = dayLabel(lastYear.toISOString(), now);
    expect(label).toBe(lastYear.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }));
    expect(label).toContain("2025");
  });

  it("counts calendar days across daylight-saving changes", () => {
    // Every day of a year, so the 23- and 25-hour days of the local time zone (if any) are included.
    for (let day = 1; day <= 365; day++) {
      const late = new Date(2026, 0, day, 23, 55);
      expect(dayLabel(at(2026, 0, day, 0, 5), late)).toBe("Today");
      expect(dayLabel(at(2026, 0, day - 1, 0, 5), late)).toBe("Yesterday");
    }
  });
});
