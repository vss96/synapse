import type { MindmapDocument, NodeStatus, NodeType } from "./types.js";

const STATUS_BADGE: Record<NodeStatus, string> = {
  none: "",
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

/* ------------------------------------------------------------------ */
/*  Mermaid renderer                                                   */
/* ------------------------------------------------------------------ */

function toMermaid(doc: MindmapDocument): string {
  const lines: string[] = ["mindmap"];
  const root = doc.nodes["root"];
  if (!root) return "mindmap\n  root[No root node]";

  function walk(nodeId: string, indent: number): void {
    const node = doc.nodes[nodeId];
    if (!node) return;
    const statusPrefix = node.status ? STATUS_BADGE[node.status] || "" : "";
    const typePrefix = node.type ? TYPE_ICON[node.type] || "" : "";
    const rawLabel = `${statusPrefix}${typePrefix}${node.label}`;
    const label = rawLabel.replace(/[\[\](){}]/g, ""); // strip brackets that confuse mermaid
    lines.push(`${"  ".repeat(indent + 1)}${node.id === "root" ? "root" : node.id}(${label})`);

    if (node.files && node.files.length > 0) {
      for (const f of node.files) {
        const fileLabel = `${f.action ? f.action.toUpperCase() + " " : ""}${f.path}${f.lines ? ":" + f.lines : ""}`.replace(/[\[\](){}]/g, "");
        lines.push(`${"  ".repeat(indent + 2)}(${fileLabel})`);
      }
    }

    for (const childId of node.children) {
      walk(childId, indent + 1);
    }
  }

  walk("root", 0);
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

  const root = doc.nodes["root"];
  if (!root) return lines.join("\n");

  function walk(nodeId: string, depth: number): void {
    const node = doc.nodes[nodeId];
    if (!node) return;
    const indent = "  ".repeat(depth);
    const statusBadge = node.status && node.status !== "none" ? STATUS_BADGE[node.status] : "";
    const typeIcon = node.type ? TYPE_ICON[node.type] || "" : "";
    const idTag = depth === 0 ? `[root]` : `[${node.id}]`;

    lines.push(`${indent}${depth === 0 ? "● " : "├─ "}${statusBadge}${typeIcon}${node.label} ${idTag}`);

    if (node.notes) {
      lines.push(`${indent}   💬 ${node.notes}`);
    }
    if (node.files && node.files.length > 0) {
      for (const f of node.files) {
        const act = f.action ? `[${f.action.toUpperCase()}] ` : "";
        const loc = f.lines ? `:${f.lines}` : "";
        const sym = f.symbols && f.symbols.length ? ` (${f.symbols.join(", ")})` : "";
        const sum = f.summary ? ` — ${f.summary}` : "";
        lines.push(`${indent}   📄 ${act}${f.path}${loc}${sym}${sum}`);
      }
    }

    for (const childId of node.children) {
      walk(childId, depth + 1);
    }
  }

  walk("root", 0);

  if (doc.links && doc.links.length > 0) {
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