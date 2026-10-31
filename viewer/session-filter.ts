/**
 * Which sessions the list shows, and what state each one is in. Pure, so it is unit-tested without a DOM.
 */

import type { MindmapListItem } from "../src/model/schema.js";
import { repoName, worktreeName } from "./session-groups.js";

export const STATUS_FILTERS = ["all", "running", "blocked", "finished"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/** A session with an active task that hasn't changed for this long has probably been abandoned. */
export const IDLE_AFTER_MS = 24 * 60 * 60 * 1000;

export const isFinished = (s: MindmapListItem): boolean => s.totalTasks > 0 && s.completedTasks === s.totalTasks;

export function isIdle(s: MindmapListItem, nowMs: number): boolean {
  return nowMs - new Date(s.updatedAt).getTime() > IDLE_AFTER_MS;
}

function hasStatus(s: MindmapListItem, status: StatusFilter): boolean {
  switch (status) {
    case "all":
      return true;
    case "running":
      return s.activeTask !== undefined;
    case "blocked":
      return s.blockedTasks > 0;
    case "finished":
      return isFinished(s);
  }
}

/**
 * Whether a session matches the filter box: anything in it, or its repository or worktree name. The
 * whole path isn't searched: its common parts, such as "Users", would match almost everything.
 */
export function matchesSessionQuery(s: MindmapListItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const terms = [s.title, repoName(s), worktreeName(s), s.activeTask, s.searchText];
  return terms.some((term) => term?.toLowerCase().includes(q));
}

export interface SessionView {
  query: string;
  status: StatusFilter;
  /** Show the archive instead of the working sessions. */
  archived: boolean;
}

/** The sessions the toggles select: working ones or the archive. Text filtering searches both. */
export function sessionsInView(items: readonly MindmapListItem[], { query, archived }: SessionView): MindmapListItem[] {
  if (query.trim() && !archived) return [...items];
  return items.filter((s) => Boolean(s.archivedAt) === archived);
}

/** The sessions the list shows. */
export function visibleSessions(items: readonly MindmapListItem[], view: SessionView): MindmapListItem[] {
  return sessionsInView(items, view).filter((s) => hasStatus(s, view.status) && matchesSessionQuery(s, view.query));
}
