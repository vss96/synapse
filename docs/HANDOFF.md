# Handoff: Sessions sidebar, change semantics, OpenCode MCP setup

Date: 2026-10-17 · Repo: `/Users/vss/Documents/synapse` · State: **all changes uncommitted** (on top of `348639d`)

## Goals of the session

1. See all sessions (mindmaps) on the left of the viewer and switch between them quickly.
2. Show *what kind* of change the agent is making (adding, fixing, renaming, removing, refactoring, testing), not just which files it touched.
3. Register the Synapse MCP server in OpenCode.

All three are done and verified.

## What changed

### Data model (`src/types.ts`)
- `FileAction` adds `"rename"`; `FileTouch` adds `previousPath` and `changes`.
- New `CodeChange { kind, symbol, previousSymbol?, detail? }`.
- `CHANGE_KINDS = add | modify | fix | refactor | rename | remove | test` and `FILE_ACTIONS` are exported constants and are the single source for the tool schemas.
- Backward compatible: all new fields are optional, so existing mindmap JSON loads unchanged.

### Server / tools
- `src/watcher.ts`
  - `upsertNodeFileTouch` merges `changes`: the same `kind` + `symbol` replaces the earlier entry, anything else is appended. A `rename` with `previousPath` takes over the entry previously logged under the old path.
  - `inspectGitChanges` reports staged renames (`R old -> new`) as `action: "rename"` with `previousPath`.
- `src/tools.ts`
  - Shared `FILE_TOUCH_PROPERTIES` / `CHANGES_SCHEMA` are used by both `log_file_touch` and `map_architecture`.
  - `log_file_touch` accepts `previousPath` and `changes`. Its activity message includes a tally (e.g. `(1 add, 1 fix)`).
  - `get_plan_summary` adds a `Code Changes:` line and lists each change under its file.
  - New exported helper `describeChanges()`.
- `src/renderer.ts`: the text output lists each change with a glyph (`+ ~ ✱ ⟲ ↦ − ✓`).
- `src/index.ts`, `AGENT_INSTRUCTIONS.md`, `.agent/skills/synapse-tracker/SKILL.md`, `README.md`: tell agents to send `changes`.

### Viewer
- `viewer/server.js`
  - Git sync now imports `inspectGitChanges` / `resolveTargetNodeForFile` / `upsertNodeFileTouch` / `recordActivity` from `../dist/` instead of keeping its own copy of that logic. It now needs a build (see below).
  - `/api/mindmaps` adds `activeTask`. Task counts now exclude HLD concept types, matching the viewer.
  - Live (SSE) updates are debounced per file. Before, a single shared timer meant concurrent writes from two sessions dropped one of the updates.
- `viewer/index.html`
  - The header dropdown is replaced by a left **Sessions** panel showing title, workspace, active task, progress, file count, relative time and a live dot (updated <2 min ago). It has a filter box, the ☰ collapse button (remembered in localStorage), **⌥↑/⌥↓** to switch, and `#<mindmapId>` in the URL.
  - Live updates now only reload the canvas when the updated mindmap is the one being viewed. Before, any update switched the view to that mindmap.
  - Node cards show a per-kind change tally row. File chips are colored by action, newest first.
  - The **Files** tab is renamed **Changes**. It has kind filter chips (which also highlight the matching nodes on the canvas), changed files newest first with their change rows, and a separate "Read for Context" section.
  - The Inspector shows each file's change rows. The legend includes the change glyphs; the zoom controls moved bottom-right.
- `package.json`: `viewer` script is now `tsc && node viewer/server.js`. `setup.sh` echo updated.

### Tests (`tests/tools.test.ts`)
Two new tests:
- change merging, rename taking over the old path's entry, summary/text output
- git staged-rename detection

The suite is 9/9 passing (`npm test`); `tsc --noEmit` is clean.

## OpenCode MCP setup

Added to the global config `~/.config/opencode/opencode.json` in the V2 format (`mcp.servers`), next to the existing V1-format `mcp.caveman` entry. The OpenCode docs say mixing the two formats inside `mcp` is supported.

```json
"servers": {
  "synapse": {
    "type": "local",
    "command": ["/opt/homebrew/bin/node", "/Users/vss/Documents/synapse/dist/index.js"],
    "environment": { "SYNAPSE_DATA_DIR": "/Users/vss/Documents/synapse/data" }
  }
}
```

- Backup of the original: `~/.config/opencode/opencode.json.bak-synapse`.
- The OpenCode log confirms `mcp connected server=synapse tools=14` for `~/` and `~/Documents`.
- The server runs from `dist/`, so **re-run `npx tsc` after changing `src/`** and restart/reconnect the server (`/mcps`). Sessions that were already running keep the old tool list.

## Verification performed
- `npm test` and `npx tsc --noEmit`.
- End-to-end: seeded two sessions in a temp data dir, ran the viewer on :4141, checked `/api/mindmaps` and `/api/sync-git`.
- Headless Chromium (Playwright's cached `chrome-headless-shell`, driven over CDP), with no JS exceptions. Checked: session list, change tally on cards, Changes tab, "Fixed" filter highlighting, Inspector change rows, ⌥↓ switching (URL hash updated).
- MCP stdio handshake via `node dist/index.js`.
- The real `data/` directory was not touched by testing.

## Known issues / risks
- **This session's working directory `/Users/vss/Documents/agent-mindmap` does not exist.** Synapse fails to connect for that directory only. Work from `/Users/vss/Documents/synapse` (or move the session there).
- `opencode mcp add/list` gets killed (exit 137) when run from inside an agent session, so the config was edited by hand. Run `opencode mcp list` from a normal terminal to double-check.
- Git only reports a rename when it is **staged** (`git mv` / `git add`). Unstaged renames still appear as delete + create. The fs watcher's auto-detected events don't detect renames either.
- `npm run viewer` now depends on `dist/` (gitignored). `setup.sh` and the `viewer` script both build it.
- The viewer has no automated UI tests; it was verified manually in a headless browser only.
- The README screenshots (`docs/screenshots/*`) predate the sidebar and Changes tab.
- The viewer shows unknown change kinds as `modify`. The server does not validate `kind` against the enum; this matches how existing fields are handled.

## Suggested next steps
1. Review and commit (13 modified files + this doc).
2. Re-take the README screenshots.
3. Optional: OpenCode sends `_meta["ai.opencode/sessionID"]` on each tool call, which could auto-link a mindmap to its OpenCode session (e.g. show the session ID in the sidebar, or reuse the mindmap per session).
4. Optional: expose `files` / `changes` on `update_node` (the type supports it but the schema doesn't advertise it; this predates this session).
5. Optional: let the change-kind filter also apply to the Inspector, or add a session-level change tally to `/api/mindmaps` for the sidebar.

## How to run
```bash
cd /Users/vss/Documents/synapse
npm test              # 9 tests
npm run viewer        # builds, then http://localhost:4040
```
