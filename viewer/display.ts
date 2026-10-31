/** How the model's kinds look: labels, glyphs, tone classes and change tallies. */

import { CHANGE_KINDS as KIND_ORDER, isChangeKind, type ChangeKind, type FileAction, type NodeType, type TaskStatus } from "../src/model/kinds.js";
import { touchChanges } from "../src/model/file-stats.js";
import type { CodeChange, MindmapNode } from "../src/model/schema.js";
import { escXml } from "./dom.js";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  planned: "○ Planned",
  in_progress: "◐ In Progress",
  completed: "✔ Completed",
  blocked: "✖ Blocked",
};

export const TYPE_BADGES: Partial<Record<NodeType, string>> = {
  component: "📦 Component",
  data_flow: "⇄ Data Flow",
  hypothesis: "💡 Hypothesis",
  decision: "⚖️ Decision",
  risk: "⚠️ Risk",
};

// Colors live in index.html: a `tone-<key>` class (task status, concept type, change kind or
// file action) sets the --c color that badges, tallies and cards use, in light and dark mode.
export const toneClass = (key: TaskStatus | NodeType | ChangeKind | FileAction) => `tone-${escXml(key)}`;

// Symbol-level change kinds, shown in KIND_ORDER (kinds.ts's CHANGE_KINDS).
export const CHANGE_KINDS: Record<ChangeKind, { glyph: string; label: string }> = {
  add: { glyph: "+", label: "Added" },
  modify: { glyph: "~", label: "Modified" },
  fix: { glyph: "✱", label: "Fixed" },
  refactor: { glyph: "⟲", label: "Refactored" },
  rename: { glyph: "↦", label: "Renamed" },
  remove: { glyph: "−", label: "Removed" },
  test: { glyph: "✓", label: "Tested" },
};

/** Uploaded files aren't validated; unknown change kinds display as "modify". */
export function kindOf(change: CodeChange): ChangeKind {
  return isChangeKind(change.kind) ? change.kind : "modify";
}

export function nodeChanges(node: MindmapNode): CodeChange[] {
  return node.files.flatMap(touchChanges);
}

/** [[kind, count], ...] in display order, non-zero only. */
export function tallyChanges(changes: readonly CodeChange[]): Array<[ChangeKind, number]> {
  const counts: Partial<Record<ChangeKind, number>> = {};
  for (const c of changes) counts[kindOf(c)] = (counts[kindOf(c)] || 0) + 1;
  return KIND_ORDER.filter((k) => counts[k]).map((k): [ChangeKind, number] => [k, counts[k] ?? 0]);
}

export function tallySvg(changes: readonly CodeChange[]) {
  return tallyChanges(changes)
    .map(([k, n]) => `<tspan class="svg-tone ${toneClass(k)}" font-weight="700">${CHANGE_KINDS[k].glyph}${n} </tspan>`)
    .join("");
}

export function tallyHtml(changes: readonly CodeChange[]) {
  return tallyChanges(changes)
    .map(([k, n]) => `<span class="kind-tally ${toneClass(k)}" title="${CHANGE_KINDS[k].label}">${CHANGE_KINDS[k].glyph}${n}</span>`)
    .join("");
}

/** "6 files", or "6 files · 240 auto" when the watcher picked up others that no agent logged. */
export function fileCountText(logged: number, total: number): string {
  const auto = total - logged;
  return `${logged} file${logged === 1 ? "" : "s"}${auto > 0 ? ` · ${auto} auto` : ""}`;
}
