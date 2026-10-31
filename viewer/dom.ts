/** Small DOM and text helpers shared by the viewer's modules. */

/** The element with this id, checked to be a `type` (an HTMLElement unless given). */
export function byId(id: string): HTMLElement;
export function byId<T extends Element>(id: string, type: new () => T): T;
export function byId(id: string, type: new () => Element = HTMLElement): Element {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(el ? `#${id} is not a ${type.name}` : `Missing #${id}`);
  return el;
}

export function query(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(el ? `${selector} is not an HTMLElement` : `Missing ${selector}`);
  return el;
}

/**
 * Parses JSON from the Synapse server (API responses and live events). Typed, not validated: the
 * server only sends mindmaps it checked with zod (src/model/schema.ts), and checking them again here
 * would bundle zod.
 */
export function serverJson<T>(json: string): T {
  return JSON.parse(json) as T;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function truncate(str: string | undefined, max: number) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

export function escXml(s: unknown) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
