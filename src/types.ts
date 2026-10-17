/** Status of a plan/task node in the mindmap. */
export type NodeStatus = "none" | "planned" | "in_progress" | "completed" | "blocked";

/**
 * Semantic type of a node in the mindmap:
 * - Plan/Task tree: "root" | "plan" | "task" | "file" | "code" | "note"
 * - Code Mental Model & HLD: "component" | "data_flow" | "hypothesis" | "decision" | "risk"
 */
export type NodeType =
  | "root"
  | "plan"
  | "task"
  | "file"
  | "code"
  | "note"
  | "component"
  | "data_flow"
  | "hypothesis"
  | "decision"
  | "risk";

/** Visual style for a directed relationship/flow link between nodes. */
export type LinkStyle = "solid" | "dashed" | "animated";

/** A directed concept or flow relationship between two nodes (e.g., "calls", "streams SSE to", "mutates"). */
export interface MindmapLink {
  id: string;
  /** Source node ID. */
  from: string;
  /** Target node ID. */
  to: string;
  /** Relationship or flow label (e.g., "calls", "reads/writes", "triggers"). */
  label: string;
  /** Optional visual line style. */
  style?: LinkStyle;
  /** Optional explanation of this interaction or flow. */
  notes?: string;
}

/** Action performed on a file. */
export type FileAction = "read" | "create" | "modify" | "delete" | "rename";

export const FILE_ACTIONS: FileAction[] = ["read", "create", "modify", "delete", "rename"];

/** What kind of change was made to a symbol inside a file. */
export const CHANGE_KINDS = ["add", "modify", "fix", "refactor", "rename", "remove", "test"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** A single symbol-level change inside a file (e.g. "fix validateToken", "rename foo → bar"). */
export interface CodeChange {
  kind: ChangeKind;
  /** Function, class, type, test name, etc. For renames, the new name. */
  symbol: string;
  /** Previous name when kind is "rename". */
  previousSymbol?: string;
  /** Short description of what changed and why. */
  detail?: string;
}

/** Metadata for a file or code region touched by the agent. */
export interface FileTouch {
  /** File path (relative to workspace or absolute). */
  path: string;
  /** Type of action performed on the file. */
  action?: FileAction;
  /** Previous file path when action is "rename". */
  previousPath?: string;
  /** Optional line range, e.g. "12-48". */
  lines?: string;
  /** Optional code symbols touched (functions, classes, types). */
  symbols?: string[];
  /** Symbol-level changes made in this file. */
  changes?: CodeChange[];
  /** Brief description of what was changed or why the file was touched. */
  summary?: string;
  /** ISO timestamp when this file touch was recorded. */
  timestamp?: string;
}

/** Entry in the mindmap's activity stream. */
export interface ActivityEntry {
  timestamp: string;
  message: string;
  nodeId?: string;
  file?: string;
}

/** A single node in the mindmap. */
export interface MindmapNode {
  id: string;
  label: string;
  children: string[];
  parent: string | null;
  type?: NodeType;
  status?: NodeStatus;
  notes?: string;
  files?: FileTouch[];
  updatedAt?: string;
}

/** Node types that describe the agent's mental model of the code (HLD) rather than the plan. */
export const HLD_NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "component",
  "data_flow",
  "hypothesis",
  "decision",
  "risk",
]);

/** Plan tasks are every node except the root, HLD concepts, files and notes. */
export function isPlanTask(node: MindmapNode): boolean {
  const type = node.type ?? "task";
  return node.id !== "root" && type !== "root" && type !== "file" && type !== "note" && !HLD_NODE_TYPES.has(type);
}

/** The full mindmap document stored on disk. */
export interface MindmapDocument {
  id: string;
  title: string;
  /** Optional workspace/repository root path for git & file tracking. */
  workspacePath?: string;
  createdAt: string;   // ISO
  updatedAt: string;   // ISO
  nodes: Record<string, MindmapNode>;
  /** Directed conceptual/HLD flow links between nodes. */
  links?: MindmapLink[];
  activityLog?: ActivityEntry[];
}

/** Summary of a stored mindmap, as listed by the store and the viewer's session list. */
export interface MindmapListItem {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  workspacePath?: string;
  nodeCount: number;
  completedTasks: number;
  totalTasks: number;
  /** Label of the most recently updated in-progress task. */
  activeTask?: string;
  fileCount: number;
}

/** Initial plan item when bootstrapping a mindmap. */
export interface InitialPlanItem {
  label: string;
  type?: NodeType;
  status?: NodeStatus;
  notes?: string;
  children?: Array<{
    label: string;
    type?: NodeType;
    status?: NodeStatus;
    notes?: string;
  }>;
}

/** Input contract for the create_mindmap tool. */
export interface CreateMindmapInput {
  title: string;
  /** Optional root node label (defaults to the title). */
  rootLabel?: string;
  /** Optional workspace directory path for automatic git/file tracking. */
  workspacePath?: string;
  /** Optional initial plan steps to populate immediately under the root. */
  initialPlan?: InitialPlanItem[];
}

/** Input contract for the add_node tool. */
export interface AddNodeInput {
  mindmapId: string;
  parentId: string;
  label: string;
  type?: NodeType;
  status?: NodeStatus;
  notes?: string;
  files?: FileTouch[];
}

/** Input contract for the update_node tool. */
export interface UpdateNodeInput {
  mindmapId: string;
  nodeId: string;
  label?: string;
  type?: NodeType;
  status?: NodeStatus;
  notes?: string;
  files?: FileTouch[];
}

/** Input contract for the remove_node tool. */
export interface RemoveNodeInput {
  mindmapId: string;
  nodeId: string;
}

/** Input contract for the log_file_touch tool. */
export interface LogFileTouchInput {
  mindmapId: string;
  /** Target node ID to attach the file touch to. If omitted, attaches to the active in_progress node (or creates a "Touched Files" node). */
  nodeId?: string;
  /** File path (relative to workspace or absolute). */
  path: string;
  action?: FileAction;
  previousPath?: string;
  lines?: string;
  symbols?: string[];
  changes?: CodeChange[];
  summary?: string;
  /** If true, also creates a dedicated child node for this file under the target node. */
  createChildNode?: boolean;
}

/** Input contract for the update_plan_status tool. */
export interface UpdatePlanStatusInput {
  mindmapId: string;
  nodeId: string;
  status: NodeStatus;
  notes?: string;
  /** Optional ID of the next task node to automatically mark as in_progress. */
  nextNodeId?: string;
}

/** Input contract for the sync_git_status tool. */
export interface SyncGitStatusInput {
  mindmapId: string;
  /** Optional workspace path override. Defaults to doc.workspacePath or process.cwd(). */
  workspacePath?: string;
  /** Optional parent node ID to attach git changes under. */
  targetNodeId?: string;
}

/** Input contract for the link_nodes tool. */
export interface LinkNodesInput {
  mindmapId: string;
  /** Source node ID. */
  from: string;
  /** Target node ID. */
  to: string;
  /** Relationship or flow label, e.g. "calls", "streams SSE to", "mutates", "depends on". */
  label: string;
  style?: LinkStyle;
  notes?: string;
}

/** Input contract for batch-mapping HLD & agent mental model concepts. */
export interface MapArchitectureInput {
  mindmapId: string;
  /** Optional parent node ID. If omitted, creates/uses a top-level "Code Mental Model (HLD)" node under root. */
  parentId?: string;
  /** Architectural/thinking nodes (components, data_flow, hypothesis, decision, risk). */
  nodes: Array<{
    /** Temporary key or existing nodeId used to reference this node in `links` or `parentKey`. */
    key: string;
    label: string;
    type?: NodeType;
    status?: NodeStatus;
    notes?: string;
    files?: FileTouch[];
    /** Optional key of another node in this batch (or an existing nodeId) to nest under. */
    parentKey?: string;
  }>;
  /** Directed flow or dependency links between keys or existing node IDs. */
  links?: Array<{
    from: string;
    to: string;
    label: string;
    style?: LinkStyle;
    notes?: string;
  }>;
}