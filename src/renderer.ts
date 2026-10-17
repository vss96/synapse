import { isTask, type ChangeKind, type NodeType, type TaskStatus } from "./model/kinds.js";
import { ROOT_ID, type MindmapDocument, type MindmapNode, type NodeId } from "./model/schema.js";

const CHANGE_GLYPH: Record<ChangeKind, string> = {
  add: "+",
  modify: "~",
  fix: "✱",
  refactor: "⟲",
  rename: "↦",
  remove: "−",
  test: "✓",
};

const STATUS_BADGE: Record<TaskStatus, string> = {
  planned: "[ ] ",
  in_progress: "[~] ",
  completed: "[x] ",
  blocked: "[!] ",
};

const TYPE_ICON: Partial<Record<NodeType, string>> = {
  component: "📦 ",
  data_flow: "⇄ ",
  hypothesis: "💡 ",
  decision: "⚖️ ",
  risk: "⚠️ ",
};

const statusBadge = (node: MindmapNode): string => (isTask(node) ? STATUS_BADGE[node.status] : "");

/* ------------------------------------------------------------------ */
/*  Mermaid renderer                                                   */
/* ------------------------------------------------------------------ */

function toMermaid(doc: MindmapDocument): string {
  const lines: string[] = ["mindmap"];
  const root = doc.nodes[ROOT_ID];
  if (!root) return "mindmap\n  root[No root node]";

  function walk(nodeId: NodeId, indent: number): void {
    const node = doc.nodes[nodeId];
    if (!node) return;
    const statusPrefix = statusBadge(node);
    const typePrefix = TYPE_ICON[node.type] ?? "";
    const rawLabel = `${statusPrefix}${typePrefix}${node.label}`;
    const label = rawLabel.replace(/[\[\](){}]/g, ""); // strip brackets that confuse mermaid
    lines.push(`${"  ".repeat(indent + 1)}${node.id === ROOT_ID ? "root" : node.id}(${label})`);

    for (const f of node.files) {
      const fileLabel = `${f.action.toUpperCase()} ${f.path}${f.lines ? ":" + f.lines : ""}`.replace(/[\[\](){}]/g, "");
      lines.push(`${"  ".repeat(indent + 2)}(${fileLabel})`);
    }

    for (const childId of node.children) {
      walk(childId, indent + 1);
    }
  }

  walk(ROOT_ID, 0);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Indented-text renderer                                             */
/* ------------------------------------------------------------------ */

function toIndentedText(doc: MindmapDocument): string {
  const lines: string[] = [`# ${doc.title} (${doc.id})`];
  if (doc.workspacePath) {
    lines.push(`Workspace: ${doc.workspacePath}`);
  }
  lines.push("");

  const root = doc.nodes[ROOT_ID];
  if (!root) return lines.join("\n");

  function walk(nodeId: NodeId, depth: number): void {
    const node = doc.nodes[nodeId];
    if (!node) return;
    const indent = "  ".repeat(depth);
    const badge = statusBadge(node);
    const typeIcon = TYPE_ICON[node.type] ?? "";
    const idTag = depth === 0 ? `[root]` : `[${node.id}]`;

    lines.push(`${indent}${depth === 0 ? "● " : "├─ "}${badge}${typeIcon}${node.label} ${idTag}`);

    if (node.notes) {
      lines.push(`${indent}   💬 ${node.notes}`);
    }
    for (const f of node.files) {
      const from = f.action === "rename" ? `${f.previousPath} → ` : "";
      const loc = f.lines ? `:${f.lines}` : "";
      const sym = f.symbols?.length ? ` (${f.symbols.join(", ")})` : "";
      const sum = f.summary ? ` — ${f.summary}` : "";
      lines.push(`${indent}   📄 [${f.action.toUpperCase()}] ${from}${f.path}${loc}${sym}${sum}`);
      if (f.action === "read") continue;
      for (const c of f.changes) {
        const name = c.kind === "rename" ? `${c.previousSymbol} → ${c.symbol}` : c.symbol;
        lines.push(`${indent}      ${CHANGE_GLYPH[c.kind]} ${c.kind} ${name}${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }

    for (const childId of node.children) {
      walk(childId, depth + 1);
    }
  }

  walk(ROOT_ID, 0);

  if (doc.links.length > 0) {
    lines.push("");
    lines.push("## Directed Flow & Concept Links");
    for (const link of doc.links) {
      const fromLabel = doc.nodes[link.from]?.label || link.from;
      const toLabel = doc.nodes[link.to]?.label || link.to;
      lines.push(`  ${fromLabel} (${link.from}) ──[${link.label}]──▶ ${toLabel} (${link.to})`);
    }
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

export interface RenderOptions {
  format: "mermaid" | "text" | "json";
}

export function render(doc: MindmapDocument, options: RenderOptions): string {
  switch (options.format) {
    case "mermaid":
      return toMermaid(doc);
    case "text":
      return toIndentedText(doc);
    case "json":
      return JSON.stringify(doc, null, 2);
  }
}