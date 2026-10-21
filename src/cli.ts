#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { errorCode } from "./errors.js";
import { CLIENTS, init, isClientId } from "./installer.js";
import * as store from "./store.js";
import { VERSION } from "./version.js";
import { DEFAULT_VIEWER_PORT, startViewer } from "./viewer.js";

const HELP = `synapse-mindmap ${VERSION}: live mindmap of your coding agent's plan, mental model and changes

Usage:
  npx synapse-mindmap init [--client <id>]... [--yes] [--force] [--dry-run]
      Register the Synapse MCP server with your coding agents.
      Client ids: ${CLIENTS.map((c) => c.id).join(", ")}
  npx synapse-mindmap viewer [--port <n>] [--open]
      Start the live viewer (default port ${DEFAULT_VIEWER_PORT}, or the next free one).
  npx synapse-mindmap mcp
      Run the MCP server over stdio (this is what your agent launches).

Environment:
  SYNAPSE_DATA_DIR   where mindmaps are stored (default ~/.synapse/data)
  SYNAPSE_PORT       viewer port (like --port, used as-is)

Docs: https://vss96.github.io/synapse/`;

function fail(message: string): never {
  console.error(`synapse-mindmap: ${message}\nRun "synapse-mindmap --help" for usage.`);
  process.exit(1);
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function runInit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      client: { type: "string", multiple: true },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  });
  const unknown = (values.client ?? []).filter((id) => !isClientId(id));
  if (unknown.length) fail(`unknown client ${unknown.join(", ")} (expected one of: ${CLIENTS.map((c) => c.id).join(", ")})`);
  if (!values.yes && !values["dry-run"] && !process.stdin.isTTY) {
    fail("not running in a terminal; pass --yes to configure without prompts");
  }

  const rl = values.yes || values["dry-run"] ? null : createInterface({ input: process.stdin, output: process.stdout });
  try {
    const outcomes = await init({
      clients: values.client?.filter(isClientId),
      yes: values.yes,
      force: values.force,
      dryRun: values["dry-run"],
      confirm: rl ? async (question) => !/^n/i.test((await rl.question(`${question} [Y/n] `)).trim()) : undefined,
    });
    if (!values["dry-run"]) {
      const dataDir = await store.ensureDataDir();
      console.log(`\nMindmaps are stored in ${dataDir}`);
    }
    if (Object.values(outcomes).includes("configured")) {
      console.log("Restart your agent (or reconnect its MCP servers), then watch it work with:");
      console.log("  npx synapse-mindmap viewer --open");
    }
    if (Object.values(outcomes).includes("failed")) process.exitCode = 1;
  } finally {
    rl?.close();
  }
}

async function runViewer(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { port: { type: "string" }, open: { type: "boolean" } },
  });
  const requested = values.port ?? process.env.SYNAPSE_PORT;
  const port = requested === undefined ? undefined : Number(requested);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) fail(`invalid port "${requested}"`);

  let viewer;
  try {
    viewer = await startViewer({ port, strictPort: port !== undefined });
  } catch (err) {
    if (errorCode(err) === "EADDRINUSE") fail(`port ${port} is already in use`);
    throw err;
  }
  if (port === undefined && viewer.port !== DEFAULT_VIEWER_PORT) {
    console.error(`[synapse viewer] port ${DEFAULT_VIEWER_PORT} is in use, using ${viewer.port}`);
  }
  console.error(`[synapse viewer] ${viewer.url}  (mindmaps: ${store.getDataDir()})`);
  if (values.open) openInBrowser(viewer.url);

  const shutdown = () => void viewer.close().then(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "init":
      return runInit(rest);
    case "viewer":
      return runViewer(rest);
    case "mcp":
      await import("./index.js");
      return;
    case "-v":
    case "--version":
      console.log(VERSION);
      return;
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    case undefined:
      // MCP clients pipe stdio; a person at a terminal gets the help text instead of a silent server.
      if (process.stdin.isTTY) console.log(HELP);
      else await import("./index.js");
      return;
    default:
      fail(`unknown command "${command}"`);
  }
}

main().catch((err) => {
  console.error(`synapse-mindmap: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
