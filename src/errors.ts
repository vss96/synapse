/** The `code` of a Node.js system error (e.g. "EADDRINUSE"), or undefined for anything else. */
export function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}
