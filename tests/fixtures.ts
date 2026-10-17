import { attachChild, createChild, type ChildSpec } from "../src/model/node.js";
import { MindmapId, NodeId, ROOT_ID, now, type ChildNode, type MindmapDocument } from "../src/model/schema.js";

/** A valid document with only a root node. */
export function emptyDoc(id = "mm_test", title = "Test"): MindmapDocument {
  const timestamp = now();
  return {
    id: MindmapId.parse(id),
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes: { [ROOT_ID]: { id: ROOT_ID, type: "root", parent: null, label: title, files: [], children: [], updatedAt: timestamp } },
    links: [],
    activityLog: [],
  };
}

/** Add a node built by the model's own constructor (so fixtures can only be valid nodes). */
export function addChild(doc: MindmapDocument, spec: Omit<ChildSpec, "parent"> & { parent?: NodeId; id?: string }): ChildNode {
  const node = createChild({ ...spec, parent: spec.parent ?? ROOT_ID }, spec.id ? NodeId.parse(spec.id) : undefined);
  attachChild(doc, node);
  return node;
}
