/**
 * The mindmap data model as zod schemas: the single source of the TypeScript types and of the
 * checks applied wherever data enters the system (disk, MCP tools, HTTP).
 */

import { nanoid } from "nanoid";
import { z } from "zod";
import {
  ANNOTATION_TYPES,
  CHANGE_KINDS,
  CONCEPT_TYPES,
  FILE_ACTIONS,
  LINK_STYLES,
  TASK_STATUSES,
  TASK_TYPES,
} from "./kinds.js";

/* ------------------------------------------------------------------ */
/*  Identifiers and timestamps                                         */
/* ------------------------------------------------------------------ */

// Ids end up in file names and HTML attributes, so they are restricted to nanoid's alphabet.
const idString = z.string().regex(/^[A-Za-z0-9_-]+$/, "Ids may only contain letters, digits, _ and -");

export const MindmapId = idString.brand<"MindmapId">();
export type MindmapId = z.infer<typeof MindmapId>;
export const NodeId = idString.brand<"NodeId">();
export type NodeId = z.infer<typeof NodeId>;
export const LinkId = idString.brand<"LinkId">();
export type LinkId = z.infer<typeof LinkId>;

export const Timestamp = z.iso.datetime().brand<"Timestamp">();
export type Timestamp = z.infer<typeof Timestamp>;

export const ROOT_ID = NodeId.parse("root");

export const newMindmapId = (): MindmapId => MindmapId.parse(`mm_${nanoid(8)}`);
export const newNodeId = (): NodeId => NodeId.parse(`n_${nanoid(6)}`);
export const newLinkId = (): LinkId => LinkId.parse(`l_${nanoid(6)}`);
export const now = (): Timestamp => Timestamp.parse(new Date().toISOString());

const Text = z.string().trim().min(1);

/* ------------------------------------------------------------------ */
/*  Symbol-level changes and file touches                              */
/* ------------------------------------------------------------------ */

const ChangeFields = { symbol: Text, detail: z.string().optional() };

/** A change to one symbol. Renames always know the previous name. */
export const CodeChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(CHANGE_KINDS).exclude(["rename"]), ...ChangeFields }),
  z.object({ kind: z.literal("rename"), previousSymbol: Text, ...ChangeFields }),
]);
export type CodeChange = z.infer<typeof CodeChange>;

const TouchFields = {
  /** File path, relative to the workspace or absolute. */
  path: Text,
  /** Line range, e.g. "12-48". */
  lines: z.string().optional(),
  /** Symbols touched (functions, classes, types). */
  symbols: z.array(z.string()).optional(),
  summary: z.string().optional(),
  timestamp: Timestamp,
};

/** A file the agent touched. Reads carry no changes; renames always know the previous path. */
export const FileTouch = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), ...TouchFields }),
  z.object({
    action: z.enum(FILE_ACTIONS).exclude(["read", "rename"]),
    changes: z.array(CodeChange),
    ...TouchFields,
  }),
  z.object({ action: z.literal("rename"), previousPath: Text, changes: z.array(CodeChange), ...TouchFields }),
]);
export type FileTouch = z.infer<typeof FileTouch>;
export type EditTouch = Exclude<FileTouch, { action: "read" }>;

/* ------------------------------------------------------------------ */
/*  Nodes                                                              */
/* ------------------------------------------------------------------ */

const NodeFields = {
  id: NodeId,
  label: Text,
  notes: z.string().optional(),
  files: z.array(FileTouch),
  children: z.array(NodeId),
  updatedAt: Timestamp,
};

export const RootNode = z.object({ type: z.literal("root"), parent: z.null(), ...NodeFields });
/** Plan work items: the only nodes with a status. */
export const TaskNode = z.object({
  type: z.enum(TASK_TYPES),
  status: z.enum(TASK_STATUSES),
  parent: NodeId,
  ...NodeFields,
});
export const AnnotationNode = z.object({ type: z.enum(ANNOTATION_TYPES), parent: NodeId, ...NodeFields });
/** The agent's mental model of the code (HLD): described, never completed. */
export const ConceptNode = z.object({ type: z.enum(CONCEPT_TYPES), parent: NodeId, ...NodeFields });

export const MindmapNode = z.discriminatedUnion("type", [RootNode, TaskNode, AnnotationNode, ConceptNode]);
export type RootNode = z.infer<typeof RootNode>;
export type TaskNode = z.infer<typeof TaskNode>;
export type AnnotationNode = z.infer<typeof AnnotationNode>;
export type ConceptNode = z.infer<typeof ConceptNode>;
export type MindmapNode = z.infer<typeof MindmapNode>;
export type ChildNode = Exclude<MindmapNode, RootNode>;

/* ------------------------------------------------------------------ */
/*  Links, activity and the document                                   */
/* ------------------------------------------------------------------ */

/** A directed concept or flow relationship, e.g. "calls", "streams SSE to". */
export const MindmapLink = z.object({
  id: LinkId,
  from: NodeId,
  to: NodeId,
  label: Text,
  style: z.enum(LINK_STYLES),
  notes: z.string().optional(),
});
export type MindmapLink = z.infer<typeof MindmapLink>;

export const ActivityEntry = z.object({
  timestamp: Timestamp,
  message: z.string(),
  /** May refer to a node that has since been removed. */
  nodeId: NodeId.optional(),
  file: z.string().optional(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

/**
 * Structural rules the types alone can't express: one root, every node reachable from it,
 * parent and child pointers agreeing, and links between existing nodes.
 */
function checkTree(doc: { nodes: Record<NodeId, MindmapNode>; links: MindmapLink[] }, ctx: z.RefinementCtx): void {
  const issue = (message: string, path: PropertyKey[]) => ctx.addIssue({ code: "custom", message, path });
  const { nodes } = doc;

  // Object.entries and Object.keys widen keys to string; the keys of `nodes` are NodeIds.
  for (const [key, node] of Object.entries(nodes) as [NodeId, MindmapNode][]) {
    if (node.id !== key) issue(`Node stored under "${key}" has id "${node.id}"`, ["nodes", key, "id"]);
    if (node.type === "root" && key !== ROOT_ID) issue(`Only "${ROOT_ID}" may be the root`, ["nodes", key, "type"]);
    if (node.type !== "root") {
      const parent = nodes[node.parent];
      if (!parent) issue(`Parent "${node.parent}" does not exist`, ["nodes", key, "parent"]);
      else if (!parent.children.includes(key)) issue(`Parent "${node.parent}" does not list it as a child`, ["nodes", key, "parent"]);
    }
    const seen = new Set<NodeId>();
    for (const child of node.children) {
      if (seen.has(child)) issue(`Child "${child}" is listed twice`, ["nodes", key, "children"]);
      seen.add(child);
      if (nodes[child]?.parent !== key) issue(`Child "${child}" does not point back to "${key}"`, ["nodes", key, "children"]);
    }
  }

  const root = nodes[ROOT_ID];
  if (root?.type !== "root") {
    issue(`Node "${ROOT_ID}" must exist and be the root`, ["nodes", ROOT_ID]);
  } else {
    const reachable = new Set<NodeId>();
    const queue: NodeId[] = [ROOT_ID];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (reachable.has(id)) continue;
      reachable.add(id);
      queue.push(...(nodes[id]?.children ?? []));
    }
    for (const key of Object.keys(nodes) as NodeId[]) {
      if (!reachable.has(key)) issue(`Node "${key}" is not reachable from the root`, ["nodes", key]);
    }
  }

  doc.links.forEach((link, i) => {
    if (!nodes[link.from]) issue(`Link source "${link.from}" does not exist`, ["links", i, "from"]);
    if (!nodes[link.to]) issue(`Link target "${link.to}" does not exist`, ["links", i, "to"]);
  });
}

export const MindmapDocument = z
  .object({
    id: MindmapId,
    title: Text,
    /** Workspace / repository root used for git and file tracking. */
    workspacePath: z.string().optional(),
    /** The repository's main checkout, the same for all of its worktrees. Kept because a worktree may be deleted. */
    repoPath: z.string().optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    /** Set when the session is archived in the viewer; archived sessions are listed separately. */
    archivedAt: Timestamp.optional(),
    nodes: z.record(NodeId, MindmapNode),
    links: z.array(MindmapLink),
    /** Newest first, capped at 100 entries. */
    activityLog: z.array(ActivityEntry).max(100),
  })
  .superRefine(checkTree);
export type MindmapDocument = z.infer<typeof MindmapDocument>;

/** Summary of a stored mindmap, as listed by the store and the viewer's session list. */
export interface MindmapListItem {
  id: MindmapId;
  title: string;
  updatedAt: string;
  createdAt: string;
  workspacePath?: string;
  repoPath?: string;
  archivedAt?: string;
  nodeCount: number;
  completedTasks: number;
  totalTasks: number;
  /** Label of the most recently updated in-progress task. */
  activeTask?: string;
  fileCount: number;
}

/** A mindmap file that exists but can't be loaded. `id` comes from the file name; the contents can't be trusted. */
export interface UnreadableMindmap {
  id: string;
  error: string;
}

/** Everything in the data directory. */
export interface MindmapList {
  mindmaps: MindmapListItem[];
  unreadable: UnreadableMindmap[];
}
