/** The left-hand session list, and opening sessions. */

import type { MindmapDocument, MindmapList, MindmapListItem } from "../src/model/schema.js";
import { requestFreshView } from "./canvas.js";
import { loadCollapsed } from "./collapse.js";
import { fileCountText } from "./display.js";
import { byId, errorMessage, escXml, serverJson, setHtml } from "./dom.js";
import { ROOT } from "./layout.js";
import { closeDrawer, remember, remembered } from "./panels.js";
import { STATUS_FILTERS, isFinished, isIdle, sessionsInView, visibleSessions, type SessionView } from "./session-filter.js";
import { ARCHIVED_GROUP, groupSessions, repoName, worktreeName } from "./session-groups.js";
import { sessionHash, sessionIdFromHash } from "./session-link.js";
import { nodeById, render, resetSelection, state } from "./state.js";
import { toast } from "./toast.js";

/** A change the server pushes to every open page. */
export type ViewerEvent =
  | { type: "connected" }
  | { type: "mindmap_updated"; id: string; item: MindmapListItem }
  | { type: "mindmap_deleted"; id: string }
  | { type: "mindmap_unreadable"; id: string; error: string };

type SessionEvent = Exclude<ViewerEvent, { type: "connected" }>;

export function loadMindmap(doc: MindmapDocument): void {
  if (doc.id !== state.currentDoc?.id) {
    requestFreshView();
    state.collapsed = loadCollapsed(doc.id);
  }
  state.currentDoc = doc;
  state.currentId = doc.id;
  if (!nodeById(doc, state.selectedNodeId)) state.selectedNodeId = ROOT;
  render();
}

let latestFetch = 0;

export async function fetchMindmapById(id: string): Promise<void> {
  if (!id) return;
  const fetchId = ++latestFetch;
  const res = await fetch(`/api/mindmaps/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.ok) {
    const doc = serverJson<MindmapDocument>(await res.text());
    // Ignore a session we already switched away from, and an older copy that lost a race with a newer one.
    if (id === state.currentId && fetchId === latestFetch) loadMindmap(doc);
  }
}

const LIVE_WINDOW_MS = 2 * 60 * 1000;
/** How long a Delete button waits for its second click. */
const DELETE_ARMED_MS = 4000;
/** A second click sooner than this is a double-click on Delete, not a decision. */
const DELETE_MIN_CONFIRM_MS = 500;
/** The server deletes by mindmap id, so a file with any other name has to be removed by hand. */
const DELETABLE_ID = /^[A-Za-z0-9_-]+$/;

const sessionList = byId("session-list");
const archivedToggle = byId("archived-toggle");
const recentToggle = byId("recent-toggle");
const statusButtons = document.querySelectorAll<HTMLElement>("#session-status button");

function timeAgo(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (!iso || Number.isNaN(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const COLLAPSED_GROUPS_KEY = "synapse.collapsedGroups";
const RECENT_KEY = "synapse.sessionsRecent";

state.recentSessions = remembered(RECENT_KEY) === "1";

/** Group keys the user collapsed; the archived group starts collapsed. */
const collapsedGroups = new Set<string>(
  (() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? "null");
      return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [ARCHIVED_GROUP];
    } catch {
      return [ARCHIVED_GROUP];
    }
  })(),
);

function toggleGroup(key: string) {
  if (!collapsedGroups.delete(key)) collapsedGroups.add(key);
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedGroups]));
  } catch {
    // Storage blocked or full: the group still toggles, it just isn't remembered.
  }
  renderSessions();
}

/** What a row says about a session that needs attention, or needs none. */
function stateBadge(s: MindmapListItem) {
  if (s.blockedTasks > 0) return `<span class="session-badge tone-blocked" title="${s.blockedTasks} blocked task${s.blockedTasks === 1 ? "" : "s"}">✖ ${s.blockedTasks} blocked</span>`;
  return isFinished(s) ? `<span class="session-badge tone-completed" title="Every task is completed">✔ done</span>` : "";
}

/** The session whose Delete button was clicked once; the next click there deletes it. */
let armedDelete: string | null = null;
let armedAt = 0;
let disarmDelete: ReturnType<typeof setTimeout> | undefined;

function deleteButton(id: string) {
  const armed = armedDelete === id;
  return `<button class="session-action danger" data-action="delete" data-focus="delete:${escXml(id)}" title="Delete this session for good">${armed ? "Confirm" : "Delete"}</button>`;
}

/** Where a session ran, beside its time. A flat list has no group headings to say the rest. */
function placeHtml(s: MindmapListItem, flat: boolean) {
  const place = [flat ? repoName(s) : undefined, worktreeName(s), flat && s.archivedAt ? "archived" : undefined].filter(Boolean);
  return place.length ? `<span class="session-worktree">· ${escXml(place.join(" · "))}</span>` : "";
}

function sessionItemHtml(s: MindmapListItem, flat: boolean) {
  const pct = s.totalTasks > 0 ? Math.round((s.completedTasks / s.totalTasks) * 100) : 0;
  const open = s.id === state.currentId;
  const nowMs = Date.now();
  const live = nowMs - new Date(s.updatedAt).getTime() < LIVE_WINDOW_MS;
  const idle = isIdle(s, nowMs);
  const actions = s.archivedAt
    ? `<button class="session-action" data-action="restore" data-focus="restore:${escXml(s.id)}" title="Restore this session">Restore</button>${deleteButton(s.id)}`
    : `<button class="session-action" data-action="archive" data-focus="archive:${escXml(s.id)}" title="Archive this session">Archive</button>`;
  return `
    <div class="session-item ${open ? "active" : ""} ${s.archivedAt ? "archived" : ""}" data-session-id="${escXml(s.id)}" title="${escXml(s.title)}${s.workspacePath ? `\n${escXml(s.workspacePath)}` : ""}">
      <div class="session-title">${live ? `<span class="session-live-dot" title="Updated in the last 2 minutes"></span>` : ""}<a class="session-title-text" href="${escXml(sessionHash(s.id))}" data-focus="open:${escXml(s.id)}" ${open ? `aria-current="true"` : ""}>${escXml(s.title)}</a>${stateBadge(s)}</div>
      <div class="session-sub">${escXml(timeAgo(s.updatedAt))}${placeHtml(s, flat)}
        <span class="session-actions">${actions}</span>
      </div>
      ${s.activeTask && !s.archivedAt ? `<div class="session-task ${idle ? "idle" : ""}" ${idle ? `title="Idle: no update for ${escXml(timeAgo(s.updatedAt).replace(" ago", ""))}"` : ""}>◐ ${escXml(s.activeTask)}</div>` : ""}
      <div class="session-progress">
        <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        <span>${s.completedTasks}/${s.totalTasks} tasks · ${escXml(fileCountText(s.loggedFileCount, s.fileCount))}</span>
      </div>
    </div>`;
}

/** The sessions listed right now, top to bottom, skipping collapsed groups. */
function listedSessions(): string[] {
  return [...sessionList.querySelectorAll<HTMLElement>(".session-item")].flatMap((el) => el.dataset.sessionId ?? []);
}

/** The session to open once these leave the list: the next one down, else the nearest one up. */
function neighbourOf(ids: readonly string[]): string | undefined {
  const rows = listedSessions();
  const at = rows.indexOf(state.currentId);
  const stays = (id: string) => !ids.includes(id);
  return rows.slice(at + 1).find(stays) ?? rows.slice(0, Math.max(at, 0)).reverse().find(stays);
}

/** Archive or restore sessions, and return the ones that took: some may fail while others go through. */
async function postArchived(ids: readonly string[], archived: boolean): Promise<string[]> {
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const res = await fetch("/api/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mindmapId: id, archived }),
      });
      if (!res.ok) throw new Error(serverJson<{ error?: string }>(await res.text()).error ?? `HTTP ${res.status}`);
      return id;
    }),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) toast(`Could not ${archived ? "archive" : "restore"} the session: ${errorMessage(failed.reason)}`, { error: true });
  await refreshSessions();
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

/** Archive sessions, moving off the open one, and offer to undo it. */
async function archiveSessions(ids: readonly string[]) {
  const open = ids.includes(state.currentId) ? state.currentId : undefined;
  const next = open ? neighbourOf(ids) : undefined;
  const titleOf = (id: string) => state.sessions.find((s) => s.id === id)?.title;
  const title = ids[0] && ids.length === 1 ? `“${titleOf(ids[0])}”` : `${ids.length} sessions`;
  const archived = await postArchived(ids, true);
  if (archived.length === 0) return;
  if (next && open && archived.includes(open)) await selectSession(next);
  toast(`Archived ${archived.length === ids.length ? title : `${archived.length} of ${ids.length} sessions`}`, {
    action: {
      label: "Undo",
      run: async () => {
        const restored = await postArchived(archived, false);
        if (open && restored.includes(open)) await selectSession(open);
      },
    },
  });
}

async function deleteSession(id: string) {
  const next = id === state.currentId ? neighbourOf([id]) : undefined;
  try {
    const res = await fetch(`/api/mindmaps/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(serverJson<{ error?: string }>(await res.text()).error ?? `HTTP ${res.status}`);
    if (next) await selectSession(next);
    toast(`Deleted ${id}`);
  } catch (err) {
    toast(`Could not delete the session: ${errorMessage(err)}`, { error: true });
  }
  await refreshSessions();
  if (id === state.currentId && !state.sessions.some((s) => s.id === id)) await leaveDeletedSession();
}

/** Delete on a deliberate second click: there's no undo. */
function clickDelete(id: string) {
  if (armedDelete === id) {
    if (Date.now() - armedAt < DELETE_MIN_CONFIRM_MS) return;
    clearTimeout(disarmDelete);
    armedDelete = null;
    void deleteSession(id);
    return;
  }
  armedDelete = id;
  armedAt = Date.now();
  clearTimeout(disarmDelete);
  disarmDelete = setTimeout(() => {
    armedDelete = null;
    renderSessions();
  }, DELETE_ARMED_MS);
  renderSessions();
}

const sessionView = (): SessionView => ({ query: state.sessionQuery, status: state.sessionStatus, archived: state.showArchived });

/** Whether the filter box or a status is narrowing the list. */
const narrowed = () => state.sessionQuery.trim() !== "" || state.sessionStatus !== "all";

function renderSessionControls(visible: number) {
  const view = sessionView();
  const total = sessionsInView(state.sessions, { ...view, status: "all" }).length;
  byId("sessions-count").textContent = narrowed() ? `Sessions (${visible} of ${total})` : `Sessions (${total})`;

  const archivedCount = state.sessions.filter((s) => s.archivedAt).length;
  archivedToggle.hidden = archivedCount === 0 && !state.showArchived;
  archivedToggle.textContent = `Archived ${archivedCount}`;
  archivedToggle.setAttribute("aria-pressed", String(state.showArchived));
  recentToggle.setAttribute("aria-pressed", String(state.recentSessions));
  statusButtons.forEach((el) => {
    const on = el.dataset.status === state.sessionStatus;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  });
}

export function renderSessions(): void {
  const list = sessionList;
  const visible = visibleSessions(state.sessions, sessionView());
  renderSessionControls(visible.length);

  const unreadable = byId("sessions-unreadable");
  unreadable.hidden = state.unreadableSessions.length === 0;
  setHtml(
    unreadable,
    `
    <div class="sessions-unreadable-head">⚠ Can't read ${state.unreadableSessions.length} session${state.unreadableSessions.length === 1 ? "" : "s"}</div>
    ${state.unreadableSessions.map((s) => `<div class="sessions-unreadable-item" data-session-id="${escXml(s.id)}"><code>${escXml(s.id)}</code> ${escXml(s.error)} ${DELETABLE_ID.test(s.id) ? deleteButton(s.id) : ""}</div>`).join("")}`,
  );

  if (visible.length === 0) {
    const empty = state.sessions.length === 0 ? "No sessions yet." : state.showArchived && !state.sessionQuery.trim() ? "Nothing archived here." : "No matching sessions.";
    list.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px;">${empty}</div>`;
    return;
  }

  // Filter results are for picking one session, so groups would only hide the most recent ones.
  if (state.recentSessions || narrowed()) {
    setHtml(list, visible.map((s) => sessionItemHtml(s, true)).join(""));
    return;
  }

  setHtml(
    list,
    groupSessions(visible)
      .map((g) => {
        // The archive starts collapsed, but it's all that's listed once someone asks for it.
        const collapsed = !state.showArchived && collapsedGroups.has(g.key);
        const finished = g.key === ARCHIVED_GROUP ? 0 : g.items.filter(isFinished).length;
        return `
        <div class="session-group">
          <div class="session-group-row">
            <button class="session-group-head" data-group="${escXml(g.key)}" data-focus="group:${escXml(g.key)}" title="${escXml(g.hint)}" aria-expanded="${!collapsed}">
              <span class="session-group-chevron">${collapsed ? "▸" : "▾"}</span>
              <span class="session-group-name">${escXml(g.name)}</span>
              <span class="session-group-count">${g.items.length}</span>
            </button>
            ${finished ? `<button class="session-group-action" data-archive-finished="${escXml(g.key)}" data-focus="finished:${escXml(g.key)}" title="Archive the finished sessions in this group">Archive ${finished} done</button>` : ""}
          </div>
          ${collapsed ? "" : g.items.map((s) => sessionItemHtml(s, false)).join("")}
        </div>`;
      })
      .join(""),
  );
}

// Delegated, because the list is redrawn on every update.
function onSessionClick(e: MouseEvent) {
  if (!(e.target instanceof Element)) return;
  const action = e.target.closest<HTMLElement>(".session-action");
  const id = e.target.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
  if (action && id) {
    e.stopPropagation();
    if (action.dataset.action === "archive") void archiveSessions([id]);
    else if (action.dataset.action === "restore") void postArchived([id], false);
    else clickDelete(id);
    return;
  }
  const finished = e.target.closest<HTMLElement>("[data-archive-finished]")?.dataset.archiveFinished;
  if (finished !== undefined) {
    const group = groupSessions(visibleSessions(state.sessions, sessionView())).find((g) => g.key === finished);
    if (group) void archiveSessions(group.items.filter(isFinished).map((s) => s.id));
    return;
  }
  const head = e.target.closest<HTMLElement>(".session-group-head");
  if (head) {
    toggleGroup(head.dataset.group ?? "");
  } else if (e.target.closest(".session-item")) {
    // Opening a title in a new tab or window is the browser's job.
    if (e.target.closest("a") && (e.metaKey || e.ctrlKey || e.shiftKey)) return;
    e.preventDefault();
    void selectSession(id);
  }
}

byId("sessions").addEventListener("click", onSessionClick);

archivedToggle.addEventListener("click", () => {
  state.showArchived = !state.showArchived;
  renderSessions();
});

recentToggle.addEventListener("click", () => {
  state.recentSessions = !state.recentSessions;
  remember(RECENT_KEY, state.recentSessions);
  renderSessions();
});

statusButtons.forEach((el) => {
  el.addEventListener("click", () => {
    state.sessionStatus = STATUS_FILTERS.find((f) => f === el.dataset.status) ?? "all";
    renderSessions();
  });
});

/** Switch to a session, leaving the URL as it is. */
async function showSession(id: string) {
  state.currentId = id;
  state.localFile = null;
  resetSelection();
  closeDrawer();
  renderSessions();
  document.querySelector(".session-item.active")?.scrollIntoView({ block: "nearest" });
  await fetchMindmapById(id);
}

/**
 * Open a session. Switching adds a history entry, so Back returns to the session you left. With
 * `replace`, for a session nobody picked, it doesn't, so Back leaves the viewer instead of landing
 * on a URL with no session in it.
 */
export async function selectSession(id: string | undefined, { replace = false } = {}): Promise<void> {
  if (!id || id === state.currentId) return;
  if (replace) history.replaceState(null, "", sessionHash(id));
  else history.pushState(null, "", sessionHash(id));
  await showSession(id);
}

/**
 * Switch to the session the URL names (Back, Forward or a pasted link). If there is no such
 * session, put back the URL of the open one. A session this page hasn't heard of yet may be new, or
 * the list may still be loading, so the server decides.
 */
async function followUrl() {
  const id = sessionIdFromHash(location.hash);
  if (id === state.currentId) return;
  const known = () => state.sessions.some((s) => s.id === id);
  if (id && !known()) await refreshSessions();
  if (known()) await showSession(id);
  else history.replaceState(null, "", sessionHash(state.currentId));
}

// Back and Forward fire both; a pasted link fires hashchange.
window.addEventListener("popstate", followUrl);
window.addEventListener("hashchange", followUrl);

/** How many full lists are on their way, and the live events since: each list may predate them. */
let listsLoading = 0;
const eventsSinceList: SessionEvent[] = [];

export async function refreshSessions(): Promise<void> {
  listsLoading++;
  try {
    const res = await fetch("/api/mindmaps", { cache: "no-store" });
    if (!res.ok) return;
    const list = serverJson<MindmapList>(await res.text());
    state.sessions = list.mindmaps;
    state.unreadableSessions = list.unreadable;
    eventsSinceList.forEach(applyEvent);
    renderSessions();
  } catch {
    // Viewer opened without the API server; sessions list stays empty
  } finally {
    listsLoading--;
    if (listsLoading === 0) eventsSinceList.length = 0;
  }
}

/** Catch up when events may have been missed: the list, and the open session, which may be gone by now. */
export async function reloadSessions(): Promise<void> {
  await refreshSessions();
  if (!state.currentId) return;
  if (state.sessions.some((s) => s.id === state.currentId)) await fetchMindmapById(state.currentId);
  else await leaveDeletedSession();
}

/** The open session is gone: open another, or show that nothing is open. */
export async function leaveDeletedSession(): Promise<void> {
  state.currentId = "";
  state.currentDoc = null;
  render();
  const first = state.sessions.find((s) => !s.archivedAt) ?? state.sessions[0];
  if (first) await selectSession(first.id, { replace: true });
  else history.replaceState(null, "", sessionHash(""));
}

/**
 * View a mindmap file from disk. It isn't one of the server's sessions, so nothing about it goes to
 * the server: the URL names no session, and Sync Git has nothing to act on.
 */
export function openLocalFile(doc: MindmapDocument, fileName: string): void {
  requestFreshView();
  state.localFile = fileName;
  state.currentDoc = doc;
  state.currentId = "";
  state.collapsed = new Set();
  resetSelection();
  history.replaceState(null, "", location.pathname);
  renderSessions();
  render();
}

function applyEvent(event: SessionEvent) {
  state.sessions = state.sessions.filter((s) => s.id !== event.id);
  state.unreadableSessions = state.unreadableSessions.filter((s) => s.id !== event.id);
  if (event.type === "mindmap_updated") {
    state.sessions.push(event.item);
    state.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } else if (event.type === "mindmap_unreadable") {
    state.unreadableSessions.push({ id: event.id, error: event.error });
    state.unreadableSessions.sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** Apply a live event to the session list; the list stays newest first, like the server sends it. */
export function applyToSessions(event: SessionEvent): void {
  if (listsLoading > 0) eventsSinceList.push(event);
  applyEvent(event);
  renderSessions();
}

export async function init(): Promise<void> {
  await refreshSessions();
  if (state.currentId && state.sessions.some((s) => s.id === state.currentId)) {
    await fetchMindmapById(state.currentId);
  } else {
    state.currentId = "";
    // Prefer a session that isn't archived: the Archived group starts collapsed.
    const first = state.sessions.find((s) => !s.archivedAt) ?? state.sessions[0];
    if (first) await selectSession(first.id, { replace: true });
  }
}

const sessionSearch = byId("session-search", HTMLInputElement);
sessionSearch.addEventListener("input", () => {
  state.sessionQuery = sessionSearch.value;
  renderSessions();
});

document.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  // Follow the list as shown: grouped, and skipping collapsed groups.
  const visible = [...document.querySelectorAll<HTMLElement>("#session-list .session-item")].map((el) => el.dataset.sessionId);
  if (visible.length === 0) return;
  e.preventDefault();
  const idx = visible.indexOf(state.currentId);
  const next = e.key === "ArrowDown" ? Math.min(visible.length - 1, idx + 1) : Math.max(0, idx - 1);
  selectSession(visible[next]);
});

setInterval(renderSessions, 30000); // keep "x m ago" and live dots fresh
