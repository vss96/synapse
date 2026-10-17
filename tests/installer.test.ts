import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

/**
 * Runs `synapse-mindmap init` in a child process whose HOME, XDG config dir and PATH are set when it
 * starts, so neither the installer nor the client CLIs it runs can reach the real user's configs.
 */
describe("synapse-mindmap init", () => {
  let tmp: string;
  let home: string;
  let bin: string;
  let env: NodeJS.ProcessEnv;

  const init = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, "init", ...args], { env, encoding: "utf-8" });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  };
  /** A fake CLI that records its arguments in calls.log; `script` can simulate failures. */
  async function fakeCli(name: string, script = "") {
    const file = path.join(bin, name);
    await writeFile(file, `#!/bin/sh\necho "${name} $*" >> "${tmp}/calls.log"\n${script}\n`);
    await chmod(file, 0o755);
  }
  const calls = async () => (await readFile(path.join(tmp, "calls.log"), "utf-8").catch(() => "")).trim().split("\n").filter(Boolean);
  const readJson = async (file: string) => JSON.parse(await readFile(file, "utf-8"));

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "synapse-init-"));
    home = path.join(tmp, "home");
    bin = path.join(tmp, "bin");
    await mkdir(home);
    await mkdir(bin);
    env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter) };

    const probe = spawnSync(process.execPath, ["-e", "console.log(require('os').homedir())"], { env, encoding: "utf-8" });
    if (probe.stdout.trim() !== home) throw new Error(`sandbox HOME not applied (got ${probe.stdout.trim()}); refusing to run`);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("adds Synapse to Cursor's mcp.json, keeping other servers and backing up the file", async () => {
    const file = path.join(home, ".cursor", "mcp.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { other: { command: "other" } } }));

    expect(init("--client", "cursor", "--yes").code).toBe(0);
    const config = await readJson(file);
    expect(config.mcpServers.other).toEqual({ command: "other" });
    expect(config.mcpServers.synapse).toMatchObject({ command: "npx", args: ["-y", "synapse-mindmap", "mcp"] });
    expect(config.mcpServers.synapse.env.PATH.split(":")).toContain("/usr/bin");
    expect((await readdir(path.dirname(file))).filter((f) => f.startsWith("mcp.json.bak-"))).toHaveLength(1);

    // Re-running leaves it alone unless forced.
    expect(init("--client", "cursor", "--yes").output).toContain("already configured");
    expect(init("--client", "cursor", "--yes", "--force").output).toContain("✔ configured");
  });

  it("writes the V2 OpenCode shape and refuses to rewrite a config with comments", async () => {
    const dir = path.join(home, ".config", "opencode");
    await mkdir(dir, { recursive: true });

    expect(init("--client", "opencode", "--yes").code).toBe(0);
    const config = await readJson(path.join(dir, "opencode.json"));
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(config.mcp.servers.synapse).toEqual({ type: "local", command: ["npx", "-y", "synapse-mindmap", "mcp"] });

    const jsonc = path.join(dir, "opencode.jsonc");
    const original = `{\n  // my settings\n  "model": "x"\n}\n`;
    await writeFile(jsonc, original);
    const result = init("--client", "opencode", "--yes");
    expect(result.code).toBe(1);
    expect(result.output).toContain("Add this yourself");
    expect(await readFile(jsonc, "utf-8")).toBe(original);
    await rm(jsonc);
  });

  it("uses the Claude Code and Codex CLIs, and reports existing Claude Code entries", async () => {
    await fakeCli(
      "claude",
      `case "$*" in *"mcp add"*) [ -f "${tmp}/claude-added" ] && { echo "MCP server synapse already exists in user config" >&2; exit 1; }; touch "${tmp}/claude-added";; esac`,
    );
    await fakeCli("codex", `case "$*" in "mcp get synapse") exit 1;; esac`);

    expect(init("--client", "claude-code", "--client", "codex", "--yes").code).toBe(0);
    expect(await calls()).toEqual([
      "claude mcp add --scope user synapse -- npx -y synapse-mindmap mcp",
      "codex mcp get synapse",
      "codex mcp add synapse -- npx -y synapse-mindmap mcp",
    ]);
    expect(init("--client", "claude-code", "--yes").output).toContain("already configured");
  });

  it("configures only detected clients, never without consent, and changes nothing on --dry-run", async () => {
    // Without a terminal, init refuses to act unless --yes is given.
    const noTty = init();
    expect(noTty.code).toBe(1);
    expect(noTty.output).toContain("--yes");

    const before = await calls();
    const dry = init("--client", "claude-code", "--client", "claude-desktop", "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.output).toContain("claude mcp add --scope user synapse");
    expect(await calls()).toEqual(before);

    // claude + codex are on PATH and ~/.cursor, ~/.config/opencode exist; Claude Desktop does not.
    const all = init("--yes");
    for (const name of ["Claude Code", "Cursor", "OpenCode", "Codex"]) expect(all.output).toContain(`▸ ${name}`);
    expect(all.output).not.toContain("Claude Desktop");
    expect(existsSync(path.join(home, "Library", "Application Support", "Claude"))).toBe(false);
  });
});
