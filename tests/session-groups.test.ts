import { describe, expect, it } from "bun:test";
import { MindmapId, type MindmapListItem } from "../src/model/schema.js";
import { ARCHIVED_GROUP, groupSessions, worktreeName } from "../viewer/session-groups.js";

function session(id: string, paths: Partial<MindmapListItem>): MindmapListItem {
  const updatedAt = "2026-10-30T12:00:00.000Z";
  const counts = { nodeCount: 1, completedTasks: 0, totalTasks: 0, blockedTasks: 0, fileCount: 0, loggedFileCount: 0, searchText: "" };
  return { id: MindmapId.parse(id), title: id, updatedAt, createdAt: updatedAt, ...counts, ...paths };
}

describe("viewer session groups", () => {
  it("puts a repository's worktrees in one group named after the repository", () => {
    const repoPath = "/code/synapse";
    const groups = groupSessions([
      session("mm_worktree", { repoPath, workspacePath: `${repoPath}/.claude/worktrees/ux-loop` }),
      session("mm_other", { repoPath: "/code/other", workspacePath: "/code/other" }),
      session("mm_main", { repoPath, workspacePath: repoPath }),
    ]);
    expect(groups.map((g) => [g.name, g.hint, g.items.map((s) => String(s.id)).join()])).toEqual([
      ["synapse", repoPath, "mm_worktree,mm_main"],
      ["other", "/code/other", "mm_other"],
    ]);
  });

  it("falls back to the workspace, then to No repository, and keeps archived sessions last", () => {
    const groups = groupSessions([
      session("mm_archived", { repoPath: "/code/synapse", archivedAt: "2026-10-30T12:00:00.000Z" }),
      session("mm_plain", { workspacePath: "/code/not-a-repo" }),
      session("mm_none", {}),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["not-a-repo", "No repository", "Archived"]);
    expect(groups.at(-1)?.key).toBe(ARCHIVED_GROUP);
  });

  it("names the worktree a session ran in, but not the main checkout", () => {
    const repoPath = "/code/synapse";
    expect(worktreeName(session("mm_a", { repoPath, workspacePath: "/code/synapse/.worktrees/fix" }))).toBe("fix");
    expect(worktreeName(session("mm_b", { repoPath, workspacePath: "C:\\code\\fix" }))).toBe("fix");
    expect(worktreeName(session("mm_c", { repoPath, workspacePath: repoPath }))).toBeUndefined();
    expect(worktreeName(session("mm_d", { workspacePath: "/code/not-a-repo" }))).toBeUndefined();
  });
});
