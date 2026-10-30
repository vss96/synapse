/**
 * How the session list is grouped: by repository, with archived sessions in a last group of their
 * own. Pure, so it is unit-tested without a DOM.
 */

import type { MindmapListItem } from "../src/model/schema.js";

/** Not a path, so it can't collide with a repository group. */
export const ARCHIVED_GROUP = "archived:";

export interface SessionGroup {
  key: string;
  name: string;
  /** Shown on hover: the full repository path. */
  hint: string;
  items: MindmapListItem[];
}

const lastSegment = (filePath: string): string => filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;

/** Groups in order of their most recently updated session (the list arrives newest first). */
export function groupSessions(items: MindmapListItem[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  const archived: SessionGroup = { key: ARCHIVED_GROUP, name: "Archived", hint: "Archived sessions", items: [] };
  for (const s of items) {
    if (s.archivedAt) {
      archived.items.push(s);
      continue;
    }
    const key = s.repoPath ?? s.workspacePath ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { key, name: key ? lastSegment(key) : "No repository", hint: key || "Sessions without a workspacePath", items: [] };
      groups.set(key, group);
    }
    group.items.push(s);
  }
  return archived.items.length ? [...groups.values(), archived] : [...groups.values()];
}

/** The worktree a session ran in, which tells it from the others in its group; undefined in the main checkout. */
export function worktreeName({ workspacePath, repoPath }: MindmapListItem): string | undefined {
  return workspacePath && repoPath && workspacePath !== repoPath ? lastSegment(workspacePath) : undefined;
}
