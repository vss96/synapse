# Connecting Clients

Every client starts the same stdio command:

```sh
npx -y synapse-mindmap mcp
```

You never run this by hand. The client starts the server when it needs it. You need Node.js 20 or newer.

## Automatic setup

```sh
npx synapse-mindmap init
```

The installer looks for supported clients and only configures the ones it finds, unless you name clients with `--client`. For each client it shows the planned change and asks `Configure <name>? [Y/n]`. Here is how it detects and configures each one:

| Client | id | Detected when | What `init` does |
|---|---|---|---|
| Claude Code | `claude-code` | `claude` is on `PATH` | Runs `claude mcp add --scope user synapse -- npx -y synapse-mindmap mcp` |
| Claude Desktop | `claude-desktop` | Its config directory exists | Sets `mcpServers.synapse` in `claude_desktop_config.json` |
| Cursor | `cursor` | `~/.cursor` exists | Sets `mcpServers.synapse` in `~/.cursor/mcp.json` |
| OpenCode | `opencode` | `opencode` is on `PATH`, or its config directory exists | Sets `mcp.servers.synapse` in `opencode.json` |
| Codex, ChatGPT desktop, Codex IDE extension | `codex` | `codex` is on `PATH` | Runs `codex mcp add synapse -- npx -y synapse-mindmap mcp` |

Before editing a config file, `init` copies it to `<file>.bak-<timestamp>`, for example `mcp.json.bak-2026-10-17T09-30-00-000Z`. Each edit is written atomically, so an interrupted run can't leave a half-written config.

Clients that already have a `synapse` entry are skipped. `--force` replaces the entry instead. How an existing entry is found:

- **Claude Code**: from the "already exists" error that `claude mcp add` returns. Synapse doesn't call `claude mcp get`, because that command starts the server to health-check it. With `--force`, `init` runs `claude mcp remove --scope user synapse` first.
- **Codex**: `codex mcp get synapse` succeeds.
- **JSON configs**: the file already has a `synapse` key.

Useful flags (see the [CLI reference](../reference/cli#init) for all of them):

```sh
npx synapse-mindmap init --dry-run                 # show what would change, write nothing
npx synapse-mindmap init --client cursor --yes     # one client, no prompts (configured even if not detected)
npx synapse-mindmap init --client claude-code --force  # replace an existing entry
```

When it's done, `init` prints where mindmaps are stored and suggests `npx synapse-mindmap viewer --open`. If any client fails, it exits with code 1. After setup, **restart the client** or reconnect its MCP servers.

## Manual setup

Use these snippets if you'd rather edit config files yourself, or if your client isn't covered by `init`.

### Claude Code

```sh
claude mcp add --scope user synapse -- npx -y synapse-mindmap mcp
```

`--scope user` makes Synapse available in every project. Leave it out to add Synapse to the current project only.

### Claude Desktop

Edit `claude_desktop_config.json`:

| OS | Location |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` (or `$XDG_CONFIG_HOME/Claude/`) |

```json
{
  "mcpServers": {
    "synapse": {
      "command": "npx",
      "args": ["-y", "synapse-mindmap", "mcp"],
      "env": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Replace `/opt/homebrew/bin` with the directory that contains your `node` and `npx` (`dirname "$(which npx)"`). See [GUI apps can't find `npx`](#gui-apps-can-t-find-npx) for why this is needed. On Windows, leave out `env`.

### Cursor

Edit `~/.cursor/mcp.json`. It uses the same shape as Claude Desktop:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "npx",
      "args": ["-y", "synapse-mindmap", "mcp"],
      "env": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

### OpenCode

`init` edits OpenCode's global config file directly: `~/.config/opencode/opencode.json`, or `opencode.jsonc` if that exists. It uses `$XDG_CONFIG_HOME/opencode/` when `XDG_CONFIG_HOME` is set. It adds the entry below, removes any legacy V1 entry at `mcp.synapse`, and adds `"$schema"` when it creates a new file.

If the existing file isn't plain JSON (for example, JSONC with comments), `init` leaves it untouched, prints the snippet to add yourself, and exits with code 1. Either add the snippet by hand or use OpenCode's own CLI:

::: code-group

```json [opencode.json]
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "synapse": {
        "type": "local",
        "command": ["npx", "-y", "synapse-mindmap", "mcp"]
      }
    }
  }
}
```

```sh [CLI]
opencode mcp add synapse --global -- npx -y synapse-mindmap mcp
```

:::

### Codex, ChatGPT desktop, Codex IDE extension

The Codex CLI, the coding features of the ChatGPT desktop app, and the Codex IDE extension all read the same config file, `~/.codex/config.toml`.

::: code-group

```sh [CLI]
codex mcp add synapse -- npx -y synapse-mindmap mcp
```

```toml [~/.codex/config.toml]
[mcp_servers.synapse]
command = "npx"
args = ["-y", "synapse-mindmap", "mcp"]
```

:::

::: info ChatGPT connectors
The "connectors" in ChatGPT on the web and in the desktop chat only accept **remote HTTP** MCP servers. Synapse is a local stdio server, so it can't be added there. The ChatGPT desktop app's coding features use Codex's config instead, which is why the `codex` setup covers them.
:::

### Windsurf

The installer doesn't automate Windsurf. Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "npx",
      "args": ["-y", "synapse-mindmap", "mcp"],
      "env": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Then refresh MCP servers in Windsurf.

### Other clients

Any MCP client that can start a local stdio server works. Configure it to run `npx` with the arguments `-y synapse-mindmap mcp`. If a config leaves out `mcp`, it still works: `synapse-mindmap` with no command starts the MCP server whenever its stdin isn't a terminal.

## Custom data directory

By default the server and the viewer share `~/.synapse/data`. To use another directory, set `SYNAPSE_DATA_DIR` in **both** places:

::: code-group

```sh [Claude Code]
claude mcp add --scope user synapse --env SYNAPSE_DATA_DIR=/path/to/data -- npx -y synapse-mindmap mcp
```

```json [Claude Desktop / Cursor / Windsurf]
{
  "mcpServers": {
    "synapse": {
      "command": "npx",
      "args": ["-y", "synapse-mindmap", "mcp"],
      "env": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        "SYNAPSE_DATA_DIR": "/path/to/data"
      }
    }
  }
}
```

```json [OpenCode]
{
  "mcp": {
    "servers": {
      "synapse": {
        "type": "local",
        "command": ["npx", "-y", "synapse-mindmap", "mcp"],
        "environment": { "SYNAPSE_DATA_DIR": "/path/to/data" }
      }
    }
  }
}
```

```toml [Codex]
[mcp_servers.synapse]
command = "npx"
args = ["-y", "synapse-mindmap", "mcp"]
env = { SYNAPSE_DATA_DIR = "/path/to/data" }
```

```sh [Viewer]
SYNAPSE_DATA_DIR=/path/to/data npx synapse-mindmap viewer
```

:::

## Updating

Clients start Synapse with `npx -y synapse-mindmap`. npx keeps a copy of each package it downloads and reuses it, so after a new release your client may keep starting the version it fetched first.

Check which version you're running, and the latest on npm:

```sh
npx -y synapse-mindmap --version
npm view synapse-mindmap version
```

**To update once,** delete npx's cache, then restart the client (and any running viewer):

```sh
rm -rf ~/.npm/_npx                                          # macOS and Linux
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\npm-cache\_npx"  # Windows PowerShell
```

This clears everything npx has cached, not just Synapse. Other packages are downloaded again the next time you run them. If you've moved npm's cache, the `_npx` folder is inside that directory instead.

**To always run the latest release,** ask for `synapse-mindmap@latest` instead of `synapse-mindmap` in your client's config. For example, `"args": ["-y", "synapse-mindmap@latest", "mcp"]`, or for Claude Code:

```sh
claude mcp remove --scope user synapse
claude mcp add --scope user synapse -- npx -y synapse-mindmap@latest mcp
```

npx then checks npm for a newer version every time the client starts the server, which makes startup a little slower. `init` writes `synapse-mindmap` without `@latest`, so make this change by hand. Do the same for the viewer: `npx synapse-mindmap@latest viewer --open`.

## Troubleshooting

### The tools don't show up

- **Restart the client**, or reconnect its MCP servers. Clients read their MCP config at startup, and sessions that were already open keep their old tool list.
- **Check the client's view of the server:**

  ```sh
  claude mcp list     # Claude Code
  codex mcp list      # Codex / ChatGPT desktop
  opencode mcp list   # OpenCode (or /mcps inside OpenCode)
  ```

  In Claude Desktop, check **Settings → Developer**. In Cursor, check the MCP section of **Cursor Settings**.
- **Check your Node version.** `node --version` must be 20 or newer.
- **Check that the server starts on its own.** Run `npx -y synapse-mindmap mcp` in a terminal. It should print a ready message to stderr and then wait for input. Press `Ctrl+C` to quit.

### GUI apps can't find `npx`

Desktop apps such as Claude Desktop, Cursor, and Windsurf are often started without your shell's `PATH`. Then they can't find `npx` or `node`, especially when Node was installed with Homebrew, nvm, fnm, or Volta. On macOS and Linux, the installer adds an `env.PATH` entry. It lists the directories where it found `node` and `npx` on your `PATH`, followed by `/usr/local/bin:/usr/bin:/bin`. If you configure a client by hand, do the same. If you later switch Node versions, update that path or re-run `npx synapse-mindmap init --force`.

### `init` says the config is not plain JSON

The config file has comments or trailing commas, and `init` won't rewrite it because that would drop them. Add the snippet that `init` printed by hand.

### The viewer doesn't show the agent's mindmaps

The server and the viewer are reading different data directories. Make sure `SYNAPSE_DATA_DIR` is either unset in both places or set to the same path in both. The viewer prints the directory it uses when it starts.
