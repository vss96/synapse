# Agent Instructions

Synapse only shows what the agent tells it. This page covers what the server already tells agents, and how to add your own rules when an agent needs more prompting.

## What the server sends automatically

### Server instructions

When a client connects, the server sends these instructions in the MCP `initialize` response. Clients that support server instructions add them to the agent's system prompt, so no setup is needed:

```text
You have access to the Synapse MCP server for live mindmap tracking of your coding plan, touched files, and your mental model / High-Level Design (HLD) of the codebase.
Whenever you work on a multi-step coding task or explore a codebase:
1. PLAN: Start by calling `create_mindmap` with `title`, `workspacePath` (the project root), and `initialPlan` (your planned steps, with the first step set to `status: "in_progress"` and remaining steps set to `status: "planned"`).
2. MAP CODE MENTAL MODEL (HLD): Use `map_architecture` (and `link_nodes`) to visually map how you understand the code—create `component`, `data_flow`, `hypothesis`, `decision`, and `risk` nodes and connect them with labeled flow links (e.g., "calls", "streams SSE to", "mutates", "depends on").
3. TRACK CODE: As you inspect or edit files, call `log_file_touch` with `path`, `action` ("read", "create", "modify", "delete", "rename" + `previousPath`), optional `lines` (e.g. "20-85"), a brief `summary`, and `changes` describing each symbol-level edit: `{ kind: "add" | "modify" | "fix" | "refactor" | "rename" | "remove" | "test", symbol, previousSymbol?, detail? }` — e.g. a bug fix might log `fix validateToken`, `add isExpired`, `rename checkAuth → requireAuth`, `test "rejects expired tokens"`.
4. UPDATE PROGRESS: When finishing a step and moving to the next, call `update_plan_status` with `nodeId`, `status: "completed"`, and `nextNodeId` set to the next step's ID.
```

### The `track-coding-plan` prompt

The server also provides an MCP prompt named `track-coding-plan`. It sends the same workflow as a user message, followed by "Please apply this workflow to: &lt;task&gt;". Use it to start a tracked session explicitly.

| Argument | Required | Description |
|---|---|---|
| `task` | No | The coding task or goal to plan and track |
| `workspacePath` | No | Absolute path to the workspace repository |

Each client exposes MCP prompts differently. For example, it's `/mcp__synapse__track-coding-plan` in Claude Code and `/synapse:track-coding-plan` in OpenCode.

## Adding project rules

Some agents skip optional tools unless their rules file mentions them. If yours does, paste this into `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`, or your global agent rules:

```markdown
## Live Plan & Code Mindmap (Synapse MCP)

Always keep the user's Synapse mindmap updated as you work on coding tasks:
1. **Start of task**: Call `create_mindmap` with `title`, `workspacePath` (repo root), and `initialPlan` (list of planned steps, with the first step set to `status: "in_progress"`).
2. **Touching code**: Whenever you inspect or edit files, call `log_file_touch` (`mindmapId`, `path`, `action`: `"read"|"create"|"modify"|"delete"|"rename"` (+ `previousPath`), `lines`, `summary`, and `changes`: `[{ kind: "add"|"modify"|"fix"|"refactor"|"rename"|"remove"|"test", symbol, previousSymbol?, detail? }]`) — or call `sync_git_status` after edits to sync from git.
3. **Step transitions**: When finishing a step, call `update_plan_status` (`mindmapId`, `nodeId`, `status: "completed"`, `nextNodeId`) to complete the current step and mark the next step `"in_progress"`.
4. **New sub-tasks**: If the plan changes, add nodes with `add_node`.
```

The same snippet is kept in the repository as [`AGENT_INSTRUCTIONS.md`](https://github.com/vss96/synapse/blob/main/AGENT_INSTRUCTIONS.md). If you also want the agent to draw its mental model, add a line like this:

```markdown
5. **Mental model**: When you explore unfamiliar code, call `map_architecture` with `component`, `data_flow`, `decision`, `hypothesis`, and `risk` nodes and labeled `links` between them.
```

### As a skill

For agents that support skills, the repository includes a ready-made one at [`.agent/skills/synapse-tracker/SKILL.md`](https://github.com/vss96/synapse/blob/main/.agent/skills/synapse-tracker/SKILL.md). Copy it into your agent's skills directory, for example `.claude/skills/synapse-tracker/SKILL.md` for Claude Code. It explains when to use each node type and gives example `changes` entries.

## Tips for useful mindmaps

- **Keep plan steps coarse.** Four to eight steps read better than thirty. Add sub-tasks with `add_node` when a step turns out to be big.
- **Use `notes` for reasoning.** The Inspector shows them under "Agent Thinking / Notes". That's where hypotheses, trade-offs, and reasons for a status go.
- **Log one `changes` entry per symbol.** `fix validateToken` plus `test "rejects expired tokens"` tells the reviewer much more than "modified auth.ts".
- **Attach files to concepts too.** Passing `files` to a `map_architecture` node links a component to the code that implements it, and the viewer highlights it alongside the tasks.
- **Mark blocked steps.** Use `status: "blocked"` with a note explaining why, so a person can unblock it.
