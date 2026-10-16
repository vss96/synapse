import { nanoid } from "nanoid";
import * as store from "./store.js";
import { render } from "./renderer.js";
import {
  ensureWorkspaceWatcher,
  inspectGitChanges,
  resolveTargetNodeForFile,
  upsertNodeFileTouch,
} from "./watcher.js";
import type {
  MindmapDocument,
  MindmapNode,
  CreateMindmapInput,
  AddNodeInput,
  UpdateNodeInput,
  RemoveNodeInput,
  LogFileTouchInput,
  UpdatePlanStatusInput,
  SyncGitStatusInput,
  LinkNodesInput,
  MapArchitectureInput,
} from "./types.js";

const NODE_TYPE_ENUM = [
  "plan",
  "task",
  "file",
  "code",
  "note",
  "component",
  "data_flow",
  "hypothesis",
  "decision",
  "risk",
];

/* ------------------------------------------------------------------ */
/*  create_mindmap                                                     */
/* ------------------------------------------------------------------ */

async function createMindmap(input: CreateMindmapInput): Promise<MindmapDocument> {
  const id = `mm_${nanoid(8)}`;
  const now = new Date().toISOString();
  const rootLabel = input.rootLabel ?? input.title;

  const root: MindmapNode = {
    id: "root",
    label: rootLabel,
    type: "root",
    status: "in_progress",
    children: [],
    parent: null,
    updatedAt: now,
  };

  const doc: MindmapDocument = {
    id,
    title: input.title,
    workspacePath: input.workspacePath,
    createdAt: now,
    updatedAt: now,
    nodes: { root },
    links: [],
    activityLog: [],
  };

  store.recordActivity(doc, `Created mindmap "${input.title}"`, { nodeId: "root" });

  // Populate initialPlan if provided
  if (Array.isArray(input.initialPlan)) {
    for (const item of input.initialPlan) {
      const stepId = `n_${nanoid(6)}`;
      const stepNode: MindmapNode = {
        id: stepId,
        label: item.label,
        type: item.type ?? "task",
        status: item.status ?? "planned",
        notes: item.notes,
        children: [],
        parent: "root",
        updatedAt: now,
      };
      doc.nodes[stepId] = stepNode;
      root.children.push(stepId);

      if (Array.isArray(item.children)) {
        for (const sub of item.children) {
          const subId = `n_${nanoid(6)}`;
          const subNode: MindmapNode = {
            id: subId,
            label: sub.label,
            type: sub.type ?? "task",
            status: sub.status ?? "planned",
            notes: sub.notes,
            children: [],
            parent: stepId,
            updatedAt: now,
          };
          doc.nodes[subId] = subNode;
          stepNode.children.push(subId);
        }
      }
    }
  }

  await store.save(doc);
  if (doc.workspacePath) {
    ensureWorkspaceWatcher(doc.id, doc.workspacePath);
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/*  add_node                                                           */
/* ------------------------------------------------------------------ */

async function addNode(input: AddNodeInput): Promise<MindmapDocument | string> {
  const doc = await store.load(input.mindmapId);
  if (!doc) return `Mindmap "${input.mindmapId}" not found.`;

  const parent = doc.nodes[input.parentId];
  if (!parent) return `Parent node "${input.parentId}" not found.`;

  const now = new Date().toISOString();
  const id = `n_${nanoid(6)}`;
  const nodeType = input.type ?? "task";
  const defaultStatus = ["component", "data_flow", "hypothesis", "decision", "risk", "note"].includes(nodeType)
    ? "none"
    : "planned";

  const node: MindmapNode = {
    id,
    label: input.label,
    type: nodeType,
    status: input.status ?? defaultStatus,
    notes: input.notes,
    files: input.files,
    children: [],
    parent: input.parentId,
    updatedAt: now,
  };

  doc.nodes[id] = node;
  parent.children.push(id);
  store.recordActivity(doc, `Added ${nodeType} node "${input.label}"`, { nodeId: id });
  await store.save(doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/*  update_node                                                        */
/* ------------------------------------------------------------------ */

async function updateNode(input: UpdateNodeInput): Promise<MindmapDocument | string> {
  const doc = await store.load(input.mindmapId);
  if (!doc) return `Mindmap "${input.mindmapId}" not found.`;

  const node = doc.nodes[input.nodeId];
  if (!node) return `Node "${input.nodeId}" not found.`;

  if (input.label !== undefined) node.label = input.label;
  if (input.type !== undefined) node.type = input.type;
  if (input.status !== undefined) node.status = input.status;
  if (input.notes !== undefined) node.notes = input.notes;
  if (input.files !== undefined) {
    for (const f of input.files) {
      upsertNodeFileTouch(node, f);
    }
  }
  node.updatedAt = new Date().toISOString();

  store.recordActivity(
    doc,
    `Updated node "${node.label}"${input.status ? ` → ${input.status}` : ""}`,
    { nodeId: node.id },
  );
  await store.save(doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/*  link_nodes                                                         */
/* ------------------------------------------------------------------ */

function upsertLink(
  doc: MindmapDocument,
  from: string,
  to: string,
  label: string,
  style?: "solid" | "dashed" | "animated",
  notes?: string,
): void {
  if (!doc.links) doc.links = [];
  const existing = doc.links.find((l) => l.from === from && l.to === to && l.label === label);
  if (existing) {
    if (style !== undefined) existing.style = style;
    if (notes !== undefined) existing.notes = notes;
  } else {
    doc.links.push({
      id: `l_${nanoid(6)}`,
      from,
      to,
      label,
      style: style ?? "solid",
      notes,
    });
  }
}

async function linkNodes(input: LinkNodesInput): Promise<MindmapDocument | string> {
  const doc = await store.load(input.mindmapId);
  if (!doc) return `Mindmap "${input.mindmapId}" not found.`;

  if (!doc.nodes[input.from]) return `Source node "${input.from}" not found.`;
  if (!doc.nodes[input.to]) return `Target node "${input.to}" not found.`;

  upsertLink(doc, input.from, input.to, input.label, input.style, input.notes);

  store.recordActivity(
    doc,
    `Linked "${doc.nodes[input.from].label}" ──[${input.label}]──▶ "${doc.nodes[input.to].label}"`,
    { nodeId: input.from },
  );
  await store.save(doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/*  map_architecture                                                   */
/* ------------------------------------------------------------------ */

async function mapArchitecture(input: MapArchitectureInput): Promise<MindmapDocument | string> {
  const doc = await store.load(input.mindmapId);
  if (!doc) return `Mindmap "${input.mindmapId}" not found.`;

  const now = new Date().toISOString();

  // Resolve or create the HLD container branch under root if parentId not provided
  let containerId = input.parentId;
  if (!containerId || !doc.nodes[containerId]) {
    const existingHld = Object.values(doc.nodes).find(
      (n) =>
        n.parent === "root" &&
        n.type === "component" &&
        (n.label.toLowerCase().includes("mental model") ||
          n.label.toLowerCase().includes("hld") ||
          n.label.toLowerCase().includes("architecture")),
    );
    if (existingHld) {
      containerId = existingHld.id;
    } else {
      containerId = `n_${nanoid(6)}`;
      doc.nodes[containerId] = {
        id: containerId,
        label: "Code Mental Model (HLD)",
        type: "component",
        status: "none",
        notes: "High-level architecture, data flows, hypotheses, and design decisions",
        children: [],
        parent: "root",
        updatedAt: now,
      };
      doc.nodes["root"].children.push(containerId);
    }
  }

  const keyToNodeId = new Map<string, string>();
  // Pre-seed existing node IDs so keys can also refer to existing nodes
  for (const id of Object.keys(doc.nodes)) {
    keyToNodeId.set(id, id);
  }

  // First pass: create or update all nodes
  for (const item of input.nodes || []) {
    const existingId = doc.nodes[item.key] ? item.key : undefined;
    const nodeId = existingId ?? `n_${nanoid(6)}`;
    keyToNodeId.set(item.key, nodeId);

    if (existingId) {
      const existingNode = doc.nodes[existingId];
      existingNode.label = item.label ?? existingNode.label;
      if (item.type) existingNode.type = item.type;
      if (item.status) existingNode.status = item.status;
      if (item.notes) existingNode.notes = item.notes;
      if (item.files) {
        for (const f of item.files) upsertNodeFileTouch(existingNode, f);
      }
      existingNode.updatedAt = now;
    } else {
      doc.nodes[nodeId] = {
        id: nodeId,
        label: item.label,
        type: item.type ?? "component",
        status: item.status ?? "none",
        notes: item.notes,
        files: item.files ? [...item.files] : undefined,
        children: [],
        parent: containerId,
        updatedAt: now,
      };
    }
  }

  // Second pass: wire parent-child relationships
  for (const item of input.nodes || []) {
    const nodeId = keyToNodeId.get(item.key)!;
    const node = doc.nodes[nodeId];
    const desiredParentId =
      (item.parentKey && keyToNodeId.get(item.parentKey)) || containerId!;

    if (doc.nodes[desiredParentId] && desiredParentId !== nodeId) {
      node.parent = desiredParentId;
      const parent = doc.nodes[desiredParentId];
      if (!parent.children.includes(nodeId)) {
        parent.children.push(nodeId);
      }
    }
  }

  // Third pass: wire directed flow/concept links
  let linkCount = 0;
  for (const link of input.links || []) {
    const fromId = keyToNodeId.get(link.from);
    const toId = keyToNodeId.get(link.to);
    if (fromId && toId && doc.nodes[fromId] && doc.nodes[toId]) {
      upsertLink(doc, fromId, toId, link.label, link.style, link.notes);
      linkCount++;
    }
  }

  store.recordActivity(
    doc,
    `Mapped HLD mental model: ${(input.nodes || []).length} node(s), ${linkCount} flow link(s)`,
    { nodeId: containerId },
  );

  await store.save(doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/*  update_plan_status                                                 */
/* ------------------------------------------------------------------ */

async function updatePlanStatus(input: UpdatePlanStatusInput): Promise<MindmapDocument | string> {
  const doc = await store.load(input.mindmapId);
  if (!doc) return `Mindmap "${input.mindmapId}" not found.`;

  const node = doc.nodes[input.nodeId];
  if (!node) return `Node "${input.nodeId}" not found.`;

  const now = new Date().toISOString();
  node.status = input.status;
  if (input.notes !== undefined) {
    node.notes = input.notes;
  }
  node.updatedAt = now;

  store.recordActivity(doc, `Task "${node.label}" marked ${input.status}`, {
    nodeId: node.id,
  });

  if (input.nextNodeId && doc.nodes[input.nextNodeId]) {
    const nextNode = doc.nodes[input.nextNodeId];
    nextNode.status = "in_progress";
    nextNode.updatedAt = now;
    store.recordActivity(doc, `Started task "${nextNode.label}"`, {
      nodeId: nextNode.id,
    });
  }

  await store.save(doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/*  log_file_touch                                                     */
/* ------------------------------------------------------------------ */

async function logFileTouch(input: LogFileTouchInput): Promise<MindmapDocument | string> {
  const doc = await store.load(input.mindmapId);
  if (!doc) return `Mindmap "${input.mindmapId}" not found.`;

  const targetNode = resolveTargetNodeForFile(doc, input.nodeId);
  const action = input.action ?? "modify";

  upsertNodeFileTouch(targetNode, {
    path: input.path,
    action,
    lines: input.lines,
    symbols: input.symbols,
    summary: input.summary,
    timestamp: new Date().toISOString(),
  });

  if (input.createChildNode) {
    const existingChild = targetNode.children
      .map((cid) => doc.nodes[cid])
      .find((c) => c && c.type === "file" && c.label.includes(input.path));

    const label = `${input.path}${input.lines ? `:${input.lines}` : ""}`;
    if (existingChild) {
      existingChild.label = label;
      existingChild.notes = input.summary ?? existingChild.notes;
      existingChild.updatedAt = new Date().toISOString();
      upsertNodeFileTouch(existingChild, {
        path: input.path,
        action,
        lines: input.lines,
        symbols: input.symbols,
        summary: input.summary,
      });
    } else {
      const childId = `n_${nanoid(6)}`;
      doc.nodes[childId] = {
        id: childId,
        label,
        type: "file",
        status: action === "read" ? "none" : "completed",
        notes: input.summary,
        files: [
          {
            path: input.path,
            action,
            lines: input.lines,
            symbols: input.symbols,
            summary: input.summary,
            timestamp: new Date().toISOString(),
          },
        ],
        children: [],
        parent: targetNode.id,
        updatedAt: new Date().toISOString(),
      };
      targetNode.children.push(childId);
    }
  }

  store.recordActivity(
    doc,
    `[${action.toUpperCase()}] ${input.path}${input.lines ? `:${input.lines}` : ""}${input.summary ? ` — ${input.summary}` : ""} (on "${targetNode.label}")`,
    { nodeId: targetNode.id, file: input.path },
  );

  await store.save(doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/*  sync_git_status                                                    */
/* ------------------------------------------------------------------ */

async function syncGitStatus(input: SyncGitStatusInput): Promise<MindmapDocument | string> {
  const doc = await store.load(input.mindmapId);
  if (!doc) return `Mindmap "${input.mindmapId}" not found.`;

  const workspacePath = input.workspacePath || doc.workspacePath || process.cwd();
  doc.workspacePath = workspacePath;

  const changes = await inspectGitChanges(workspacePath);
  if (changes.length === 0) {
    return `No uncommitted git changes detected in ${workspacePath}.`;
  }

  const targetNode = resolveTargetNodeForFile(doc, input.targetNodeId);
  for (const ch of changes) {
    upsertNodeFileTouch(targetNode, {
      path: ch.path,
      action: ch.action,
      summary: ch.summary,
      timestamp: new Date().toISOString(),
    });
  }

  store.recordActivity(
    doc,
    `Synced ${changes.length} changed file(s) from git status into "${targetNode.label}"`,
    { nodeId: targetNode.id },
  );

  await store.save(doc);
  ensureWorkspaceWatcher(doc.id, workspacePath);
  return doc;
}

/* ------------------------------------------------------------------ */
/*  get_plan_summary                                                   */
/* ------------------------------------------------------------------ */

const HLD_TYPES = new Set(["component", "data_flow", "hypothesis", "decision", "risk", "file", "note"]);

async function getPlanSummary(input: { mindmapId: string }): Promise<string> {
  const doc = await store.load(input.mindmapId);
  if (!doc) return `Mindmap "${input.mindmapId}" not found.`;

  const allNodes = Object.values(doc.nodes).filter((n) => n.id !== "root");
  const tasks = allNodes.filter((n) => !HLD_TYPES.has(n.type || "task"));
  const hldNodes = allNodes.filter((n) =>
    ["component", "data_flow", "hypothesis", "decision", "risk"].includes(n.type || ""),
  );
  const completed = tasks.filter((n) => n.status === "completed");
  const inProgress = tasks.filter((n) => n.status === "in_progress");
  const blocked = tasks.filter((n) => n.status === "blocked");
  const planned = tasks.filter((n) => !n.status || n.status === "planned");

  const fileMap = new Map<string, { action: string; tasks: string[]; summary?: string; lines?: string }>();
  for (const n of Object.values(doc.nodes)) {
    for (const f of n.files || []) {
      const existing = fileMap.get(f.path);
      if (existing) {
        if (!existing.tasks.includes(n.label)) existing.tasks.push(n.label);
        if (f.summary) existing.summary = f.summary;
        if (f.lines) existing.lines = f.lines;
        if (f.action) existing.action = f.action;
      } else {
        fileMap.set(f.path, {
          action: f.action || "modify",
          tasks: [n.label],
          summary: f.summary,
          lines: f.lines,
        });
      }
    }
  }

  const pct = tasks.length > 0 ? Math.round((completed.length / tasks.length) * 100) : 0;
  const lines: string[] = [
    `# Plan & Code Summary: ${doc.title} (${doc.id})`,
    `Progress: ${completed.length}/${tasks.length} tasks completed (${pct}%)`,
    `Status Breakdown: ${inProgress.length} in progress · ${planned.length} planned · ${completed.length} completed · ${blocked.length} blocked`,
    `Mental Model / HLD: ${hldNodes.length} concept node(s) · ${(doc.links || []).length} directed flow link(s)`,
    "",
  ];

  if (inProgress.length > 0) {
    lines.push("## Currently In Progress");
    for (const t of inProgress) {
      lines.push(`- [~] **${t.label}** (\`${t.id}\`)${t.notes ? ` — ${t.notes}` : ""}`);
    }
    lines.push("");
  }

  if (blocked.length > 0) {
    lines.push("## Blocked");
    for (const t of blocked) {
      lines.push(`- [!] **${t.label}** (\`${t.id}\`)${t.notes ? ` — ${t.notes}` : ""}`);
    }
    lines.push("");
  }

  lines.push(`## Touched Files (${fileMap.size})`);
  if (fileMap.size === 0) {
    lines.push("_No files logged yet._");
  } else {
    for (const [filePath, info] of fileMap.entries()) {
      const loc = info.lines ? `:${info.lines}` : "";
      const sum = info.summary ? ` — ${info.summary}` : "";
      lines.push(`- \`[${info.action.toUpperCase()}]\` **${filePath}${loc}**${sum} _(via: ${info.tasks.join(", ")})_`);
    }
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  remove_node                                                        */
/* ------------------------------------------------------------------ */

/** Recursively collect all descendant ids. */
function collectDescendantIds(doc: MindmapDocument, nodeId: string): string[] {
  const ids: string[] = [nodeId];
  const node = doc.nodes[nodeId];
  if (node) {
    for (const childId of node.children) {
      ids.push(...collectDescendantIds(doc, childId));
    }
  }
  return ids;
}

async function removeNode(input: RemoveNodeInput): Promise<MindmapDocument | string> {
  const doc = await store.load(input.mindmapId);
  if (!doc) return `Mindmap "${input.mindmapId}" not found.`;

  if (input.nodeId === "root") return "Cannot remove the root node. Delete the entire mindmap instead.";

  const node = doc.nodes[input.nodeId];
  if (!node) return `Node "${input.nodeId}" not found.`;

  // Remove from parent's children list
  if (node.parent && doc.nodes[node.parent]) {
    const parent = doc.nodes[node.parent];
    parent.children = parent.children.filter((c) => c !== input.nodeId);
  }

  // Collect and delete all descendants
  const toRemove = new Set(collectDescendantIds(doc, input.nodeId));
  for (const id of toRemove) {
    delete doc.nodes[id];
  }

  // Clean up any directed links referencing removed nodes
  if (doc.links) {
    doc.links = doc.links.filter((l) => !toRemove.has(l.from) && !toRemove.has(l.to));
  }

  store.recordActivity(doc, `Removed node "${node.label}" (${toRemove.size} node(s))`);
  await store.save(doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/*  list_mindmaps                                                      */
/* ------------------------------------------------------------------ */

async function listMindmaps(): Promise<string> {
  const items = await store.list();
  if (items.length === 0) return "No mindmaps yet.";
  return items
    .map((m) => `• ${m.id}  –  "${m.title}" (${m.nodeCount} nodes, updated ${m.updatedAt})`)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/*  render_mindmap                                                     */
/* ------------------------------------------------------------------ */

async function renderMindmap(input: { mindmapId: string; format: "mermaid" | "text" | "json" }): Promise<string> {
  const doc = await store.load(input.mindmapId);
  if (!doc) return `Mindmap "${input.mindmapId}" not found.`;
  return render(doc, { format: input.format });
}

/* ------------------------------------------------------------------ */
/*  get_mindmap                                                        */
/* ------------------------------------------------------------------ */

async function getMindmap(input: { mindmapId: string }): Promise<string> {
  const doc = await store.load(input.mindmapId);
  if (!doc) return `Mindmap "${input.mindmapId}" not found.`;
  return JSON.stringify(doc, null, 2);
}

/* ------------------------------------------------------------------ */
/*  delete_mindmap                                                     */
/* ------------------------------------------------------------------ */

async function deleteMindmap(input: { mindmapId: string }): Promise<string> {
  const ok = await store.remove(input.mindmapId);
  return ok ? `Mindmap "${input.mindmapId}" deleted.` : `Mindmap "${input.mindmapId}" not found.`;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatToolResult(result: unknown): { content: { type: string; text: string }[] } {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

/* ------------------------------------------------------------------ */
/*  Tool definitions (for MCP server)                                  */
/* ------------------------------------------------------------------ */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
}

export const tools: ToolDefinition[] = [
  {
    name: "create_mindmap",
    description:
      "Create a new mindmap to track a coding plan, touched files, and the agent's mental model / HLD of the code.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the mindmap / task" },
        rootLabel: { type: "string", description: "Optional label for the root node (defaults to title)" },
        workspacePath: {
          type: "string",
          description: "Optional absolute path to the project workspace/repo for git and file watching",
        },
        initialPlan: {
          type: "array",
          description: "Optional list of initial plan steps to create under the root node",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Step title" },
              type: { type: "string", enum: NODE_TYPE_ENUM },
              status: {
                type: "string",
                enum: ["none", "planned", "in_progress", "completed", "blocked"],
              },
              notes: { type: "string", description: "Implementation details or context" },
              children: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    type: { type: "string", enum: NODE_TYPE_ENUM },
                    status: {
                      type: "string",
                      enum: ["none", "planned", "in_progress", "completed", "blocked"],
                    },
                    notes: { type: "string" },
                  },
                  required: ["label"],
                },
              },
            },
            required: ["label"],
          },
        },
      },
      required: ["title"],
    },
    handler: async (args) => formatToolResult(await createMindmap(args as unknown as CreateMindmapInput)),
  },
  {
    name: "add_node",
    description:
      "Add a child node under a parent node. Supports both plan/task nodes ('plan', 'task', 'file', 'note') and semantic code-thinking nodes ('component', 'data_flow', 'hypothesis', 'decision', 'risk').",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
        parentId: { type: "string", description: "Parent node ID (use 'root' for top-level steps)" },
        label: { type: "string", description: "Node label text" },
        type: {
          type: "string",
          enum: NODE_TYPE_ENUM,
          description: "Semantic type of node (default: 'task')",
        },
        status: {
          type: "string",
          enum: ["none", "planned", "in_progress", "completed", "blocked"],
          description: "Initial status of the node",
        },
        notes: { type: "string", description: "Optional notes, rationale, hypothesis details, or trade-offs" },
      },
      required: ["mindmapId", "parentId", "label"],
    },
    handler: async (args) => formatToolResult(await addNode(args as unknown as AddNodeInput)),
  },
  {
    name: "update_node",
    description: "Update a node's label, status, semantic type, notes, or attached files.",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
        nodeId: { type: "string", description: "Node ID to update" },
        label: { type: "string", description: "New label text" },
        type: {
          type: "string",
          enum: NODE_TYPE_ENUM,
        },
        status: {
          type: "string",
          enum: ["none", "planned", "in_progress", "completed", "blocked"],
        },
        notes: { type: "string", description: "Updated notes or context" },
      },
      required: ["mindmapId", "nodeId"],
    },
    handler: async (args) => formatToolResult(await updateNode(args as unknown as UpdateNodeInput)),
  },
  {
    name: "link_nodes",
    description:
      "Create a directed conceptual or data/control-flow link between two nodes (e.g. 'calls', 'streams SSE to', 'mutates', 'depends on', 'triggers').",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
        from: { type: "string", description: "Source node ID" },
        to: { type: "string", description: "Target node ID" },
        label: { type: "string", description: "Flow or relationship label (e.g. 'calls', 'reads/writes')" },
        style: {
          type: "string",
          enum: ["solid", "dashed", "animated"],
          description: "Visual line style ('animated' is great for live streams/events, 'dashed' for hypotheses/dependencies)",
        },
        notes: { type: "string", description: "Optional details about this relationship or flow" },
      },
      required: ["mindmapId", "from", "to", "label"],
    },
    handler: async (args) => formatToolResult(await linkNodes(args as unknown as LinkNodesInput)),
  },
  {
    name: "map_architecture",
    description:
      "Batch-record the agent's mental model & High-Level Design (HLD) of the codebase: components, data flows, hypotheses, design decisions, risks, and directed flow links between them.",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
        parentId: {
          type: "string",
          description: "Optional parent node ID. If omitted, creates/uses a top-level 'Code Mental Model (HLD)' branch.",
        },
        nodes: {
          type: "array",
          description: "List of HLD / mental-model nodes to create or update",
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description: "Short symbolic key (e.g. 'mcp_server') or existing nodeId used to reference this node in links/parentKey",
              },
              label: { type: "string", description: "Human-readable name of the component, flow, hypothesis, or decision" },
              type: {
                type: "string",
                enum: ["component", "data_flow", "hypothesis", "decision", "risk", "code", "note"],
                description: "Semantic thinking type (default: 'component')",
              },
              status: {
                type: "string",
                enum: ["none", "planned", "in_progress", "completed", "blocked"],
              },
              notes: { type: "string", description: "How the agent thinks about this piece, why it matters, or trade-offs" },
              parentKey: {
                type: "string",
                description: "Optional key of another node in this call (or existing nodeId) to nest under",
              },
              files: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    action: { type: "string", enum: ["read", "create", "modify", "delete"] },
                    lines: { type: "string" },
                    symbols: { type: "array", items: { type: "string" } },
                    summary: { type: "string" },
                  },
                  required: ["path"],
                },
              },
            },
            required: ["key", "label"],
          },
        },
        links: {
          type: "array",
          description: "Directed flow or dependency links between node keys (or existing node IDs)",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "Source node key or ID" },
              to: { type: "string", description: "Target node key or ID" },
              label: { type: "string", description: "Relationship label (e.g. 'routes tool calls to', 'persists JSON via')" },
              style: { type: "string", enum: ["solid", "dashed", "animated"] },
              notes: { type: "string" },
            },
            required: ["from", "to", "label"],
          },
        },
      },
      required: ["mindmapId", "nodes"],
    },
    handler: async (args) => formatToolResult(await mapArchitecture(args as unknown as MapArchitectureInput)),
  },
  {
    name: "update_plan_status",
    description:
      "Update the execution status of a plan/task node (planned, in_progress, completed, blocked) and optionally start the next task node in one call.",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
        nodeId: { type: "string", description: "Task node ID to update" },
        status: {
          type: "string",
          enum: ["planned", "in_progress", "completed", "blocked"],
          description: "New status for the task",
        },
        notes: { type: "string", description: "Optional status note or completion summary" },
        nextNodeId: {
          type: "string",
          description: "Optional ID of the next task node to automatically transition to 'in_progress'",
        },
      },
      required: ["mindmapId", "nodeId", "status"],
    },
    handler: async (args) => formatToolResult(await updatePlanStatus(args as unknown as UpdatePlanStatusInput)),
  },
  {
    name: "log_file_touch",
    description:
      "Record that a file or code symbol was read, created, modified, or deleted. If nodeId is omitted, attaches to the currently in_progress task node.",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
        nodeId: {
          type: "string",
          description: "Optional task or component node ID. If omitted, attaches to the active in_progress task.",
        },
        path: { type: "string", description: "File path (e.g. 'src/tools.ts')" },
        action: {
          type: "string",
          enum: ["read", "create", "modify", "delete"],
          description: "Action performed on the file (default: 'modify')",
        },
        lines: { type: "string", description: "Optional line range touched (e.g. '45-120')" },
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of function/class/type symbols touched",
        },
        summary: { type: "string", description: "Short summary of what changed in this file" },
        createChildNode: {
          type: "boolean",
          description: "If true, also creates a visible child file node under the task node in the tree",
        },
      },
      required: ["mindmapId", "path"],
    },
    handler: async (args) => formatToolResult(await logFileTouch(args as unknown as LogFileTouchInput)),
  },
  {
    name: "sync_git_status",
    description:
      "Inspect git status and diff in the workspace and automatically attach all modified/created/deleted files to the mindmap.",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
        workspacePath: {
          type: "string",
          description: "Optional path to the git repository (defaults to mindmap's workspacePath)",
        },
        targetNodeId: {
          type: "string",
          description: "Optional node ID to attach git changes to (defaults to active in_progress node)",
        },
      },
      required: ["mindmapId"],
    },
    handler: async (args) => formatToolResult(await syncGitStatus(args as unknown as SyncGitStatusInput)),
  },
  {
    name: "get_plan_summary",
    description:
      "Get a concise status report of the mindmap plan: completion percentage, active tasks, blocked items, HLD concept count, and all touched files.",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
      },
      required: ["mindmapId"],
    },
    handler: async (args) => formatToolResult(await getPlanSummary(args as { mindmapId: string })),
  },
  {
    name: "remove_node",
    description: "Remove a node and all its descendants from a mindmap. Cannot remove the root.",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
        nodeId: { type: "string", description: "Node ID to remove" },
      },
      required: ["mindmapId", "nodeId"],
    },
    handler: async (args) => formatToolResult(await removeNode(args as unknown as RemoveNodeInput)),
  },
  {
    name: "list_mindmaps",
    description: "List all stored mindmaps with their IDs, titles, and last updated timestamps.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => formatToolResult(await listMindmaps()),
  },
  {
    name: "get_mindmap",
    description: "Get a mindmap's full data as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
      },
      required: ["mindmapId"],
    },
    handler: async (args) => formatToolResult(await getMindmap(args as { mindmapId: string })),
  },
  {
    name: "render_mindmap",
    description: "Render a mindmap in a digestible format: mermaid (flow chart syntax), text (indented outline), or json.",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
        format: { type: "string", enum: ["mermaid", "text", "json"], description: "Output format" },
      },
      required: ["mindmapId", "format"],
    },
    handler: async (args) =>
      formatToolResult(await renderMindmap(args as { mindmapId: string; format: "mermaid" | "text" | "json" })),
  },
  {
    name: "delete_mindmap",
    description: "Delete an entire mindmap and all its nodes.",
    inputSchema: {
      type: "object",
      properties: {
        mindmapId: { type: "string", description: "Mindmap ID" },
      },
      required: ["mindmapId"],
    },
    handler: async (args) => formatToolResult(await deleteMindmap(args as { mindmapId: string })),
  },
];