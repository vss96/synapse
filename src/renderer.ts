import { isTask, type ChangeKind, type LinkStyle, type NodeType, type TaskStatus } from "./model/kinds.js";
import { ROOT_ID, type FileTouch, type MindmapDocument, type MindmapNode, type NodeId } from "./model/schema.js";

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

/** The viewer's status glyphs, so a diagram reads like the live map. */
const STATUS_GLYPH: Record<TaskStatus, string> = {
  planned: "○ ",
  in_progress: "◐ ",
  completed: "✔ ",
  blocked: "✖ ",
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

/**
 * Text as a quoted Mermaid string. Mermaid has no backslash escapes: `"` ends the string, a leading backtick
 * starts a Markdown string, `%%{` is read as a directive even inside quotes, `<` as HTML and a `\n` in a Windows
 * path as a line break, so those go in as `#code;` entities (and `#` too, so a literal `#1;` stays as written).
 * Each node keeps to one line of source.
 */
const mermaidString = (text: string): string => `"${text.replace(/\s+/g, " ").replace(/[#"%<>\\`]/g, (c) => `#${c.charCodeAt(0)};`)}"`;

const mermaidNodeLabel = (node: MindmapNode): string =>
  mermaidString(`${isTask(node) ? STATUS_GLYPH[node.status] : ""}${TYPE_ICON[node.type] ?? ""}${node.label}`);

const mermaidFileLabel = (f: FileTouch): string => mermaidString(`${f.action.toUpperCase()} ${f.path}${f.lines ? `:${f.lines}` : ""}`);

function toMermaid(doc: MindmapDocument): string {
  const lines: string[] = ["mindmap"];
  const root = doc.nodes[ROOT_ID];
  if (!root) return "mindmap\n  root[No root node]";

  function walk(nodeId: NodeId, indent: number): void {
    const node = doc.nodes[nodeId];
    if (!node) return;
    lines.push(`${"  ".repeat(indent + 1)}${node.id}(${mermaidNodeLabel(node)})`);

    node.files.forEach((f, i) => {
      lines.push(`${"  ".repeat(indent + 2)}${node.id}_f${i}(${mermaidFileLabel(f)})`);
    });

    for (const childId of node.children) {
      walk(childId, indent + 1);
    }
  }

  walk(ROOT_ID, 0);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Mermaid flowchart renderer                                         */
/* ------------------------------------------------------------------ */

const FLOWCHART_ARROW: Record<LinkStyle, string> = {
  solid: "-->",
  dashed: "-.->",
  animated: "==>", // a static diagram can't animate; thick is the closest thing to "live"
};

/**
 * The tree as plain lines and `doc.links` as labeled arrows, which a Mermaid `mindmap` can't draw. Nodes are
 * numbered in tree order because node ids can't be used here: a generated id can contain `--`, which Mermaid
 * reads as the start of an edge.
 */
function toFlowchart(doc: MindmapDocument): string {
  const root = doc.nodes[ROOT_ID];
  if (!root) return 'flowchart LR\n  root["No root node"]';

  const ids = new Map<NodeId, string>();
  const nodes: string[] = [];
  const edges: string[] = [];

  function walk(nodeId: NodeId, parent?: string): void {
    const node = doc.nodes[nodeId];
    if (!node) return;
    const id = `n${ids.size}`;
    ids.set(node.id, id);
    nodes.push(`  ${id}[${mermaidNodeLabel(node)}]`);
    if (parent) edges.push(`  ${parent} --- ${id}`);

    node.files.forEach((f, i) => {
      nodes.push(`  ${id}_f${i}(${mermaidFileLabel(f)})`);
      edges.push(`  ${id} --- ${id}_f${i}`);
    });

    for (const childId of node.children) {
      walk(childId, id);
    }
  }

  walk(ROOT_ID);

  for (const link of doc.links) {
    const from = ids.get(link.from);
    const to = ids.get(link.to);
    if (from && to) edges.push(`  ${from} ${FLOWCHART_ARROW[link.style]}|${mermaidString(link.label)}| ${to}`);
  }

  return ["flowchart LR", ...nodes, ...edges].join("\n");
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

export const RENDER_FORMATS = ["mermaid", "mermaid-flowchart", "text", "json"] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

export interface RenderOptions {
  format: RenderFormat;
}

export function render(doc: MindmapDocument, options: RenderOptions): string {
  switch (options.format) {
    case "mermaid":
      return toMermaid(doc);
    case "mermaid-flowchart":
      return toFlowchart(doc);
    case "text":
      return toIndentedText(doc);
    case "json":
      return JSON.stringify(doc, null, 2);
  }
}