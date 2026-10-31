/**
 * Reading file touches: what a touch changed, and each file across every node that touched it. Used by
 * the MCP tools and the viewer, so like kinds.ts it has no runtime dependencies (schema.ts would bundle zod).
 */

import type { ActivityEntry, CodeChange, EditTouch, FileTouch, MindmapNode } from "./schema.js";

export function touchChanges(f: FileTouch): readonly CodeChange[] {
  return f.action === "read" ? [] : f.changes;
}

/** What the watcher writes as a touch's summary, the only sign of it on mindmaps saved before `source` existed. */
const AUTO_SUMMARY_PREFIX = "Auto-detected file ";

/** Whether the watcher or a git sync found this touch, rather than an agent logging it. */
export function isAutoDetected(f: FileTouch): boolean {
  return f.source !== undefined || (f.summary?.startsWith(AUTO_SUMMARY_PREFIX) ?? false);
}

/** What the watcher writes for each file it records. Mindmaps already saved have no other sign of it. */
const FILE_EVENT = /^File (create|modify|delete): /;

/** Whether the watcher wrote this activity entry for one changed file, rather than it being part of the session's story. */
export function isFileEvent(entry: ActivityEntry): boolean {
  return FILE_EVENT.test(entry.message);
}

/** Merge symbol-level changes; a later change with the same kind + symbol replaces the earlier one. */
export function mergeChanges(prev: readonly CodeChange[], next: readonly CodeChange[]): CodeChange[] {
  const merged = [...prev];
  for (const change of next) {
    const i = merged.findIndex((c) => c.kind === change.kind && c.symbol === change.symbol);
    const earlier = merged[i];
    if (earlier) merged[i] = { ...change, detail: change.detail ?? earlier.detail };
    else merged.push(change);
  }
  return merged;
}

/** The action a file ends up with after an earlier and a later edit; a rename keeps its previous path. */
function combinedAction(
  prev: EditTouch,
  next: EditTouch,
): { action: "rename"; previousPath: string } | { action: "create" | "modify" | "delete" } {
  if (next.action === "delete") return { action: "delete" };
  if (next.action === "modify" && prev.action === "create") return { action: "create" };
  if (next.action === "modify" && prev.action === "rename") return { action: "rename", previousPath: prev.previousPath };
  return next.action === "rename" ? { action: "rename", previousPath: next.previousPath } : { action: next.action };
}

/**
 * The summary and source of a file after two touches. What an agent logged outranks what the watcher
 * saw: its summary stays, the watcher's boilerplate doesn't, and the file counts as logged from then on.
 */
function combinedProvenance(prev: FileTouch, next: FileTouch): Pick<FileTouch, "summary" | "source"> {
  const [prevAuto, nextAuto] = [isAutoDetected(prev), isAutoDetected(next)];
  if (prevAuto && nextAuto) return { summary: next.summary ?? prev.summary, source: next.source ?? prev.source };
  if (prevAuto) return { summary: next.summary, source: undefined };
  return { summary: nextAuto ? prev.summary : (next.summary ?? prev.summary), source: undefined };
}

/**
 * Fold a later touch of the same file into an earlier one. Reading a file never downgrades an
 * edit, creating then modifying stays a create, and renaming then modifying stays a rename.
 */
export function combineTouches(prev: FileTouch, next: FileTouch): FileTouch {
  const common = {
    path: next.path,
    lines: next.lines ?? prev.lines,
    symbols: next.symbols ?? prev.symbols,
    ...combinedProvenance(prev, next),
    timestamp: next.timestamp,
  };
  if (next.action === "read") {
    if (prev.action === "read") return { ...common, action: "read" };
    return isAutoDetected(prev) && !isAutoDetected(next) ? { ...prev, ...combinedProvenance(prev, next) } : prev;
  }
  if (prev.action === "read") return { ...common, ...next, ...common };

  return { ...common, ...combinedAction(prev, next), changes: mergeChanges(prev.changes, next.changes) };
}

/** A file aggregated across every node that touched it. */
export interface AggregatedFile {
  /** Every touch, folded together in time order. */
  touch: FileTouch;
  /** No agent logged this file on any node: every touch was auto-detected. */
  autoDetected: boolean;
  /** Changes from every touch, merged on kind + symbol. */
  changes: Array<CodeChange & { via: string[] }>;
  nodes: MindmapNode[];
}

/**
 * Aggregate per path across nodes, folding touches in time order with the rules for one node
 * (`combineTouches`), so the result doesn't depend on which node comes first. Changes merge on
 * kind + symbol (like `mergeChanges`) and remember every node that logged them.
 */
export function aggregateFiles(nodes: readonly MindmapNode[]): Map<string, AggregatedFile> {
  const files = new Map<string, AggregatedFile>();
  for (const n of nodes) {
    for (const f of n.files) {
      const existing = files.get(f.path);
      const agg: AggregatedFile = existing ?? { touch: f, autoDetected: true, changes: [], nodes: [n] };
      if (!existing) files.set(f.path, agg);
      else if (!agg.nodes.some((x) => x.id === n.id)) agg.nodes.push(n);
      if (!isAutoDetected(f)) agg.autoDetected = false;

      for (const c of touchChanges(f)) {
        const i = agg.changes.findIndex((x) => x.kind === c.kind && x.symbol === c.symbol);
        const same = agg.changes[i];
        if (!same) agg.changes.push({ ...c, via: [n.label] });
        else {
          agg.changes[i] = { ...c, detail: c.detail ?? same.detail, via: same.via };
          if (!same.via.includes(n.label)) same.via.push(n.label);
        }
      }
      if (existing) {
        const { touch } = existing;
        existing.touch = f.timestamp >= touch.timestamp ? combineTouches(touch, f) : combineTouches(f, touch);
      }
    }
  }
  return files;
}
