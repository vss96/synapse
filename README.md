# Synapse – Live Plan, Code & Mental Model Mindmap for Any Agent

**Synapse** is an MCP server + live web viewer that lets **any coding agent** (Claude Code, Antigravity, Cursor, Claude Desktop, Windsurf, etc.) maintain a real-time visual mindmap of:
1. **What the plan is** (hierarchical tasks with `planned`, `in_progress`, `completed`, and `blocked` statuses)
2. **How the agent is thinking about the code (HLD / Mental Model)** (semantic `component`, `data_flow`, `decision`, `hypothesis`, and `risk` cards connected by directed flow links)
3. **Which files and symbols are being touched** (line ranges, symbols, diff summaries, and cross-highlighting between plan tasks and architectural components)

---

## Screenshots

### 1. Code Mental Model & High-Level Design (HLD) View
Visualize how the agent understands the system architecture, data flows, design decisions, hypotheses, and risks—without reading walls of text:

![Code Mental Model (HLD) View](docs/screenshots/hld-mental-model.png)

### 2. Split View (Plan Tree + Code Mental Model)
See the full execution plan and the architectural mental model side-by-side in a single live canvas. The **Sessions** panel on the left lists every mindmap with its active task, progress, and a live dot; filter it or switch with **⌥↑/⌥↓**:

![Split View – Plan + HLD](docs/screenshots/split-view.png)

### 3. Plan & Tasks View + Changes Tab
The **Changes** tab shows what kind of change the agent made in each file (added, modified, fixed, refactored, renamed, removed, tested). Pick a kind to highlight every plan task and HLD component with that kind of change:

![Plan & Tasks View with the Changes tab filtered to fixes](docs/screenshots/plan-and-files.png)

### 4. Live Activity Stream
Track a real-time chronological log of every plan update, HLD mapping, and file edit:

![Live Activity Stream](docs/screenshots/activity-feed.png)

---

## Quick Start

Development uses [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`); the MCP server is built to `dist/` and runs on Node ≥ 18.

```bash
# Install, build & write claude.json
./setup.sh

# Run tests
bun test

# Rebuild dist/ after changing src/ (or keep `bun run build:watch` running)
bun run build

# Start the live web viewer (auto-updates via Server-Sent Events)
bun run viewer
# → http://localhost:4040
```

## MCP Tools

| Tool | Description |
|---|---|
| `create_mindmap` | Create a new mindmap with `title`, `workspacePath`, and optional `initialPlan` steps |
| `map_architecture` | Batch-record the agent's mental model / HLD (`component`, `data_flow`, `decision`, `hypothesis`, `risk` nodes + directed `links`) |
| `link_nodes` | Create a directed conceptual or data/control-flow arrow between two nodes (`solid`, `dashed`, or `animated`) |
| `update_plan_status` | Mark a task node `planned`, `in_progress`, `completed`, or `blocked`, and optionally start `nextNodeId` |
| `log_file_touch` | Attach a touched file (`path`, `action` incl. `rename` + `previousPath`, `lines`, `summary`) and symbol-level `changes` (`add`, `modify`, `fix`, `refactor`, `rename`, `remove`, `test`) to the active task or component node |
| `sync_git_status` | Inspect `git status` & `git diff` in the workspace and auto-attach changed files (including staged renames) to the mindmap |
| `get_plan_summary` | Render a Markdown dashboard of task progress (%), HLD concept count, and all touched files |
| `add_node` | Add a child task, plan step, HLD concept, file, or note node |
| `update_node` | Update a node's label, status, semantic type, notes, or files |
| `remove_node` | Remove a node and all its descendants |
| `list_mindmaps` | List all stored mindmaps sorted by most recently updated |
| `get_mindmap` | Get full mindmap data as JSON |
| `render_mindmap` | Render as `mermaid`, indented `text`, or `json` |
| `delete_mindmap` | Delete an entire mindmap |

## Connect to Any Agent

### 1. MCP Server Config (`claude.json` / `mcp_config.json`)
```json
{
  "mcpServers": {
    "synapse": {
      "command": "node",
      "args": ["/Users/vss/Documents/synapse/dist/index.js"],
      "env": {
        "SYNAPSE_DATA_DIR": "/Users/vss/Documents/synapse/data"
      }
    }
  }
}
```

### 2. Automatic Agent Behavior
- **Built-in MCP Instructions & Prompt**: Synapse automatically advertises server instructions and the `track-coding-plan` MCP prompt to connected clients.
- **Skill / Rules**:
  - For skill-supporting agents (like Antigravity / Claude): see [`.agent/skills/synapse-tracker/SKILL.md`](.agent/skills/synapse-tracker/SKILL.md).
  - For `CLAUDE.md` / `.cursorrules`: copy the snippet from [`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md).