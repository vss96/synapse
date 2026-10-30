# MCP Tools

The Synapse server provides 14 tools. Agents normally only need the first five. The rest are for inspecting and editing mindmaps.

| Tool | Purpose |
|---|---|
| [`create_mindmap`](#create-mindmap) | Start a mindmap with a plan |
| [`map_architecture`](#map-architecture) | Record the mental model / HLD in one call |
| [`log_file_touch`](#log-file-touch) | Attach a file and its symbol-level changes |
| [`update_plan_status`](#update-plan-status) | Move a task forward and start the next one |
| [`sync_git_status`](#sync-git-status) | Attach all uncommitted git changes |
| [`link_nodes`](#link-nodes) | Draw a labeled arrow between two nodes |
| [`add_node`](#add-node) | Add a task, concept, or note |
| [`update_node`](#update-node) | Edit a node |
| [`remove_node`](#remove-node) | Delete a node and its subtree |
| [`get_plan_summary`](#get-plan-summary) | Progress report in Markdown |
| [`list_mindmaps`](#list-mindmaps) | List stored mindmaps |
| [`get_mindmap`](#get-mindmap) | Full mindmap JSON |
| [`render_mindmap`](#render-mindmap) | Render as Mermaid, text, or JSON |
| [`delete_mindmap`](#delete-mindmap) | Delete a mindmap |

**Return values.** Tools that modify a mindmap return a short JSON acknowledgement, not the whole document (which soon outgrows MCP clients' output limits): `mindmapId`, a one-line `summary`, and the nodes the call created or changed as `{ id, label, type, parent, status? }`, so the agent can read back generated node IDs. `create_mindmap` lists every plan node under `nodes`, `map_architecture` lists each `key` with its node, and `update_plan_status` adds `next`, and `log_file_touch` adds `fileNode` when `createChildNode` is set. `delete_mindmap` returns just `mindmapId` and `summary`. Use [`get_mindmap`](#get-mindmap) for the full document. Every input is validated before anything changes. Invalid input (an unknown enum value, a rename without `previousPath`, an ID with characters outside `[A-Za-z0-9_-]`) and impossible requests (an unknown or unreadable mindmap, an unknown node, a status on a node that isn't a task) come back as MCP tool errors (`isError: true`) with a message saying what to fix, and nothing is saved.

**Enums used below**

- *NodeType*: `plan`, `task`, `file`, `code`, `note`, `component`, `data_flow`, `hypothesis`, `decision`, `risk`
- *TaskStatus*: `planned`, `in_progress`, `completed`, `blocked`. Only task nodes (`plan`, `task`, `code`) have a status; setting one on any other node is an error.
- *FileAction*: `read`, `create`, `modify`, `delete`, `rename`
- *ChangeKind*: `add`, `modify`, `fix`, `refactor`, `rename`, `remove`, `test`
- *LinkStyle*: `solid`, `dashed`, `animated`

See [How It Works → Data model](../guide/how-it-works#data-model) for what these mean.

## `create_mindmap`

Create a new mindmap to track a coding plan, touched files, and the agent's mental model / HLD of the code.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | ✓ | Title of the mindmap / task |
| `rootLabel` | string | | Label for the root node (defaults to `title`) |
| `workspacePath` | string | | Absolute path to the project workspace/repo. It's used by git sync, and it starts the [workspace watcher](../guide/how-it-works#workspace-watcher), unless the plan's tasks are all completed. |
| `initialPlan` | PlanItem[] | | Plan steps to create under the root |

*PlanItem*: `{ label: string (required), type?: NodeType, status?: TaskStatus, notes?: string, children?: PlanItem[] }`. Children are one level deep, so they don't have their own `children`. `type` defaults to `task` and `status` defaults to `planned`.

```json
{
  "title": "Add rate limiting",
  "workspacePath": "/Users/me/code/api",
  "initialPlan": [
    { "label": "Read the auth flow", "status": "in_progress" },
    { "label": "Add limiter middleware" },
    { "label": "Write tests", "children": [{ "label": "Burst test" }] }
  ]
}
```

## `map_architecture`

Batch-record the agent's mental model & High-Level Design (HLD) of the codebase: components, data flows, hypotheses, design decisions, risks, and directed flow links between them.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |
| `parentId` | string | | Parent node for the new nodes. If omitted, uses the top-level "Code Mental Model (HLD)" branch, creating it if needed. |
| `nodes` | HldNode[] | ✓ | Nodes to create or update |
| `links` | HldLink[] | | Directed links between node keys or existing node IDs |

*HldNode*:

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | A short key (such as `mcp_server`) used to refer to this node in `links` and `parentKey`. If it matches an existing node ID, that node is **updated** instead of created. |
| `label` | string | ✓ | Name of the component, flow, hypothesis, or decision |
| `type` | string | | One of `component` (default), `data_flow`, `hypothesis`, `decision`, `risk`, `code`, `note` |
| `status` | TaskStatus | | Task types only |
| `notes` | string | | How the agent thinks about this piece, why it matters, trade-offs |
| `parentKey` | string | | Key from this call, or an existing node ID, to nest this node under |
| `files` | FileTouch[] | | Files that implement this concept (same fields as [`log_file_touch`](#log-file-touch); `path` required) |

*HldLink*: `{ from: string, to: string, label: string, style?: LinkStyle, notes?: string }` (`from`, `to`, and `label` are required). Links that refer to unknown keys are skipped.

```json
{
  "mindmapId": "mm_Ab12Cd34",
  "nodes": [
    { "key": "api", "label": "HTTP API", "type": "component", "files": [{ "path": "src/server.ts", "action": "read" }] },
    { "key": "store", "label": "Session store", "type": "component" },
    { "key": "why_redis", "label": "Use Redis for counters", "type": "decision", "notes": "Shared across instances" },
    { "key": "clock_skew", "label": "Clock skew between nodes", "type": "risk" }
  ],
  "links": [
    { "from": "api", "to": "store", "label": "reads/writes" },
    { "from": "why_redis", "to": "store", "label": "shapes", "style": "dashed" }
  ]
}
```

## `log_file_touch`

Record that a file was read, created, modified, renamed, or deleted, along with symbol-level `changes`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |
| `nodeId` | string | | Task or component to attach to. Defaults to the active `in_progress` node ([how the target is chosen](../guide/how-it-works#where-files-are-attached)). A `planned` task passed here is started (`in_progress`), so auto-detected changes follow it. |
| `path` | string | ✓ | File path, such as `src/tools.ts` |
| `action` | FileAction | | Defaults to `modify` |
| `previousPath` | string | | The old path, when `action` is `rename` |
| `lines` | string | | Line range touched, such as `45-120` |
| `symbols` | string[] | | Functions, classes, or types touched |
| `changes` | CodeChange[] | | Symbol-level changes (see below) |
| `summary` | string | | What changed in this file |
| `createChildNode` | boolean | | If `true`, also creates (or updates) a visible `file` child node under the target |

*CodeChange*: `{ kind: ChangeKind (required), symbol: string (required), previousSymbol?: string, detail?: string }`. For renames, `symbol` is the new name.

If other tasks are still `in_progress`, the reply includes a `hint` naming them, as a reminder to call `update_plan_status` when they're done.

```json
{
  "mindmapId": "mm_Ab12Cd34",
  "path": "src/auth/token.ts",
  "lines": "12-58",
  "summary": "Fix expiry check and rename guard",
  "changes": [
    { "kind": "fix", "symbol": "validateToken", "detail": "compare in UTC" },
    { "kind": "add", "symbol": "isExpired" },
    { "kind": "rename", "previousSymbol": "checkAuth", "symbol": "requireAuth" }
  ]
}
```

Logging the same path on the same node again updates the existing entry. Changes are merged on `kind` + `symbol`. The activity log records a tally such as `(1 add, 1 fix, 1 rename)`.

## `update_plan_status`

Update the status of a plan/task node and, optionally, start the next task in the same call.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |
| `nodeId` | string | ✓ | Task node to update |
| `status` | string | ✓ | `planned`, `in_progress`, `completed`, or `blocked` |
| `notes` | string | | Status note or completion summary (replaces the node's notes) |
| `nextNodeId` | string | | Node to mark `in_progress` |

## `sync_git_status`

Inspect `git status` and `git diff` in the workspace and attach every modified, created, deleted, or renamed file to the mindmap. See [Git sync](../guide/how-it-works#git-sync).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |
| `workspacePath` | string | | Repository path. Defaults to the mindmap's `workspacePath`, then the server's working directory. It's saved to the mindmap. |
| `targetNodeId` | string | | Node to attach changes to. Defaults to the active `in_progress` node. |

Returns `No uncommitted git changes detected in <path>.` when the tree is clean. Like any tool that changes a mindmap, it also points the workspace watcher at this mindmap, unless all its tasks are completed.

## `link_nodes`

Create a directed conceptual or data/control-flow link between two nodes, such as "calls", "streams SSE to", "mutates", "depends on", or "triggers".

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |
| `from` | string | ✓ | Source node ID |
| `to` | string | ✓ | Target node ID |
| `label` | string | ✓ | Relationship label |
| `style` | LinkStyle | | `animated` suits live streams and events. `dashed` suits hypotheses and dependencies. Defaults to `solid`. |
| `notes` | string | | Details about the relationship |

A link with the same `from`, `to`, and `label` as an existing one updates that link.

## `add_node`

Add a child node under a parent. This works for plan nodes (`plan`, `task`, `file`, `note`) and for mental-model nodes (`component`, `data_flow`, `hypothesis`, `decision`, `risk`).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |
| `parentId` | string | ✓ | Parent node ID. Use `root` for top-level steps. |
| `label` | string | ✓ | Node label |
| `type` | NodeType | | Defaults to `task` |
| `status` | TaskStatus | | Task types only; defaults to `planned` |
| `notes` | string | | Notes, rationale, hypothesis details, or trade-offs |

## `update_node`

Update a node's label, status, type, or notes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |
| `nodeId` | string | ✓ | Node to update |
| `label` | string | | New label |
| `type` | NodeType | | New type |
| `status` | TaskStatus | | New status |
| `notes` | string | | New notes |

## `remove_node`

Remove a node and all its descendants, along with any links that touch them. The root can't be removed. Use `delete_mindmap` instead.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |
| `nodeId` | string | ✓ | Node to remove |

## `get_plan_summary`

Get a Markdown status report: completion percentage, a status breakdown, the number of HLD concepts and links, a tally of code changes, in-progress and blocked tasks, and every touched file with its changes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |

## `list_mindmaps`

List all stored mindmaps with their IDs, titles, node counts, and last-updated timestamps, most recent first. Sessions archived in the viewer are marked `archived`, and mindmap files that can't be read are listed with the reason. No parameters.

## `get_mindmap`

Get a mindmap's full data as JSON.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |

## `render_mindmap`

Render a mindmap as text.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |
| `format` | string | ✓ | `mermaid` (Mermaid `mindmap` syntax), `text` (an indented outline with status badges, files, change glyphs, and links), or `json` |

## `delete_mindmap`

Delete a mindmap and all its nodes. This removes its JSON file from the data directory.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mindmapId` | string | ✓ | Mindmap ID |

## Prompt: `track-coding-plan`

Besides tools, the server provides one MCP prompt. See [Agent Instructions](../guide/agent-instructions#the-track-coding-plan-prompt).
