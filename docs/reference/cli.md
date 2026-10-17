# CLI

```sh
npx synapse-mindmap <command> [options]
```

The `synapse-mindmap` package needs Node.js 20 or newer. You can run it with `npx`, as shown on this page, or install it globally with `npm install -g synapse-mindmap`. A global install adds two equivalent commands, `synapse-mindmap` and `synapse`.

| Command | Description |
|---|---|
| [`init`](#init) | Configure your installed MCP clients to use Synapse |
| [`viewer`](#viewer) | Start the live web viewer |
| [`mcp`](#mcp) | Run the stdio MCP server (clients start this command) |
| `help`, `--help`, `-h` | Print usage |
| `--version`, `-v` | Print the installed version |

Without a command, `synapse-mindmap` prints the help text when run in a terminal. When its stdin is piped, as it is when an MCP client starts it, it runs the MCP server instead. So a client config that leaves out `mcp` still works.

## `init`

```sh
npx synapse-mindmap init [--client <id>]... [--yes] [--force] [--dry-run]
```

Registers the Synapse MCP server with your coding agents and creates the data directory.

| Flag | Description |
|---|---|
| `--client <id>` | Configure only this client, even if it wasn't detected. Repeat to pick several. Ids: `claude-code`, `claude-desktop`, `cursor`, `opencode`, `codex` |
| `--yes`, `-y` | Don't prompt. Configure every selected client |
| `--force` | Replace an existing `synapse` entry. Without it, clients that are already configured are skipped |
| `--dry-run` | Print what would change and write nothing |

Without `--client`, `init` only selects the clients it detects:

| Id | Detected when | How it's configured |
|---|---|---|
| `claude-code` | `claude` is on `PATH` | `claude mcp add --scope user synapse -- npx -y synapse-mindmap mcp`. An existing entry is recognized from the "already exists" error. With `--force`, `claude mcp remove --scope user synapse` runs first |
| `codex` | `codex` is on `PATH` | `codex mcp add synapse -- npx -y synapse-mindmap mcp`, unless `codex mcp get synapse` shows it's already configured. Writes `~/.codex/config.toml`, which the ChatGPT desktop app and the Codex IDE extension also read |
| `opencode` | `opencode` is on `PATH`, or its config directory exists | Edits `~/.config/opencode/opencode.json` (or `opencode.jsonc` if present; `$XDG_CONFIG_HOME` is honored). Sets `mcp.servers.synapse`, removes a legacy `mcp.synapse` entry, and adds `$schema` to a new file |
| `claude-desktop` | Its config directory exists | Edits `claude_desktop_config.json` and sets `mcpServers.synapse` |
| `cursor` | `~/.cursor` exists | Edits `~/.cursor/mcp.json` and sets `mcpServers.synapse` |

The Claude Desktop and Cursor entry looks like this:

```json
{
  "command": "npx",
  "args": ["-y", "synapse-mindmap", "mcp"],
  "env": { "PATH": "<dirs of node and npx>:/usr/local/bin:/usr/bin:/bin" }
}
```

`env.PATH` is only added on macOS and Linux, where GUI apps often don't inherit your shell's `PATH`. The OpenCode entry is `{ "type": "local", "command": ["npx", "-y", "synapse-mindmap", "mcp"] }`.

Before editing a JSON config, `init` copies it to `<file>.bak-<timestamp>`, using an ISO timestamp with `:` and `.` replaced by `-`. Then it writes the new file atomically. If an existing file isn't plain JSON, for example because it has comments, `init` leaves it untouched and prints the snippet to add yourself. That client counts as failed.

When it's done, `init` prints where mindmaps are stored and, if it configured anything, suggests `npx synapse-mindmap viewer --open`. Restart each configured client, or reconnect its MCP servers. Manual setup for every client, including Windsurf, is covered in [Connecting Clients](../guide/clients).

## `viewer`

```sh
npx synapse-mindmap viewer [--port <n>] [--open]
```

Starts the live viewer on `127.0.0.1` and prints its URL and data directory. It runs until you stop it with `Ctrl+C`.

| Flag | Description |
|---|---|
| `--port <n>` | Listen on exactly this port. If it's busy, exit with `port N is already in use`. Overrides `SYNAPSE_PORT` |
| `--open` | Open the viewer in your default browser |

Without `--port` or `SYNAPSE_PORT`, the viewer starts at **4040**. If that port is taken, it tries the next 20 ports, then lets the operating system pick a free one. A port counts as taken when anything answers on `127.0.0.1` or `::1`.

## `mcp`

```sh
npx -y synapse-mindmap mcp
```

The stdio MCP server. MCP clients start it, so you normally never run it yourself. It speaks MCP on stdin/stdout, writes logs to stderr only, and exits when the client closes the connection. Running it in a terminal is a quick way to check that it starts.

## Environment variables

| Variable | Used by | Default | Description |
|---|---|---|---|
| `SYNAPSE_DATA_DIR` | `mcp`, `viewer`, `init` | `~/.synapse/data` | Directory where mindmap JSON files are stored. The server and the viewer must use the same directory |
| `SYNAPSE_PORT` | `viewer` | `4040`, falling back to the next free port | Viewer port. When set, it's used as-is, like `--port` |

## Exit codes

| Code | When |
|---|---|
| `0` | Success, including `--help` and `--version`, and `viewer` stopped with `Ctrl+C` |
| `1` | Unknown command or flag, unknown `--client` id, or invalid port |
| `1` | `init` ran without a terminal and without `--yes` (or `--dry-run`) |
| `1` | `init` failed to configure at least one client |
| `1` | `viewer` was given an explicit port that's already in use |
