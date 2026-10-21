/**
 * `synapse-mindmap init`: registers the Synapse MCP server with the coding agents installed on this machine.
 * Clients with an `mcp add` CLI are configured through it; the rest get a backed-up JSON edit.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "synapse";
/** How every client launches the server. */
export const SERVER_COMMAND = ["npx", "-y", "synapse-mindmap", "mcp"] as const;

export type ClientId = "claude-code" | "claude-desktop" | "cursor" | "opencode" | "codex";

export interface Client {
  id: ClientId;
  name: string;
  /** Where the configuration lives, for messages. */
  target(): string;
  detected(): boolean;
  configured(): Promise<boolean>;
  /** What install() would do, shown before asking and for --dry-run. */
  plan(): string;
  install(options: { force: boolean }): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function findOnPath(command: string): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/** Like Node's os.homedir() on POSIX ($HOME first); Bun's ignores runtime changes to HOME. */
function homeDir(): string {
  return (process.platform !== "win32" && process.env.HOME) || os.homedir();
}

/** Runs the CLI found on PATH by absolute path, so we execute exactly the binary we detected. */
function run(command: string, args: string[]): { ok: boolean; output: string } {
  const executable = findOnPath(command);
  if (!executable) return { ok: false, output: `${command} not found on PATH` };
  const result = spawnSync(executable, args, { encoding: "utf-8", shell: process.platform === "win32" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`.trim();
  return { ok: result.status === 0, output };
}

function shellQuote(args: readonly string[]): string {
  return args.map((a) => (/^[\w@./:=-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

/**
 * GUI apps (Claude Desktop, Cursor) often start without the shell's PATH, so `npx` and the
 * `node` it runs through would not be found. Point them at the directories we found them in.
 */
function guiPath(): string | undefined {
  if (process.platform === "win32") return undefined;
  const dirs = [findOnPath("node"), findOnPath("npx")].filter((p): p is string => !!p).map((p) => path.dirname(p));
  return [...new Set([...dirs, "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
}

/** A JSON object, as opposed to an array, null or a primitive. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ConfigParseError extends Error {}
class AlreadyConfigured extends Error {}

async function readJsonConfig(file: string): Promise<Record<string, unknown>> {
  if (!existsSync(file)) return {};
  const raw = await readFile(file, "utf-8");
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isJsonObject(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new ConfigParseError(`${file} is not plain JSON (it may contain comments), so it was left untouched.`);
}

/** Back up the existing file, then write atomically so a crash can't leave a half-written config. */
async function writeJsonConfig(file: string, data: Record<string, unknown>): Promise<string | null> {
  await mkdir(path.dirname(file), { recursive: true });
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(file, backup);
  }
  const tmp = `${file}.synapse-tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  await rename(tmp, file);
  return backup;
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (isJsonObject(value)) return value;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

/* ------------------------------------------------------------------ */
/*  Clients                                                            */
/* ------------------------------------------------------------------ */

/** Claude Desktop and Cursor: `{ "mcpServers": { "synapse": { command, args, env } } }`. */
function mcpServersJsonClient(id: ClientId, name: string, file: () => string, appDir: () => string): Client {
  const entry = () => {
    const [command, ...args] = SERVER_COMMAND;
    const PATH = guiPath();
    return { command, args, ...(PATH ? { env: { PATH } } : {}) };
  };
  return {
    id,
    name,
    target: file,
    detected: () => existsSync(appDir()),
    configured: async () => SERVER_NAME in objectAt(await readJsonConfig(file()), "mcpServers"),
    plan: () => `set mcpServers.${SERVER_NAME} in ${file()}:\n${JSON.stringify({ [SERVER_NAME]: entry() }, null, 2)}`,
    async install() {
      const config = await readJsonConfig(file());
      objectAt(config, "mcpServers")[SERVER_NAME] = entry();
      const backup = await writeJsonConfig(file(), config);
      if (backup) console.log(`    backup: ${backup}`);
    },
  };
}

function claudeDesktopConfigDir(): string {
  const home = homeDir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Claude");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Claude");
}

function openCodeConfigFile(): string {
  const dir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(homeDir(), ".config"), "opencode");
  const jsonc = path.join(dir, "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : path.join(dir, "opencode.json");
}

const OPENCODE_ENTRY = { type: "local", command: [...SERVER_COMMAND] };

const CLAUDE_CODE_ADD = ["mcp", "add", "--scope", "user", SERVER_NAME, "--", ...SERVER_COMMAND];
const CODEX_ADD = ["mcp", "add", SERVER_NAME, "--", ...SERVER_COMMAND];

export const CLIENTS: readonly Client[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    target: () => "claude mcp (user scope)",
    detected: () => !!findOnPath("claude"),
    // `claude mcp get` launches the server to health-check it, so detect duplicates from `add` instead.
    configured: async () => false,
    plan: () => `run: claude ${shellQuote(CLAUDE_CODE_ADD)}`,
    async install({ force }) {
      if (force) run("claude", ["mcp", "remove", "--scope", "user", SERVER_NAME]);
      const result = run("claude", CLAUDE_CODE_ADD);
      if (result.ok) return;
      if (/already exists/i.test(result.output)) throw new AlreadyConfigured();
      throw new Error(result.output || "claude mcp add failed");
    },
  },
  mcpServersJsonClient(
    "claude-desktop",
    "Claude Desktop",
    () => path.join(claudeDesktopConfigDir(), "claude_desktop_config.json"),
    claudeDesktopConfigDir,
  ),
  mcpServersJsonClient(
    "cursor",
    "Cursor",
    () => path.join(homeDir(), ".cursor", "mcp.json"),
    () => path.join(homeDir(), ".cursor"),
  ),
  {
    id: "opencode",
    name: "OpenCode",
    target: openCodeConfigFile,
    detected: () => !!findOnPath("opencode") || existsSync(path.dirname(openCodeConfigFile())),
    configured: async () => {
      const mcp = objectAt(await readJsonConfig(openCodeConfigFile()), "mcp");
      return SERVER_NAME in mcp || SERVER_NAME in objectAt(mcp, "servers");
    },
    plan: () =>
      `set mcp.servers.${SERVER_NAME} in ${openCodeConfigFile()}:\n${JSON.stringify({ [SERVER_NAME]: OPENCODE_ENTRY }, null, 2)}`,
    async install() {
      const file = openCodeConfigFile();
      const config = await readJsonConfig(file);
      if (Object.keys(config).length === 0) config.$schema = "https://opencode.ai/config.json";
      const mcp = objectAt(config, "mcp");
      delete mcp[SERVER_NAME]; // legacy V1 location
      objectAt(mcp, "servers")[SERVER_NAME] = OPENCODE_ENTRY;
      const backup = await writeJsonConfig(file, config);
      if (backup) console.log(`    backup: ${backup}`);
    },
  },
  {
    id: "codex",
    name: "Codex (CLI, IDE extension & ChatGPT desktop)",
    target: () => "codex mcp (~/.codex/config.toml)",
    detected: () => !!findOnPath("codex"),
    configured: async () => run("codex", ["mcp", "get", SERVER_NAME]).ok,
    plan: () => `run: codex ${shellQuote(CODEX_ADD)}`,
    async install() {
      const result = run("codex", CODEX_ADD);
      if (!result.ok) throw new Error(result.output || "codex mcp add failed");
    },
  },
];

export const isClientId = (id: string): id is ClientId => CLIENTS.some((c) => c.id === id);

/* ------------------------------------------------------------------ */
/*  init                                                               */
/* ------------------------------------------------------------------ */

export interface InitOptions {
  /** Only these clients (configured even when not detected). Defaults to every detected client. */
  clients?: ClientId[];
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  /** Asks a yes/no question; required unless `yes` or `dryRun`. */
  confirm?: (question: string) => Promise<boolean>;
}

export type InitOutcome = "configured" | "already-configured" | "skipped" | "failed" | "dry-run";

export async function init(options: InitOptions = {}): Promise<Record<string, InitOutcome>> {
  const { clients } = options;
  const selected = clients ? CLIENTS.filter((c) => clients.includes(c.id)) : CLIENTS.filter((c) => c.detected());

  if (selected.length === 0) {
    console.log("No supported MCP clients found (Claude Code, Claude Desktop, Cursor, OpenCode, Codex).");
    console.log("Pick one explicitly with --client <id>, or see https://vss96.github.io/synapse/guide/clients");
    return {};
  }

  const outcomes: Record<string, InitOutcome> = {};
  for (const client of selected) {
    console.log(`\n▸ ${client.name}`);
    try {
      if (!options.force && (await client.configured())) {
        console.log(`  already configured (${client.target()}); use --force to replace it`);
        outcomes[client.id] = "already-configured";
        continue;
      }
      console.log(client.plan().replace(/^/gm, "  "));
      if (options.dryRun) {
        outcomes[client.id] = "dry-run";
        continue;
      }
      if (!options.yes && !(await options.confirm?.(`  Configure ${client.name}?`))) {
        outcomes[client.id] = "skipped";
        continue;
      }
      await client.install({ force: !!options.force });
      console.log("  ✔ configured");
      outcomes[client.id] = "configured";
    } catch (err) {
      if (err instanceof AlreadyConfigured) {
        console.log("  already configured; use --force to replace it");
        outcomes[client.id] = "already-configured";
      } else if (err instanceof ConfigParseError) {
        console.log(`  ✖ ${err.message} Add this yourself:\n${client.plan().replace(/^/gm, "    ")}`);
        outcomes[client.id] = "failed";
      } else {
        console.log(`  ✖ ${err instanceof Error ? err.message : String(err)}`);
        outcomes[client.id] = "failed";
      }
    }
  }
  return outcomes;
}
