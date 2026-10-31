import path from "node:path";
import { z } from "zod";
import * as store from "./store.js";
import { RENDER_FORMATS, render } from "./renderer.js";
import { ensureWorkspaceWatcher, inspectGitChanges, repoRoot, stopWorkspaceWatcher } from "./watcher.js";
import { aggregateFiles } from "./model/file-stats.js";
import { collectsWorkspaceChanges, fileTouchTarget, upsertFileTouch, upsertFileTouches } from "./model/file-touch.js";
import { CHANGE_KINDS, FILE_ACTIONS, LINK_STYLES, NODE_TYPES, TASK_STATUSES, isConcept, isTask, isTaskType, type ChildNodeType, type LinkStyle, type TaskStatus } from "./model/kinds.js";
import { attachChild, createChild, reparent, retype } from "./model/node.js";
import {
  CodeChange,
  LinkId,
  MindmapId,
  NodeId,
  ROOT_ID,
  newLinkId,
  newMindmapId,
  now,
  type ChildNode,
  type FileTouch,
  type MindmapDocument,
  type MindmapLink,
  type MindmapListItem,
  type MindmapNode,
} from "./model/schema.js";

/* ------------------------------------------------------------------ */
/*  Tool plumbing                                                      */
/* ------------------------------------------------------------------ */

/** A failure the agent caused and can fix (unknown id, wrong node kind…); reported with isError. */
export class ToolError extends Error {}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  /** Parses `args` with `inputSchema`, runs the tool and formats the result. */
  handler: (args: unknown) => Promise<ToolResult>;
}

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

function defineTool<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>) => Promise<string | MindmapDocument | Ack>;
}): ToolDefinition {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: async (args) => {
      const input = def.inputSchema.safeParse(args ?? {});
      if (!input.success) return text(`Invalid input for ${def.name}:\n${z.prettifyError(input.error)}`, true);
      try {
        const result = await def.run(input.data);
        return text(typeof result === "string" ? result : JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof ToolError || err instanceof store.UnreadableMindmapError) return text(err.message, true);
        throw err;
      }
    },
  };
}

/**
 * What a tool that changes a mindmap reports back: the ids and statuses the agent needs to carry on,
 * not the whole document (which outgrows MCP output limits; `get_mindmap` returns it).
 */
type Ack = { mindmapId: MindmapId; summary: string } & Record<string, unknown>;

/** A node as reported in an Ack. */
function ref(node: MindmapNode) {
  return { id: node.id, label: node.label, type: node.type, parent: node.parent, ...(isTask(node) ? { status: node.status } : {}) };
}

async function loadMindmap(id: MindmapId): Promise<MindmapDocument> {
  const doc = await store.load(id);
  if (!doc) throw new ToolError(`Mindmap "${id}" not found.`);
  return doc;
}

/** Change a mindmap under its lock (see `store.update`); `mutate` returns the tool's reply. */
async function updateMindmap<T extends Ack>(id: MindmapId, mutate: (doc: MindmapDocument) => T): Promise<T> {
  let workspacePath: string | undefined;
  const result = await store.update(id, (doc) => {
    const reply = mutate(doc);
    if (collectsWorkspaceChanges(doc)) workspacePath = doc.workspacePath;
    return reply;
  });
  if (!result) throw new ToolError(`Mindmap "${id}" not found.`);
  // The mindmap an agent changes is the one it's working on, so its workspace's file changes go there,
  // even when an earlier server process created it. A note on a finished mindmap doesn't reopen it.
  ensureWorkspaceWatcher(id, workspacePath);
  return result;
}

function getNode(doc: MindmapDocument, id: NodeId, role = "Node"): MindmapNode {
  const node = doc.nodes[id];
  if (!node) throw new ToolError(`${role} "${id}" not found.`);
  return node;
}

function getChild(doc: MindmapDocument, id: NodeId): ChildNode {
  const node = getNode(doc, id);
  if (node.type === "root") throw new ToolError("The root node can't be changed this way.");
  return node;
}

/** A status only applies to tasks; asking for one on any other node is a mistake worth reporting. */
function statusFor(type: ChildNodeType, status: TaskStatus | undefined, label: string): TaskStatus | undefined {
  if (status !== undefined && !isTaskType(type)) {
    throw new ToolError(`"${label}" is a ${type} node; only plan/task/code nodes have a status.`);
  }
  return status;
}

const isDescendant = (doc: MindmapDocument, id: NodeId, ancestor: NodeId): boolean => {
  for (let cur = doc.nodes[id]; cur && cur.type !== "root"; cur = doc.nodes[cur.parent]) {
    if (cur.parent === ancestor) return true;
  }
  return false;
};

/** Move a node under a new parent, unless that would cut it and its subtree off from the root. */
function nestUnder(doc: MindmapDocument, node: ChildNode, parentId: NodeId): void {
  if (isDescendant(doc, parentId, node.id)) {
    throw new ToolError(`Can't nest "${node.label}" under its own descendant "${doc.nodes[parentId]?.label}".`);
  }
  reparent(doc, node, parentId);
}

/** Drop a node's touches of `paths` and return how many went. A path it doesn't have is an error, not a silent skip. */
function removeFileTouches(node: ChildNode, paths: readonly string[]): number {
  const unknown = paths.filter((p) => !node.files.some((f) => f.path === p));
  if (unknown.length > 0) throw new ToolError(`"${node.label}" has no file touch for: ${unknown.join(", ")}.`);
  const kept = node.files.filter((f) => !paths.includes(f.path));
  const removed = node.files.length - kept.length;
  node.files = kept;
  return removed;
}

/** "2 add, 1 fix" style tally, in CHANGE_KINDS order. */
export function describeChanges(changes: readonly CodeChange[]): string {
  return CHANGE_KINDS.map((kind) => [kind, changes.filter((c) => c.kind === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(", ");
}

/* ------------------------------------------------------------------ */
/*  Input schemas                                                      */
/* ------------------------------------------------------------------ */

const mindmapId = MindmapId.describe("Mindmap ID");
const ChildType = z.enum(NODE_TYPES).exclude(["root"]);
const Status = z.enum(TASK_STATUSES);
const Style = z.enum(LINK_STYLES);
const Label = z.string().trim().min(1);

const FileTouchInput = z
  .object({
    path: z.string().trim().min(1).describe("File path (e.g. 'src/tools.ts')"),
    action: z.enum(FILE_ACTIONS).default("modify").describe("Action performed on the file (default: 'modify')"),
    previousPath: z.string().trim().min(1).optional().describe("Old file path; required when action is 'rename'"),
    lines: z.string().optional().describe("Line range touched (e.g. '45-120')"),
    symbols: z.array(z.string()).optional().describe("Function/class/type symbols touched"),
    changes: z
      .array(CodeChange)
      .default([])
      .describe(
        "Symbol-level changes in this file, so the user can follow what is being added, fixed, refactored, renamed, removed, or tested. Renames need previousSymbol.",
      ),
    summary: z.string().optional().describe("Short summary of what changed in this file"),
  })
  .superRefine((t, ctx) => {
    if (t.action === "rename" && !t.previousPath) ctx.addIssue({ code: "custom", message: "A rename needs previousPath", path: ["previousPath"] });
    if (t.action === "read" && t.changes.length > 0) ctx.addIssue({ code: "custom", message: "A read can't have changes", path: ["changes"] });
  });
type FileTouchInput = z.infer<typeof FileTouchInput>;

function toFileTouch(input: FileTouchInput): FileTouch {
  const common = { path: input.path, lines: input.lines, symbols: input.symbols, summary: input.summary, timestamp: now() };
  if (input.action === "read") return { ...common, action: "read" };
  // FileTouchInput's superRefine rejects a rename without previousPath. Its type can't say so: the tool
  // schemas extend it as one object, with `action` defaulting to "modify", so it can't be a union.
  if (input.action === "rename") return { ...common, action: "rename", previousPath: input.previousPath!, changes: input.changes };
  return { ...common, action: input.action, changes: input.changes };
}

/* ------------------------------------------------------------------ */
/*  Tools                                                              */
/* ------------------------------------------------------------------ */

const createMindmap = defineTool({
  name: "create_mindmap",
  description: "Create a new mindmap to track a coding plan, touched files, and the agent's mental model / HLD of the code.",
  inputSchema: z.object({
    title: Label.describe("Title of the mindmap / task"),
    rootLabel: Label.optional().describe("Label for the root node (defaults to title)"),
    workspacePath: z.string().optional().describe("Absolute path to the project workspace/repo for git and file watching"),
    initialPlan: z
      .array(
        z.object({
          label: Label.describe("Step title"),
          type: ChildType.default("task"),
          status: Status.optional().describe("Tasks only (default: planned)"),
          notes: z.string().optional().describe("Implementation details or context"),
          children: z
            .array(z.object({ label: Label, type: ChildType.default("task"), status: Status.optional(), notes: z.string().optional() }))
            .optional(),
        }),
      )
      .optional()
      .describe("Initial plan steps to create under the root node"),
  }),
  async run(input) {
    const timestamp = now();
    const doc: MindmapDocument = {
      id: newMindmapId(),
      title: input.title,
      workspacePath: input.workspacePath,
      repoPath: input.workspacePath ? await repoRoot(input.workspacePath) : undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
      nodes: {
        [ROOT_ID]: { id: ROOT_ID, type: "root", parent: null, label: input.rootLabel ?? input.title, files: [], children: [], updatedAt: timestamp },
      },
      links: [],
      activityLog: [],
    };
    store.recordActivity(doc, `Created mindmap "${input.title}"`, { nodeId: ROOT_ID });

    for (const item of input.initialPlan ?? []) {
      const step = createChild({ ...item, status: statusFor(item.type, item.status, item.label), parent: ROOT_ID });
      attachChild(doc, step);
      for (const sub of item.children ?? []) {
        attachChild(doc, createChild({ ...sub, status: statusFor(sub.type, sub.status, sub.label), parent: step.id }));
      }
    }

    await store.save(doc);
    if (collectsWorkspaceChanges(doc)) ensureWorkspaceWatcher(doc.id, doc.workspacePath);
    const nodes = Object.values(doc.nodes).filter((n) => n.type !== "root").map(ref);
    return { mindmapId: doc.id, summary: `Created mindmap "${doc.title}" with ${nodes.length} node(s)`, nodes };
  },
});

const addNode = defineTool({
  name: "add_node",
  description:
    "Add a child node under a parent node. Supports both plan/task nodes ('plan', 'task', 'code', 'file', 'note') and semantic code-thinking nodes ('component', 'data_flow', 'hypothesis', 'decision', 'risk').",
  inputSchema: z.object({
    mindmapId,
    parentId: NodeId.describe("Parent node ID (use 'root' for top-level steps)"),
    label: Label.describe("Node label text"),
    type: ChildType.default("task").describe("Semantic type of node (default: 'task')"),
    status: Status.optional().describe("Initial status; tasks only (default: planned)"),
    notes: z.string().optional().describe("Notes, rationale, hypothesis details, or trade-offs"),
    files: z.array(FileTouchInput).optional(),
  }),
  run: (input) =>
    updateMindmap(input.mindmapId, (doc) => {
      getNode(doc, input.parentId, "Parent node");
      const node = createChild({
        ...input,
        parent: input.parentId,
        status: statusFor(input.type, input.status, input.label),
        files: input.files?.map(toFileTouch),
      });
      attachChild(doc, node);
      const summary = `Added ${node.type} node "${node.label}"`;
      store.recordActivity(doc, summary, { nodeId: node.id });
      return { mindmapId: doc.id, summary, node: ref(node) };
    }),
});

const updateNode = defineTool({
  name: "update_node",
  description:
    "Update a node's label, status, semantic type, notes, or attached files (record with `files`, drop with `removeFiles`), or move it and its subtree under another parent with `parentId`.",
  inputSchema: z.object({
    mindmapId,
    nodeId: NodeId.describe("Node ID to update"),
    label: Label.optional().describe("New label text"),
    type: ChildType.optional().describe("New semantic type"),
    status: Status.optional().describe("New status; tasks only"),
    notes: z.string().optional().describe("Updated notes or context"),
    files: z.array(FileTouchInput).optional().describe("File touches to record on this node"),
    removeFiles: z
      .array(z.string().trim().min(1))
      .optional()
      .describe("Paths to remove from this node's file touches, before `files` is applied. A path the node doesn't have is an error."),
    parentId: NodeId.optional().describe(
      "Move the node and its subtree under this parent. Its current parent changes nothing; itself or one of its descendants is an error.",
    ),
  }),
  run: (input) =>
    updateMindmap(input.mindmapId, (doc) => {
      let node = getChild(doc, input.nodeId);
      if (input.type && input.type !== node.type) node = retype(node, input.type);
      if (input.label !== undefined) node.label = input.label;
      if (input.notes !== undefined) node.notes = input.notes;
      const status = statusFor(node.type, input.status, node.label);
      if (status && isTask(node)) node.status = status;
      const removed = removeFileTouches(node, input.removeFiles ?? []);
      upsertFileTouches(node, input.files?.map(toFileTouch) ?? []);

      const parent = input.parentId ? getNode(doc, input.parentId, "Parent node") : undefined;
      if (parent?.id === node.id) throw new ToolError(`Can't nest "${node.label}" under itself.`);
      const moved = parent && parent.id !== node.parent ? parent : undefined;
      if (parent) nestUnder(doc, node, parent.id);

      node.updatedAt = now();
      doc.nodes[node.id] = node;

      const summary = `Updated node "${node.label}"${status ? ` → ${status}` : ""}${moved ? `, moved under "${moved.label}"` : ""}${removed ? `, removed ${removed} file touch(es)` : ""}`;
      store.recordActivity(doc, summary, { nodeId: node.id });
      return { mindmapId: doc.id, summary, node: ref(node) };
    }),
});

function upsertLink(doc: MindmapDocument, link: { from: NodeId; to: NodeId; label: string; style?: LinkStyle; notes?: string }): void {
  const existing = doc.links.find((l) => l.from === link.from && l.to === link.to && l.label === link.label);
  if (existing) {
    if (link.style !== undefined) existing.style = link.style;
    if (link.notes !== undefined) existing.notes = link.notes;
  } else {
    doc.links.push({ id: newLinkId(), ...link, style: link.style ?? "solid" });
  }
}

const linkNodes = defineTool({
  name: "link_nodes",
  description:
    "Create a directed concept or data-flow link between two nodes (e.g. 'calls', 'streams SSE to', 'mutates', 'depends on') to map how the agent understands interactions between components, files, or ideas.",
  inputSchema: z.object({
    mindmapId,
    from: NodeId.describe("Source node ID"),
    to: NodeId.describe("Target node ID"),
    label: Label.describe("Flow or relationship label (e.g. 'calls', 'reads/writes')"),
    style: Style.optional().describe("Visual line style ('animated' is great for live streams/events, 'dashed' for hypotheses/dependencies)"),
    notes: z.string().optional().describe("Details about this relationship or flow"),
  }),
  run: (input) =>
    updateMindmap(input.mindmapId, (doc) => {
      const from = getNode(doc, input.from, "Source node");
      const to = getNode(doc, input.to, "Target node");
      upsertLink(doc, input);
      const summary = `Linked "${from.label}" ──[${input.label}]──▶ "${to.label}"`;
      store.recordActivity(doc, summary, { nodeId: from.id });
      return { mindmapId: doc.id, summary };
    }),
});

const unlinkNodes = defineTool({
  name: "unlink_nodes",
  description:
    "Remove directed links: one by `linkId` (the `id` of a link in get_mindmap), or by `from` + `to`, which removes every link between those two nodes in that direction unless `label` narrows it to one. It's an error if no link matches. To relabel a link, remove it and call link_nodes again.",
  inputSchema: z
    .object({
      mindmapId,
      linkId: LinkId.optional().describe("ID of the link to remove; don't combine with from, to or label"),
      from: NodeId.optional().describe("Source node ID; needs `to`"),
      to: NodeId.optional().describe("Target node ID; needs `from`"),
      label: Label.optional().describe("Only remove the link with exactly this label; needs `from` and `to`"),
    })
    .superRefine((input, ctx) => {
      const { linkId, from, to, label } = input;
      if (linkId ? from || to || label : !from || !to) {
        ctx.addIssue({ code: "custom", message: "Give either linkId, or from and to with an optional label" });
      }
    }),
  run: (input) =>
    updateMindmap(input.mindmapId, (doc) => {
      const { linkId, from, to, label } = input;
      const matches = (l: MindmapLink) => (linkId ? l.id === linkId : l.from === from && l.to === to && (label === undefined || l.label === label));
      const removed = doc.links.filter(matches);
      const [first] = removed;
      if (!first) throw new ToolError(`No link ${linkId ? `"${linkId}"` : `from "${from}" to "${to}"${label ? ` labeled "${label}"` : ""}`} found.`);

      doc.links = doc.links.filter((l) => !matches(l));
      const name = (id: NodeId) => doc.nodes[id]?.label ?? id;
      const summary = `Unlinked "${name(first.from)}" ──[${removed.map((l) => l.label).join(", ")}]──▶ "${name(first.to)}"`;
      store.recordActivity(doc, summary, { nodeId: first.from });
      return { mindmapId: doc.id, summary };
    }),
});

const HLD_CONTAINER_LABEL = "Code Mental Model (HLD)";

/** The branch HLD concepts go under by default: an existing mental-model component under the root, or a new one. */
function hldContainer(doc: MindmapDocument): ChildNode {
  const existing = Object.values(doc.nodes).find(
    (n): n is ChildNode => n.type === "component" && n.parent === ROOT_ID && /mental model|hld|architecture/i.test(n.label),
  );
  if (existing) return existing;
  const container = createChild({
    type: "component",
    label: HLD_CONTAINER_LABEL,
    parent: ROOT_ID,
    notes: "High-level architecture, data flows, hypotheses, and design decisions",
  });
  attachChild(doc, container);
  return container;
}

const mapArchitecture = defineTool({
  name: "map_architecture",
  description:
    "Batch-map the agent's high-level understanding and mental model of the codebase (HLD): components, data flows, decisions, hypotheses, and risks, plus directed links between them. Nodes are created under a 'Code Mental Model (HLD)' branch unless parentId or parentKey is given.",
  inputSchema: z.object({
    mindmapId,
    parentId: NodeId.optional().describe("Parent node ID. If omitted, creates/uses a top-level 'Code Mental Model (HLD)' branch."),
    nodes: z
      .array(
        z.object({
          key: z.string().min(1).describe("Short symbolic key (e.g. 'mcp_server') or existing nodeId used to reference this node in links/parentKey"),
          label: Label.describe("Human-readable name of the component, flow, hypothesis, or decision"),
          type: ChildType.default("component").describe("Semantic thinking type (default: 'component')"),
          status: Status.optional().describe("Tasks only"),
          notes: z.string().optional().describe("How the agent thinks about this piece, why it matters, or trade-offs"),
          files: z.array(FileTouchInput).optional(),
          parentKey: z.string().optional().describe("Key of another node in this call (or existing nodeId) to nest under"),
        }),
      )
      .describe("HLD / mental-model nodes to create or update"),
    links: z
      .array(
        z.object({
          from: z.string().min(1).describe("Source node key or ID"),
          to: z.string().min(1).describe("Target node key or ID"),
          label: Label.describe("Relationship label (e.g. 'routes tool calls to', 'persists JSON via')"),
          style: Style.optional(),
          notes: z.string().optional(),
        }),
      )
      .optional()
      .describe("Directed flow or dependency links between node keys (or existing node IDs)"),
  }),
  run: (input) =>
    updateMindmap(input.mindmapId, (doc) => {
      const container = input.parentId ? getNode(doc, input.parentId, "Parent node") : hldContainer(doc);

      // Keys may name new nodes in this batch or existing node ids.
      const byKey = new Map<string, NodeId>();
      const resolve = (key: string): NodeId | undefined => {
        const id = byKey.get(key) ?? NodeId.safeParse(key).data;
        return id && doc.nodes[id] ? id : undefined;
      };

      const placed: [item: (typeof input.nodes)[number], id: NodeId][] = [];
      for (const item of input.nodes) {
        const existingId = resolve(item.key);
        const status = statusFor(item.type, item.status, item.label);
        const files = item.files?.map(toFileTouch) ?? [];
        if (existingId) {
          let node = getChild(doc, existingId);
          if (item.type !== node.type) node = retype(node, item.type);
          node.label = item.label;
          if (item.notes !== undefined) node.notes = item.notes;
          if (status && isTask(node)) node.status = status;
          upsertFileTouches(node, files);
          doc.nodes[node.id] = node;
          byKey.set(item.key, node.id);
          placed.push([item, node.id]);
        } else {
          const node = createChild({ ...item, status, files, parent: container.id });
          attachChild(doc, node);
          byKey.set(item.key, node.id);
          placed.push([item, node.id]);
        }
      }

      for (const [item, id] of placed) {
        const node = getChild(doc, id);
        const parentId = (item.parentKey && resolve(item.parentKey)) || container.id;
        if (parentId === node.id) continue;
        nestUnder(doc, node, parentId);
      }

      let linkCount = 0;
      for (const link of input.links ?? []) {
        const from = resolve(link.from);
        const to = resolve(link.to);
        if (!from || !to) continue;
        upsertLink(doc, { ...link, from, to });
        linkCount++;
      }

      const summary = `Mapped HLD mental model: ${input.nodes.length} node(s), ${linkCount} flow link(s)`;
      store.recordActivity(doc, summary, { nodeId: container.id });
      const nodes = [...byKey].map(([key, id]) => ({ key, ...ref(getNode(doc, id)) }));
      return { mindmapId: doc.id, summary, containerId: container.id, nodes };
    }),
});

const updatePlanStatus = defineTool({
  name: "update_plan_status",
  description:
    "Update the status of a plan task ('planned', 'in_progress', 'completed', 'blocked'), with an optional note. Can automatically start the next task by setting nextNodeId.",
  inputSchema: z.object({
    mindmapId,
    nodeId: NodeId.describe("Task node ID to update"),
    status: Status.describe("New status for the task"),
    notes: z.string().optional().describe("Status note or completion summary"),
    nextNodeId: NodeId.optional().describe("ID of the next task node to automatically transition to 'in_progress'"),
  }),
  run: (input) =>
    updateMindmap(input.mindmapId, (doc) => {
      const task = (id: NodeId) => {
        const node = getNode(doc, id);
        if (!isTask(node)) throw new ToolError(`"${node.label}" is a ${node.type} node; only plan/task/code nodes have a status.`);
        return node;
      };
      const node = task(input.nodeId);
      const next = input.nextNodeId ? task(input.nextNodeId) : undefined;

      node.status = input.status;
      if (input.notes !== undefined) node.notes = input.notes;
      node.updatedAt = now();
      store.recordActivity(doc, `Task "${node.label}" marked ${input.status}`, { nodeId: node.id });
      if (next) {
        next.status = "in_progress";
        next.updatedAt = now();
        store.recordActivity(doc, `Started task "${next.label}"`, { nodeId: next.id });
      }
      const summary = `Task "${node.label}" marked ${input.status}${next ? `; started "${next.label}"` : ""}`;
      return { mindmapId: doc.id, summary, node: ref(node), ...(next ? { next: ref(next) } : {}) };
    }),
});

const logFileTouch = defineTool({
  name: "log_file_touch",
  description:
    "Record that a file was read, created, modified, renamed, or deleted, plus symbol-level `changes` (add, modify, fix, refactor, rename, remove, test) so the user can follow exactly what is changing. If nodeId is omitted, attaches to the currently in_progress task node; a planned task given as nodeId is started (in_progress).",
  inputSchema: FileTouchInput.safeExtend({
    mindmapId,
    nodeId: NodeId.optional().describe("Task or component node ID. If omitted, attaches to the active in_progress task."),
    createChildNode: z.boolean().optional().describe("If true, also creates a visible child file node under the task node in the tree"),
  }),
  run: (input) =>
    updateMindmap(input.mindmapId, (doc) => {
      if (input.nodeId) getNode(doc, input.nodeId);
      const target = fileTouchTarget(doc, input.nodeId);
      const touch = toFileTouch(input);
      upsertFileTouch(target, touch);
      // Touching a planned task means work on it has started; auto-detected touches then follow it.
      const started = isTask(target) && target.status === "planned";
      if (started) target.status = "in_progress";

      let fileNode: MindmapNode | undefined;
      if (input.createChildNode) {
        const label = `${input.path}${input.lines ? `:${input.lines}` : ""}`;
        fileNode = target.children.map((id) => doc.nodes[id]).find((c) => c?.type === "file" && c.label.includes(input.path));
        if (fileNode) {
          fileNode.label = label;
          fileNode.notes = input.summary ?? fileNode.notes;
          upsertFileTouch(fileNode, touch);
        } else {
          fileNode = createChild({ type: "file", label, parent: target.id, notes: input.summary, files: [touch] });
          attachChild(doc, fileNode);
        }
      }

      const renamedFrom = touch.action === "rename" ? `${touch.previousPath} → ` : "";
      const tally = describeChanges(input.changes);
      const what = `[${touch.action.toUpperCase()}] ${renamedFrom}${input.path}${input.lines ? `:${input.lines}` : ""}${tally ? ` (${tally})` : ""}`;
      const on = ` (on "${target.label}")`;
      store.recordActivity(doc, `${what}${input.summary ? ` — ${input.summary}` : ""}${on}`, { nodeId: target.id, file: input.path });
      if (started) store.recordActivity(doc, `Started task "${target.label}"`, { nodeId: target.id });

      const stale = Object.values(doc.nodes).filter((n) => n.id !== target.id && isTask(n) && n.status === "in_progress");
      const hint =
        stale.length > 0
          ? `Also in_progress: ${stale.map((n) => `"${n.label}" (${n.id})`).join(", ")}. Call update_plan_status if that work is done.`
          : undefined;
      // The reply leaves out the agent's own free-text summary (it's in the activity log), so it stays short.
      return {
        mindmapId: doc.id,
        summary: `${what}${on}`,
        node: ref(target),
        ...(fileNode ? { fileNode: ref(fileNode) } : {}),
        ...(hint ? { hint } : {}),
      };
    }),
});

const syncGitStatus = defineTool({
  name: "sync_git_status",
  description:
    "Inspect git status and diff in the workspace and automatically attach all modified/created/deleted files to the mindmap.",
  inputSchema: z.object({
    mindmapId,
    workspacePath: z.string().optional().describe("Path to the git repository (defaults to the mindmap's workspacePath)"),
    targetNodeId: NodeId.optional().describe("Node ID to attach git changes to (defaults to the active in_progress node)"),
  }),
  async run(input) {
    const loaded = await loadMindmap(input.mindmapId);
    if (input.targetNodeId) getNode(loaded, input.targetNodeId);
    const workspacePath = input.workspacePath || loaded.workspacePath || process.cwd();

    // Ask git before taking the mindmap's lock, which `updateMindmap` only holds for quick changes.
    const changes = await inspectGitChanges(workspacePath);
    if (changes.length === 0) return `No uncommitted git changes detected in ${workspacePath}.`;
    const repoPath = await repoRoot(workspacePath);

    return updateMindmap(input.mindmapId, (doc) => {
      // Check again: the target may have been removed while git ran, and fileTouchTarget would fall back to another node.
      if (input.targetNodeId) getNode(doc, input.targetNodeId);
      doc.workspacePath = workspacePath;
      doc.repoPath = repoPath;
      const target = fileTouchTarget(doc, input.targetNodeId);
      upsertFileTouches(target, changes);
      const summary = `Synced ${changes.length} changed file(s) from git status into "${target.label}"`;
      store.recordActivity(doc, summary, { nodeId: target.id });
      return { mindmapId: doc.id, summary, node: ref(target) };
    });
  },
});

const getPlanSummary = defineTool({
  name: "get_plan_summary",
  description:
    "Get a concise status report of the mindmap plan: completion percentage, active tasks, blocked items, HLD concept count, and all touched files with their changes.",
  inputSchema: z.object({ mindmapId }),
  async run(input) {
    const doc = await loadMindmap(input.mindmapId);
    const nodes = Object.values(doc.nodes);
    const tasks = nodes.filter(isTask);
    const byStatus = (status: TaskStatus) => tasks.filter((n) => n.status === status);
    const [planned, inProgress, completed, blocked] = [byStatus("planned"), byStatus("in_progress"), byStatus("completed"), byStatus("blocked")];

    const files = aggregateFiles(nodes);
    const allChanges = [...files.values()].flatMap((e) => e.changes);

    const pct = tasks.length > 0 ? Math.round((completed.length / tasks.length) * 100) : 0;
    const lines: string[] = [
      `# Plan & Code Summary: ${doc.title} (${doc.id})`,
      `Progress: ${completed.length}/${tasks.length} tasks completed (${pct}%)`,
      `Status Breakdown: ${inProgress.length} in progress · ${planned.length} planned · ${completed.length} completed · ${blocked.length} blocked`,
      `Mental Model / HLD: ${nodes.filter(isConcept).length} concept node(s) · ${doc.links.length} directed flow link(s)`,
      `Code Changes: ${describeChanges(allChanges) || "none logged"}`,
      "",
    ];
    const section = (title: string, mark: string, items: typeof tasks) => {
      if (items.length === 0) return;
      lines.push(`## ${title}`, ...items.map((t) => `- [${mark}] **${t.label}** (\`${t.id}\`)${t.notes ? ` — ${t.notes}` : ""}`), "");
    };
    section("Currently In Progress", "~", inProgress);
    section("Blocked", "!", blocked);

    lines.push(`## Touched Files (${files.size})`);
    if (files.size === 0) lines.push("_No files logged yet._");
    for (const [filePath, { touch, nodes: via, changes }] of files) {
      const loc = touch.lines ? `:${touch.lines}` : "";
      const sum = touch.summary ? ` — ${touch.summary}` : "";
      const from = touch.action === "rename" ? `${touch.previousPath} → ` : "";
      lines.push(`- \`[${touch.action.toUpperCase()}]\` **${from}${filePath}${loc}**${sum} _(via: ${via.map((n) => n.label).join(", ")})_`);
      for (const c of changes) {
        const name = c.kind === "rename" ? `${c.previousSymbol} → ${c.symbol}` : c.symbol;
        lines.push(`  - ${c.kind}: \`${name}\`${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }
    return lines.join("\n");
  },
});

const removeNode = defineTool({
  name: "remove_node",
  description: "Remove a node and all its descendants from a mindmap. Cannot remove the root.",
  inputSchema: z.object({ mindmapId, nodeId: NodeId.describe("Node ID to remove") }),
  run: (input) =>
    updateMindmap(input.mindmapId, (doc) => {
      if (input.nodeId === ROOT_ID) throw new ToolError("Cannot remove the root node. Delete the entire mindmap instead.");
      const node = getChild(doc, input.nodeId);

      const removed = new Set<NodeId>();
      const collect = (id: NodeId) => {
        removed.add(id);
        for (const child of doc.nodes[id]?.children ?? []) collect(child);
      };
      collect(node.id);
      const parent = getNode(doc, node.parent);
      parent.children = parent.children.filter((id) => id !== node.id);
      for (const id of removed) delete doc.nodes[id];
      doc.links = doc.links.filter((l) => !removed.has(l.from) && !removed.has(l.to));

      const summary = `Removed node "${node.label}" (${removed.size} node(s))`;
      store.recordActivity(doc, summary);
      return { mindmapId: doc.id, summary };
    }),
});

const listMindmaps = defineTool({
  name: "list_mindmaps",
  description:
    "List stored mindmaps with their IDs, titles, and last updated timestamps: all of them, or only those of one workspace or repository, and with or without archived ones. Mindmap files that can't be read are always listed, because nothing shows which workspace they belong to.",
  inputSchema: z.object({
    workspacePath: z.string().trim().min(1).optional().describe("Only list mindmaps whose workspacePath or repoPath is this path"),
    includeArchived: z.boolean().default(true).describe("Whether to list archived mindmaps (default: true)"),
  }),
  async run(input) {
    const { workspacePath, includeArchived } = input;
    const { mindmaps, unreadable } = await store.list();
    const wanted = workspacePath && path.resolve(workspacePath);
    const inWorkspace = (m: MindmapListItem) => [m.workspacePath, m.repoPath].some((p) => p !== undefined && path.resolve(p) === wanted);
    const listed = mindmaps.filter((m) => (includeArchived || !m.archivedAt) && (!wanted || inWorkspace(m)));
    const lines = [
      ...listed.map((m) => `• ${m.id}  –  "${m.title}" (${m.nodeCount} nodes, updated ${m.updatedAt}${m.archivedAt ? ", archived" : ""})`),
      ...unreadable.map((m) => `• ${m.id}  –  can't be read: ${m.error}`),
    ];
    if (lines.length > 0) return lines.join("\n");
    return mindmaps.length > 0 ? "No mindmaps match." : "No mindmaps yet.";
  },
});

const getMindmap = defineTool({
  name: "get_mindmap",
  description: "Get a mindmap's full data as JSON.",
  inputSchema: z.object({ mindmapId }),
  run: (input) => loadMindmap(input.mindmapId),
});

const renderMindmap = defineTool({
  name: "render_mindmap",
  description:
    "Render a mindmap in a digestible format: mermaid (Mermaid `mindmap` syntax: the tree and its files, no links), mermaid-flowchart (Mermaid `flowchart LR` syntax: the tree and its files, plus links as labeled arrows), text (indented outline with notes, symbol-level changes and links), or json.",
  inputSchema: z.object({ mindmapId, format: z.enum(RENDER_FORMATS).describe("Output format") }),
  async run(input) {
    return render(await loadMindmap(input.mindmapId), { format: input.format });
  },
});

const deleteMindmap = defineTool({
  name: "delete_mindmap",
  description: "Delete an entire mindmap and all its nodes.",
  inputSchema: z.object({ mindmapId }),
  async run(input) {
    if (!(await store.remove(input.mindmapId))) throw new ToolError(`Mindmap "${input.mindmapId}" not found.`);
    stopWorkspaceWatcher(input.mindmapId);
    return { mindmapId: input.mindmapId, summary: `Mindmap "${input.mindmapId}" deleted.` };
  },
});

export const tools: ToolDefinition[] = [
  createMindmap,
  addNode,
  updateNode,
  linkNodes,
  unlinkNodes,
  mapArchitecture,
  updatePlanStatus,
  logFileTouch,
  syncGitStatus,
  getPlanSummary,
  removeNode,
  listMindmaps,
  getMindmap,
  renderMindmap,
  deleteMindmap,
];
