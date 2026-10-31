/**
 * Fitting card text to a width in pixels, which a character count can't do in a proportional font.
 * Pure (the caller measures text), so it is unit-tested without a DOM.
 */

export type Measure = (text: string) => number;

const ELLIPSIS = "…";

/** How many leading characters of `text` fit in `maxWidth`. */
function fittingLength(text: string, maxWidth: number, measure: Measure): number {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(text.slice(0, mid)) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** `text` on one line, cut with an ellipsis if it's wider than `maxWidth`. */
export function fitLine(text: string, maxWidth: number, measure: Measure): string {
  if (measure(text) <= maxWidth) return text;
  const room = Math.max(0, maxWidth - measure(ELLIPSIS));
  return `${text.slice(0, fittingLength(text, room, measure)).trimEnd()}${ELLIPSIS}`;
}

/**
 * `text` wrapped at spaces onto at most `maxLines` lines, the last one cut with an ellipsis if some
 * doesn't fit. A word wider than a line is broken where the line ends.
 */
export function wrapLines(text: string, maxWidth: number, maxLines: number, measure: Measure): string[] {
  const lines: string[] = [];
  let rest = text.trim();
  while (rest && lines.length < maxLines - 1) {
    if (measure(rest) <= maxWidth) break;
    const fits = Math.max(1, fittingLength(rest, maxWidth, measure));
    const space = rest.lastIndexOf(" ", fits);
    const end = space > 0 ? space : fits;
    lines.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  return rest ? [...lines, fitLine(rest, maxWidth, measure)] : lines;
}
