# How It Works

## Architecture

```text
 ┌──────────────┐  stdio (MCP)  ┌───────────────────┐   writes   ┌──────────────────────────┐
 │ Coding agent │ ────────────▶ │ Synapse MCP server│ ─────────▶ │ SYNAPSE_DATA_DIR         │
 │ (any client) │               │ synapse-mindmap   │            │  mm_xxxxxxxx.json  …     │
 └──────────────┘               │ mcp               │            └────────────┬─────────────┘
                                └─────────┬─────────┘                         │ fs watch
                                          │ fs watch + git                    ▼
                                ┌─────────▼─────────┐            ┌──────────────────────────┐
                                │ Your workspace    │            │ Viewer server            │
                                │ (git repository)  │            │ synapse-mindmap viewer   │
                                └───────────────────┘            └────────────┬─────────────┘
                                                                              │ SSE
                                                                              ▼
                                                                         Browser UI
```

- **The MCP server** (`synapse-mindmap mcp`) is a stdio process that the client starts. Each tool call loads a mindmap document, changes it, and writes it back as `<mindmapId>.json` in the data directory.
- **The data directory** (`SYNAPSE_DATA_DIR`, default `~/.synapse/data`) is the only shared state. There is no database. The server and the viewer only share these files, so they can start and stop independently, and several agents or sessions can write to the same directory at once.
- **The viewer** (`synapse-mindmap viewer`) is a small HTTP server on `127.0.0.1` that reads the same store and watches the data directory. When a file changes, it pushes a `mindmap_updated` event to the browser over Server-Sent Events. Updates are debounced per file, so concurrent writes from different sessions don't hide each other. The browser then fetches that mindmap again.
- **Mindmap IDs** must match `[A-Za-z0-9_-]+`. Every lookup by the MCP tools and the viewer checks this, so an ID can't point outside the data directory.

### Viewer HTTP API

| Route | Description |
|---|---|
| `GET /` | The viewer page (`viewer/index.html`) |
| `GET /app.js` | The bundled viewer script |
| `GET /logo.png`, `GET /favicon.png` | Images |
| `GET /api/mindmaps` | Session list, newest first: `id`, `title`, `workspacePath`, `updatedAt`, `createdAt`, `nodeCount`, `completedTasks`, `totalTasks`, `activeTask`, `fileCount` |
| `GET /api/mindmaps/:id` | One full mindmap document |
| `POST /api/sync-git` | Body `{ "mindmapId": "…", "workspacePath"?: "…" }`. Runs [git sync](#git-sync) and returns `{ synced, mindmap }` |
| `GET /events` | SSE stream of `{ type: "connected" \| "mindmap_updated", id?, timestamp }` |

All routes return `403` unless the `Host` header is `localhost`, `127.0.0.1`, or `[::1]` on the viewer's port. This protects against DNS rebinding. `POST /api/sync-git` also requires `Content-Type: application/json`, rejects a cross-origin `Origin` with `403`, validates `mindmapId`, and needs a `workspacePath`, either from the mindmap or from the request body.

## Git sync and the workspace watcher

The agent doesn't have to log every file by hand. Two mechanisms attach changed files automatically.

### Git sync

Git sync runs when the agent calls `sync_git_status` or when you click **⎇ Sync Git** in the viewer. It runs `git status --porcelain` and `git diff --numstat HEAD` in the workspace and attaches each changed file to the active task:

| Git status | Action recorded |
|---|---|
| Untracked (`??`) or added (`A`) | `create` |
| Deleted (`D`) | `delete` |
| Staged rename (`R old -> new`) | `rename`, with `previousPath` |
| Anything else | `modify` |

Each file gets a summary such as `Git modify (+12/-3 lines)`. Paths that the workspace watcher ignores (see below) are skipped here too.

::: tip Renames
Git only reports a rename when it's **staged** (`git mv`, or `git add` on both paths). An unstaged rename shows up as a delete plus a create. When a rename is recorded with `previousPath`, it takes over the entry previously logged under the old path.
:::

### Workspace watcher

When a mindmap has a `workspacePath`, the MCP server watches that directory recursively. It starts watching when `create_mindmap` is called with `workspacePath`, or after `sync_git_status`. File events are batched every 600 ms and attached to the active task as `create`, `modify`, or `delete`, with the summary `Auto-detected file <action>`. The watcher:

- Runs inside the MCP server process, so it stops when the client stops the server. After a restart it starts again on the next `sync_git_status` call.
- Ignores `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, `.cache`, `.DS_Store`, `data/*.json`, and editor temp files (`*~`, `*.swp`, `*.tmp`).
- Doesn't detect renames.
- Fails silently where recursive file watching isn't supported.

### Where files are attached

`log_file_touch`, git sync, and the watcher all pick the target node the same way:

1. The node ID passed explicitly (`nodeId` / `targetNodeId`), if it exists.
2. Otherwise, the most recently updated node with status `in_progress`.
3. Otherwise, a top-level **Touched Files** node, which is created if it doesn't exist.

## Data model

A mindmap is one JSON document:

```json
{
  "id": "mm_Ab12Cd34",
  "title": "Add rate limiting",
  "workspacePath": "/Users/me/code/api",
  "createdAt": "2026-10-17T09:00:00.000Z",
  "updatedAt": "2026-10-17T09:12:41.000Z",
  "nodes": {
    "root": { "id": "root", "label": "Add rate limiting", "type": "root", "status": "in_progress", "parent": null, "children": ["n_x1y2z3"] },
    "n_x1y2z3": {
      "id": "n_x1y2z3",
      "label": "Add limiter middleware",
      "type": "task",
      "status": "in_progress",
      "parent": "root",
      "children": [],
      "files": [
        {
          "path": "src/middleware/rateLimit.ts",
          "action": "create",
          "lines": "1-48",
          "summary": "Token bucket per IP",
          "changes": [{ "kind": "add", "symbol": "rateLimit", "detail": "Express middleware" }],
          "timestamp": "2026-10-17T09:12:41.000Z"
        }
      ]
    }
  },
  "links": [],
  "activityLog": [{ "timestamp": "2026-10-17T09:12:41.000Z", "message": "[CREATE] src/middleware/rateLimit.ts (1 add) …" }]
}
```

IDs are generated: `mm_…` for mindmaps, `n_…` for nodes, and `l_…` for links. The root node is always `root`.

### Node types

| Group | Type | Use for |
|---|---|---|
| Plan | `root` | The mindmap's root (created automatically) |
| | `plan`, `task` | Plan steps and sub-tasks (`task` is the default) |
| | `file`, `code` | Nodes for a specific file or code region |
| | `note` | Free-form notes |
| Mental model (HLD) | `component` | Modules, services, layers, classes |
| | `data_flow` | Pipelines, protocols, state transitions |
| | `decision` | Design choices and their trade-offs |
| | `hypothesis` | What the agent suspects, such as the cause of a bug |
| | `risk` | Edge cases, bottlenecks, invariants to watch |

Progress counts only plan nodes. Mental-model concepts, `file` nodes, and `note` nodes don't count as tasks.

### Statuses

Only task nodes (`plan`, `task`, `code`) have a status: `planned` (the default), `in_progress`, `completed`, or `blocked`. The root, notes, file nodes and mental-model concepts have no status, so they never affect progress.

### Links

A link is a labeled, directed arrow between any two nodes: `{ id, from, to, label, style?, notes? }`. `style` is `solid` (the default), `dashed` (common for hypotheses and soft dependencies), or `animated` (common for live streams and events). A link is identified by its `from` + `to` + `label`. Writing the same link again updates its style and notes instead of adding a duplicate. Removing a node also removes its links.

### FileTouch

A file attached to a node:

| Field | Description |
|---|---|
| `path` | File path, relative to the workspace or absolute |
| `action` | `read`, `create`, `modify` (default), `delete`, or `rename` |
| `previousPath` | The old path, when `action` is `rename` |
| `lines` | Line range, such as `"45-120"` |
| `symbols` | Names of the functions, classes, or types touched |
| `changes` | Symbol-level `CodeChange` entries |
| `summary` | A short description |
| `timestamp` | When the touch was recorded (set automatically) |

Logging the same path on the same node again updates the existing entry instead of adding another. New fields replace old ones, and `changes` are merged.

### CodeChange and change kinds

A `CodeChange` is `{ kind, symbol, previousSymbol?, detail? }`. For renames, `symbol` is the new name and `previousSymbol` is the old one. Changes are merged on `kind` + `symbol`, so logging `fix validateToken` twice keeps a single entry, with the later details.

| Glyph | Kind | Viewer label | Example |
|---|---|---|---|
| `+` | `add` | Added | `add isExpired`: new helper |
| `~` | `modify` | Modified | `modify loadConfig`: reads a new env var |
| `✱` | `fix` | Fixed | `fix validateToken`: compare in UTC |
| `⟲` | `refactor` | Refactored | `refactor SessionStore`: extract interface |
| `↦` | `rename` | Renamed | `rename checkAuth → requireAuth` |
| `−` | `remove` | Removed | `remove legacyLogin` |
| `✓` | `test` | Tested | `test "rejects expired tokens"` |

### Activity log

Every change appends an entry to `activityLog`, newest first, with a timestamp, a message, and optionally `nodeId` and `file`. Each mindmap keeps its latest 100 entries.
