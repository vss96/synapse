# Synapse Agent Instructions (Copy into `CLAUDE.md`, `.cursorrules`, or Agent Rules)

Paste the snippet below into your project's `CLAUDE.md`, `.cursorrules`, `.windsurfrules`, or global agent rules so **any agent** automatically maintains the live mindmap as it plans and touches code:

```markdown
## Live Plan & Code Mindmap (Synapse MCP)

Always keep the user's Synapse mindmap updated as you work on coding tasks:
1. **Start of task**: Call `create_mindmap` with `title`, `workspacePath` (repo root), and `initialPlan` (list of planned steps, with the first step set to `status: "in_progress"`).
2. **Touching code**: Whenever you inspect or edit files, call `log_file_touch` (`mindmapId`, `path`, `action`: `"read"|"create"|"modify"|"delete"|"rename"` (+ `previousPath`), `lines`, `summary`, and `changes`: `[{ kind: "add"|"modify"|"fix"|"refactor"|"rename"|"remove"|"test", symbol, previousSymbol?, detail? }]`) — or call `sync_git_status` after edits to sync from git.
3. **Step transitions**: When finishing a step, call `update_plan_status` (`mindmapId`, `nodeId`, `status: "completed"`, `nextNodeId`) to complete the current step and mark the next step `"in_progress"`.
4. **New sub-tasks**: If the plan changes, add nodes with `add_node`.
```
