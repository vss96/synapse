/**
 * The closed sets of values the mindmap model is built from, plus guards over them.
 * Dependency-free so the browser viewer can import it without pulling in zod.
 */

import type { ConceptNode, MindmapNode, TaskNode } from "./schema.js";

/** Plan work items: the only nodes with a status, counted as tasks. */
export const TASK_TYPES = ["plan", "task", "code"] as const;
/** Supporting nodes in the plan tree that are not work items. */
export const ANNOTATION_TYPES = ["note", "file"] as const;
/** The agent's mental model of the code (HLD). */
export const CONCEPT_TYPES = ["component", "data_flow", "hypothesis", "decision", "risk"] as const;
export const NODE_TYPES = ["root", ...TASK_TYPES, ...ANNOTATION_TYPES, ...CONCEPT_TYPES] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];
export type ConceptType = (typeof CONCEPT_TYPES)[number];
export type NodeType = (typeof NODE_TYPES)[number];
/** Every node type except the root, i.e. the types an agent can create. */
export type ChildNodeType = Exclude<NodeType, "root">;

export const TASK_STATUSES = ["planned", "in_progress", "completed", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const FILE_ACTIONS = ["read", "create", "modify", "delete", "rename"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

/** What kind of change was made to a symbol inside a file (also the display order). */
export const CHANGE_KINDS = ["add", "modify", "fix", "refactor", "rename", "remove", "test"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const LINK_STYLES = ["solid", "dashed", "animated"] as const;
export type LinkStyle = (typeof LINK_STYLES)[number];

function member<T extends string>(values: readonly T[]) {
  const set: ReadonlySet<string> = new Set(values);
  return (value: string): value is T => set.has(value);
}

export const isTaskType = member(TASK_TYPES);
export const isAnnotationType = member(ANNOTATION_TYPES);
export const isConceptType = member(CONCEPT_TYPES);
export const isNodeType = member(NODE_TYPES);
export const isTaskStatus = member(TASK_STATUSES);
export const isFileAction = member(FILE_ACTIONS);
export const isChangeKind = member(CHANGE_KINDS);
export const isLinkStyle = member(LINK_STYLES);

/** Plan tasks: the work items progress is measured against. HLD concepts, notes and files are not tasks. */
export const isTask = (node: MindmapNode): node is TaskNode => isTaskType(node.type);
export const isConcept = (node: MindmapNode): node is ConceptNode => isConceptType(node.type);

/** Compile-time exhaustiveness check for switches over the unions above. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
