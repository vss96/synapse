/**
 * The session a viewer URL points to: the hash holds its ID. Pure, so it is unit-tested without a
 * DOM.
 */

/** The URL hash that opens session `id`. */
export function sessionHash(id: string): string {
  return `#${encodeURIComponent(id)}`;
}

/** The session ID in a URL hash; "" for no ID, or for a hand-edited hash that isn't valid percent-encoding. */
export function sessionIdFromHash(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return "";
  }
}
