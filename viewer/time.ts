/**
 * Dates as the viewer shows them, in the browser's locale and time zone. Pure (the current time is
 * a parameter), so it is unit-tested without a DOM.
 */

const DAY_MS = 86_400_000;

/** Midnight at the start of the local day `d` falls on. */
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The local day of `iso`, as a heading for that day's activity: "Today", "Yesterday" or the date. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  // Rounded, because a day with a daylight-saving change is 23 or 25 hours long.
  const daysAgo = Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS);
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  const year = d.getFullYear() === now.getFullYear() ? undefined : "numeric";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year });
}
