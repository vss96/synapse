import { isAnnotationType, isConceptType, isTask, isTaskType, type ChildNodeType, type TaskStatus } from "./kinds.js";
import { newNodeId, now, type ChildNode, type FileTouch, type MindmapDocument, type NodeId } from "./schema.js";

export interface ChildSpec {
  type: ChildNodeType;
  label: string;
  parent: NodeId;
  /** Only meaningful for tasks; defaults to "planned". */
  status?: TaskStatus;
  notes?: string;
  files?: FileTouch[];
}

/** Build a node of the right family for its type: only tasks get a status. */
export function createChild(spec: ChildSpec, id: NodeId = newNodeId()): ChildNode {
  const base = {
    id,
    label: spec.label,
    parent: spec.parent,
    notes: spec.notes,
    files: spec.files ?? [],
    children: [],
    updatedAt: now(),
  };
  const { type } = spec;
  if (isTaskType(type)) return { ...base, type, status: spec.status ?? "planned" };
  if (isAnnotationType(type)) return { ...base, type };
  if (isConceptType(type)) return { ...base, type };
  return type satisfies never;
}

/** Change a node's type, moving it between families: becoming a task adds a status, leaving one drops it. */
export function retype(node: ChildNode, type: ChildNodeType): ChildNode {
  const status = isTask(node) ? node.status : undefined;
  return { ...createChild({ ...node, type, status }, node.id), children: node.children, updatedAt: now() };
}

/** Add a node under its parent. The caller must have checked the parent exists. */
export function attachChild(doc: MindmapDocument, node: ChildNode): void {
  const parent = doc.nodes[node.parent];
  if (!parent) throw new Error(`Parent "${node.parent}" does not exist`);
  doc.nodes[node.id] = node;
  parent.children.push(node.id);
}

/** Move a node under a new parent, keeping both parents' child lists in sync. */
export function reparent(doc: MindmapDocument, node: ChildNode, parentId: NodeId): void {
  if (node.parent === parentId) return;
  const oldParent = doc.nodes[node.parent];
  const newParent = doc.nodes[parentId];
  if (!newParent) throw new Error(`Parent "${parentId}" does not exist`);
  if (oldParent) oldParent.children = oldParent.children.filter((id) => id !== node.id);
  newParent.children.push(node.id);
  node.parent = parentId;
}
