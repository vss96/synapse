import { describe, expect, it } from "bun:test";
import { MindmapId, type MindmapListItem } from "../src/model/schema.js";
import { IDLE_AFTER_MS, inOrder, isIdle, matchesSessionQuery, sessionsInView, visibleSessions } from "../viewer/session-filter.js";

function session(id: string, fields: Partial<MindmapListItem> = {}): MindmapListItem {
  const updatedAt = "2026-10-30T12:00:00.000Z";
  const counts = { nodeCount: 1, completedTasks: 0, totalTasks: 2, blockedTasks: 0, fileCount: 0, loggedFileCount: 0, searchText: "" };
  return { id: MindmapId.parse(id), title: id, updatedAt, createdAt: updatedAt, ...counts, ...fields };
}

describe("viewer session filter", () => {
  const ids = (items: MindmapListItem[]) => items.map((s): string => s.id);

  it("finds a session by what's inside it, not only its title", () => {
    const s = session("mm_a", { title: "Refactor", searchText: "Move locks\nshedlock contention" });
    expect(matchesSessionQuery(s, "ShedLock")).toBe(true);
    expect(matchesSessionQuery(s, "refactor")).toBe(true);
    expect(matchesSessionQuery(s, "nothing")).toBe(false);
  });

  it("matches the repository and worktree by name, but not the rest of the path", () => {
    const repoPath = "/Users/vss/code/synapse";
    const s = session("mm_a", { repoPath, workspacePath: `${repoPath}/.claude/worktrees/ux-loop` });
    expect(matchesSessionQuery(s, "synapse")).toBe(true);
    expect(matchesSessionQuery(s, "ux-loop")).toBe(true);
    expect(matchesSessionQuery(s, "users")).toBe(false);
    expect(matchesSessionQuery(s, "worktrees")).toBe(false);
  });

  const running = session("mm_running", { activeTask: "Doing" });
  const blocked = session("mm_blocked", { blockedTasks: 1 });
  const finished = session("mm_finished", { completedTasks: 2 });
  const archived = session("mm_archived", { archivedAt: "2026-10-30T12:00:00.000Z", title: "Old finished work", completedTasks: 2 });
  const all = [running, blocked, finished, archived];
  const view = { query: "", status: "all", archived: false } as const;

  it("selects sessions by status", () => {
    expect(ids(visibleSessions(all, { ...view, status: "running" }))).toEqual(["mm_running"]);
    expect(ids(visibleSessions(all, { ...view, status: "blocked" }))).toEqual(["mm_blocked"]);
    expect(ids(visibleSessions(all, { ...view, status: "finished" }))).toEqual(["mm_finished"]);
  });

  it("shows working sessions or the archive, and filtering text searches both", () => {
    expect(ids(visibleSessions(all, view))).toEqual(["mm_running", "mm_blocked", "mm_finished"]);
    expect(ids(visibleSessions(all, { ...view, archived: true }))).toEqual(["mm_archived"]);
    expect(ids(visibleSessions(all, { ...view, query: "finished" }))).toEqual(["mm_finished", "mm_archived"]);
    expect(sessionsInView(all, { ...view, query: "finished" })).toHaveLength(4);
  });

  it("puts sessions in a held order, and any it doesn't list last, as they came", () => {
    const [a, b, c, d] = ["mm_a", "mm_b", "mm_c", "mm_d"].map((id) => session(id));
    expect(ids(inOrder([d!, a!, b!, c!], ["mm_c", "mm_a", "mm_gone"]))).toEqual(["mm_c", "mm_a", "mm_d", "mm_b"]);
  });

  it("calls a session idle once it hasn't changed for a day", () => {
    const updated = new Date(running.updatedAt).getTime();
    expect(isIdle(running, updated + IDLE_AFTER_MS)).toBe(false);
    expect(isIdle(running, updated + IDLE_AFTER_MS + 1)).toBe(true);
  });
});
