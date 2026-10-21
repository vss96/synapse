import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { watch, existsSync, statSync, type FSWatcher } from "node:fs";
import path from "node:path";
import * as store from "./store.js";
import { fileTouchTarget, upsertFileTouch } from "./model/file-touch.js";
import { MindmapId, now, type EditTouch } from "./model/schema.js";

const execFileAsync = promisify(execFile);

/** Tool, cache and build directories. Only used outside git: in a repo, its own ignore rules decide. */
const FALLBACK_IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  ".DS_Store",
  ".gradle",
  ".idea",
  ".kotlin",
  ".venv",
  "__pycache__",
]);

/** Editor and atomic-write temp files: `x~`, `.x.swp`, `x.tmp`, Claude Code's `x.tmp.<pid>.<hex>`, BSD `sed -i`'s `.!<pid>!x`. */
const TEMP_FILE = /(~|\.swp|\.tmp|\.tmp\.\d+\.[0-9a-f]+)$|(^|\/)\.!\d+!/;

/**
 * Paths never worth recording: git's own files, temp files and synapse's data. Outside a git repo,
 * also common tool, cache and build directories (in a repo, `gitIgnored` applies its ignore rules).
 */
export function shouldIgnorePath(relPath: string, inRepo: boolean): boolean {
  const parts = relPath.split(/[\\/]/);
  if (parts.includes(".git")) return true;
  if (!inRepo && parts.some((part) => FALLBACK_IGNORED_SEGMENTS.has(part))) return true;
  // Ignore synapse's own data JSON files if watching the synapse repo itself
  if (parts[0] === "data" && relPath.endsWith(".json")) return true;
  return TEMP_FILE.test(relPath);
}

/** Run git in `cwd`, writing `input` to its stdin; "" when it fails (not a repo, no commits yet, nothing matched…). */
async function git(cwd: string, args: string[], input?: string): Promise<string> {
  try {
    const run = execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    run.child.stdin?.end(input);
    return (await run).stdout;
  } catch {
    return "";
  }
}

/** Those of `paths` that git ignores (honouring .gitignore files, .git/info/exclude and global excludes). */
async function gitIgnored(cwd: string, paths: string[]): Promise<Set<string>> {
  const out = await git(cwd, ["check-ignore", "--stdin", "-z"], paths.join("\0"));
  return new Set(out.split("\0").filter(Boolean));
}

/** Those of `paths` that git lists with `args` (`ls-files` for tracked, `diff --name-only HEAD` for changed). */
async function gitListed(cwd: string, args: string[], paths: string[]): Promise<Set<string>> {
  const listed = new Set<string>();
  // Paths go on the command line, so pass them in chunks to stay under the OS argument limit
  for (let i = 0; i < paths.length; i += 1000) {
    const out = await git(cwd, ["--literal-pathspecs", ...args, "-z", "--", ...paths.slice(i, i + 1000)]);
    for (const p of out.split("\0")) if (p) listed.add(p);
  }
  return listed;
}

/** How long after a checkout, rebase, reset, merge or pull its file events may still arrive. */
const VCS_SETTLE_MS = 30_000;

/**
 * Inspect git status and diff --numstat in a workspace directory. Staged renames
 * (`R old -> new`) are reported as renames; everything else as create, modify or delete.
 */
export async function inspectGitChanges(workspacePath: string): Promise<EditTouch[]> {
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace path does not exist: ${workspacePath}`);
  }

  const [{ stdout: statusOut }, { stdout: numstatOut }] = await Promise.all([
    execFileAsync("git", ["status", "--porcelain"], { cwd: workspacePath }).catch(() => ({ stdout: "" })),
    execFileAsync("git", ["diff", "--numstat", "HEAD"], { cwd: workspacePath }).catch(() => ({ stdout: "" })),
  ]);

  const statsMap = new Map<string, string>();
  for (const line of numstatOut.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, filePath] = line.split("\t");
    if (filePath && added !== undefined && removed !== undefined) {
      statsMap.set(filePath.trim(), `+${added}/-${removed} lines`);
    }
  }

  const changes: EditTouch[] = [];
  const timestamp = now();
  for (const line of statusOut.split("\n")) {
    if (!line.trim() || line.length < 4) continue;
    const code = line.slice(0, 2);
    const [from, to] = line.slice(3).trim().split(" -> ");
    const filePath = (to ?? from ?? "").trim();
    const previousPath = to !== undefined ? from?.trim() : undefined;
    if (!filePath || shouldIgnorePath(filePath, true)) continue;

    const diffStat = statsMap.get(filePath);
    const describe = (action: string) => (diffStat ? `Git ${action} (${diffStat})` : `Git ${action}`);
    const common = { path: filePath, changes: [], timestamp };
    if (code.includes("R") && previousPath) {
      changes.push({ ...common, action: "rename", previousPath, summary: describe("rename") });
    } else {
      const action = code.includes("?") || code.includes("A") ? "create" : code.includes("D") ? "delete" : "modify";
      changes.push({ ...common, action, summary: describe(action) });
    }
  }

  return changes;
}

/* ------------------------------------------------------------------ */
/*  Active workspace directory watchers                                */
/* ------------------------------------------------------------------ */

const activeWatchers = new Map<string, FSWatcher>();

export function ensureWorkspaceWatcher(mindmapId: MindmapId, workspacePath?: string): void {
  if (!workspacePath || !existsSync(workspacePath)) return;
  const resolved = path.resolve(workspacePath);
  const key = `${mindmapId}:${resolved}`;
  if (activeWatchers.has(key)) return;

  // Path → whether fs.watch reported a `rename` for it (a file appearing or disappearing) in this batch.
  const pendingFiles = new Map<string, boolean>();
  let batchStart = 0;
  let debounceTimer: NodeJS.Timeout | null = null;
  let flushing = Promise.resolve();
  // Until git answers, assume no repo: the fallback list filters more, never less.
  let inRepo = false;
  void git(resolved, ["rev-parse", "--is-inside-work-tree"]).then((out) => (inRepo = out.trim() === "true"));

  const flushBatch = async () => {
    const batch = new Map(pendingFiles);
    const startedAt = batchStart;
    pendingFiles.clear();
    if (batch.size === 0) return;

    // Ask git everything first: store.update holds the mindmap's lock only for the quick change itself.
    const ignored = await gitIgnored(resolved, [...batch.keys()]);
    const paths = [...batch.keys()].filter((p) => !ignored.has(p));
    if (paths.length === 0) return;
    const rebasing = (await git(resolved, ["rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply"]))
      .split("\n")
      .some((p) => p && existsSync(path.resolve(resolved, p)));
    if (rebasing) {
      await store.update(mindmapId, (doc) =>
        store.recordActivity(doc, `Git rebase in progress: ${paths.length} file change(s) not attributed to a task`),
      );
      return;
    }
    const tracked = await gitListed(resolved, ["ls-files"], paths);

    // A checkout, reset, merge or pull rewrites the worktree to match the new HEAD; that churn isn't
    // the agent's edits. HEAD's reflog says what last moved it and when (a commit is the agent's own).
    // Files that now match HEAD came from git; files that differ from it were edited on top.
    // `%gd` with --date=unix is `HEAD@{<seconds>}`: when HEAD moved (not when its commit was made).
    const [selector = "", operation = ""] = (await git(resolved, ["reflog", "-1", "--date=unix", "--format=%gd%x00%gs", "HEAD"])).trim().split("\0");
    const movedAt = Number(/@\{(\d+)\}/.exec(selector)?.[1] ?? 0);
    const vcsMoved = operation !== "" && !operation.startsWith("commit") && movedAt * 1000 >= startedAt - VCS_SETTLE_MS;
    // --relative: paths relative to the workspace, like ls-files, even when it's a subdirectory of the repo
    const changed = vcsMoved ? await gitListed(resolved, ["diff", "--relative", "--name-only", "HEAD"], paths) : new Set<string>();
    // store.update only writes the mindmap if this changed it.
    await store.update(mindmapId, (doc) => {
      let churn = 0;
      const recorded = new Set(Object.values(doc.nodes).flatMap((n) => n.files.map((f) => f.path)));

      // Classify by the file's state before the batch, not by event type: editors and git replace files
      // by renaming a temp over them, which fs.watch reports as `rename` just like a new file.
      const touches: [string, "create" | "modify" | "delete"][] = [];
      for (const relPath of paths) {
        const renamed = batch.get(relPath)!;
        const stat = statSync(path.join(resolved, relPath), { throwIfNoEntry: false });
        if (stat?.isDirectory()) continue; // a new directory; the files written into it have their own events
        const exists = stat !== undefined;
        if (vcsMoved && (tracked.has(relPath) ? !changed.has(relPath) : !exists)) {
          churn++;
          continue;
        }
        const known = tracked.has(relPath) || recorded.has(relPath);
        if (!exists) {
          if (known) touches.push([relPath, "delete"]); // else it came and went within the batch
        } else {
          touches.push([relPath, known || !renamed ? "modify" : "create"]);
        }
      }
      if (churn > 0) store.recordActivity(doc, `Git ${operation}: ${churn} file change(s) not attributed to a task`);
      if (touches.length === 0) return;

      const targetNode = fileTouchTarget(doc);
      for (const [relPath, action] of touches) {
        upsertFileTouch(targetNode, { path: relPath, action, changes: [], summary: `Auto-detected file ${action}`, timestamp: now() });
        store.recordActivity(doc, `File ${action}: ${relPath}`, { nodeId: targetNode.id, file: relPath });
      }
    });
  };

  // One batch at a time, so two flushes never load and save the document over each other.
  const flush = () => {
    debounceTimer = null;
    flushing = flushing.then(flushBatch).catch((err) => console.error(`[synapse] watcher: ${err}`));
  };

  try {
    const watcher = watch(resolved, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const relPath = filename.replace(/\\/g, "/");
      if (shouldIgnorePath(relPath, inRepo)) return;

      if (pendingFiles.size === 0) batchStart = Date.now();
      pendingFiles.set(relPath, pendingFiles.get(relPath) === true || eventType === "rename");
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, 600);
    });
    watcher.unref();

    activeWatchers.set(key, watcher);
  } catch {
    // Recursive watch may fail on unsupported mounts; fail gracefully
  }
}
