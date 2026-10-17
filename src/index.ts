#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools.js";
import { VERSION } from "./version.js";

const AGENT_WORKFLOW_INSTRUCTIONS = `You have access to the Synapse MCP server for live mindmap tracking of your coding plan, touched files, and your mental model / High-Level Design (HLD) of the codebase.
Whenever you work on a multi-step coding task or explore a codebase:
1. PLAN: Start by calling \`create_mindmap\` with \`title\`, \`workspacePath\` (the project root), and \`initialPlan\` (your planned steps, with the first step set to \`status: "in_progress"\` and remaining steps set to \`status: "planned"\`).
2. MAP CODE MENTAL MODEL (HLD): Use \`map_architecture\` (and \`link_nodes\`) to visually map how you understand the code—create \`component\`, \`data_flow\`, \`hypothesis\`, \`decision\`, and \`risk\` nodes and connect them with labeled flow links (e.g., "calls", "streams SSE to", "mutates", "depends on").
3. TRACK CODE: As you inspect or edit files, call \`log_file_touch\` with \`path\`, \`action\` ("read", "create", "modify", "delete", "rename" + \`previousPath\`), optional \`lines\` (e.g. "20-85"), a brief \`summary\`, and \`changes\` describing each symbol-level edit: \`{ kind: "add" | "modify" | "fix" | "refactor" | "rename" | "remove" | "test", symbol, previousSymbol?, detail? }\` — e.g. a bug fix might log \`fix validateToken\`, \`add isExpired\`, \`rename checkAuth → requireAuth\`, \`test "rejects expired tokens"\`.
4. UPDATE PROGRESS: When finishing a step and moving to the next, call \`update_plan_status\` with \`nodeId\`, \`status: "completed"\`, and \`nextNodeId\` set to the next step's ID.`;

const server = new Server(
  { name: "synapse", version: VERSION },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
    instructions: AGENT_WORKFLOW_INSTRUCTIONS,
  },
);

/* List all available tools */
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

/* Route tool calls */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  try {
    return await tool.handler(request.params.arguments ?? {});
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

/* Expose MCP Prompts for any agent */
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "track-coding-plan",
      description:
        "Instruct the agent to create and continuously update a live Synapse mindmap tracking the plan and every file touched.",
      arguments: [
        {
          name: "task",
          description: "The coding task or goal to plan and track",
          required: false,
        },
        {
          name: "workspacePath",
          description: "Absolute path to the workspace repository",
          required: false,
        },
      ],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== "track-coding-plan") {
    throw new Error(`Unknown prompt: ${request.params.name}`);
  }
  const task = request.params.arguments?.task || "the current task";
  const workspace = request.params.arguments?.workspacePath || "";

  return {
    description: "Live coding plan & file tracking workflow using Synapse",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `${AGENT_WORKFLOW_INSTRUCTIONS}\n\nPlease apply this workflow to: ${task}${workspace ? `\nWorkspace path: ${workspace}` : ""}`,
        },
      },
    ],
  };
});

/* Start */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[synapse] MCP server ready on stdio");
}

main().catch((err) => {
  console.error("[synapse] Fatal:", err);
  process.exit(1);
});