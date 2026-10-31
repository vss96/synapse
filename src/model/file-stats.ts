/**
 * Reading file touches: what a touch changed, and each file across every node that touched it. Used by
 * the MCP tools and the viewer, so like kinds.ts it has no runtime dependencies (schema.ts would bundle zod).
 */

import type { CodeChange, FileTouch, MindmapNode } from "./schema.js";

export function touchChanges(f: FileTouch): readonly CodeChange[] {
  return f.action === "read" ? [] : f.changes;
}

/** What the watcher writes as a touch's summary, the only sign of it on mindmaps saved before `source` existed. */
const AUTO_SUMMARY_PREFIX = "Auto-detected file ";

/** Whether the workspace watcher picked this touch up, rather than an agent logging it. */
export function isAutoDetected(f: FileTouch): boolean {
  return f.source === "watcher" || (f.summary?.startsWith(AUTO_SUMMARY_PREFIX) ?? false);
}

/** A file aggregated across every node that touched it. */
export interface AggregatedFile {
  /** The latest touch: decides path, action, summary, lines and previous path. */
  touch: FileTouch;
  /** No agent logged this file on any node: every touch was auto-detected. */
  autoDetected: boolean;
  /** Changes from every touch, merged on kind + symbol. */
  changes: Array<CodeChange & { via: string[] }>;
  nodes: MindmapNode[];
}

/**
 * Aggregate per path across nodes; the most recent touch decides action and summary, keeping older
 * details it doesn't restate. Changes merge on kind + symbol (like `mergeChanges`) and remember every
 * node that logged them.
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
      if (existing && f.timestamp >= existing.touch.timestamp) {
        const prev = existing.touch;
        existing.touch = {
          ...f,
          summary: f.summary ?? prev.summary,
          lines: f.lines ?? prev.lines,
          symbols: f.symbols ?? prev.symbols,
        };
      }
    }
  }
  return files;
}
