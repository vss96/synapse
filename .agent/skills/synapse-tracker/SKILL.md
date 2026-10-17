---
name: synapse-tracker
description: Automatically maintain a live Synapse mindmap of the coding plan, task statuses, touched files, and the agent's mental model / HLD of the codebase in real time.
---

# Synapse Live Plan, Code & Mental Model Tracking Skill

When working on any multi-step coding task, feature, bugfix, or codebase exploration, use the `synapse` MCP server tools so the user can visually see **how you are thinking about the code** and **what your plan is**:

## 1. Initialize the Plan (`create_mindmap`)
At the start of a task, call `create_mindmap` with:
- `title`: Name of the feature or task
- `workspacePath`: Absolute path to the workspace root
- `initialPlan`: Array of planned steps (first step `"in_progress"`, remaining `"planned"`).

## 2. Map Your Mental Model / HLD of the Code (`map_architecture` & `link_nodes`)
Instead of only explaining architecture in long walls of text, call `map_architecture` to visually map how the system works and how you are thinking about it:
- Use semantic node types:
  - `"component"`: Modules, services, layers, or classes (attach `files` to link them to source code)
  - `"data_flow"`: Pipelines, protocols, or state transitions
  - `"hypothesis"`: What you suspect is happening or causing a bug
  - `"decision"`: Architectural trade-offs and why a choice was made (e.g., "TypeScript vs Rust")
  - `"risk"`: Edge cases, bottlenecks, or invariants to watch out for
- Connect nodes with `links` (`from`, `to`, `label`, `style`: `"solid" | "dashed" | "animated"`) to show control/data flow (e.g., `"routes JSON-RPC to"`, `"streams SSE to"`, `"mutates"`).

## 3. Log Touched Files & Code (`log_file_touch` / `sync_git_status`)
Whenever you read, create, modify, rename, or delete an important file:
- Call `log_file_touch` (`mindmapId`, `path`, `action`, `previousPath` for renames, `lines`, `summary`).
- Include `changes` so the user can follow *what* is changing, one entry per symbol:
  - `{ kind: "add", symbol: "isExpired", detail: "new helper for TTL check" }`
  - `{ kind: "fix", symbol: "validateToken", detail: "compare in UTC" }`
  - `{ kind: "rename", previousSymbol: "checkAuth", symbol: "requireAuth" }`
  - `{ kind: "refactor" | "modify" | "remove" | "test", symbol: ... }`

## 4. Advance Plan Status (`update_plan_status`)
As you complete each step and move to the next, call `update_plan_status` (`mindmapId`, `nodeId`, `status: "completed"`, `nextNodeId`).
