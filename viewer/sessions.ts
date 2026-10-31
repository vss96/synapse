/** The left-hand session list, and opening sessions. */

import type { MindmapDocument, MindmapList, MindmapListItem } from "../src/model/schema.js";
import { requestFreshView } from "./canvas.js";
import { byId, errorMessage, escXml, serverJson } from "./dom.js";
import { ROOT } from "./layout.js";
import { ARCHIVED_GROUP, groupSessions, worktreeName } from "./session-groups.js";
import { sessionHash, sessionIdFromHash } from "./session-link.js";
import { nodeById, render, state } from "./state.js";

/** A change the server pushes to every open page. */
export type ViewerEvent =
  | { type: "connected" }
  | { type: "mindmap_updated"; id: string; item: MindmapListItem }
  | { type: "mindmap_deleted"; id: string }
  | { type: "mindmap_unreadable"; id: string; error: string };

export function loadMindmap(doc: MindmapDocument) {
  if (doc.id !== state.currentDoc?.id) requestFreshView();
  state.currentDoc = doc;
  state.currentId = doc.id;
  if (!nodeById(doc, state.selectedNodeId)) state.selectedNodeId = ROOT;
  render();
}

export async function fetchMindmapById(id: string) {
  if (!id) return;
  const res = await fetch(`/api/mindmaps/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.ok) {
    const doc = serverJson<MindmapDocument>(await res.text());
    if (id === state.currentId) loadMindmap(doc); // ignore responses for a session we already switched away from
  }
}

const LIVE_WINDOW_MS = 2 * 60 * 1000;

function timeAgo(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (!iso || Number.isNaN(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function filteredSessions() {
  const q = state.sessionQuery.trim().toLowerCase();
  if (!q) return state.sessions;
  return state.sessions.filter((s) => `${s.title} ${s.workspacePath || ""} ${s.activeTask || ""}`.toLowerCase().includes(q));
}

const COLLAPSED_GROUPS_KEY = "synapse.collapsedGroups";

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

function sessionItemHtml(s: MindmapListItem) {
  const pct = s.totalTasks > 0 ? Math.round((s.completedTasks / s.totalTasks) * 100) : 0;
  const live = Date.now() - new Date(s.updatedAt).getTime() < LIVE_WINDOW_MS;
  const action = s.archivedAt ? "restore" : "archive";
  const worktree = worktreeName(s);
  return `
    <div class="session-item ${s.id === state.currentId ? "active" : ""}" data-session-id="${escXml(s.id)}" title="${escXml(s.title)}${s.workspacePath ? `\n${escXml(s.workspacePath)}` : ""}">
      <div class="session-title">${live ? `<span class="session-live-dot" title="Updated in the last 2 minutes"></span>` : ""}<span class="session-title-text">${escXml(s.title)}</span></div>
      <div class="session-sub">${escXml(timeAgo(s.updatedAt))}${worktree ? `<span class="session-worktree">· ${escXml(worktree)}</span>` : ""}
        <button class="session-action" data-action="${action}" title="${s.archivedAt ? "Restore this session" : "Archive this session"}">${s.archivedAt ? "Restore" : "Archive"}</button>
      </div>
      ${s.activeTask ? `<div class="session-task">◐ ${escXml(s.activeTask)}</div>` : ""}
      <div class="session-progress">
        <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        <span>${s.completedTasks}/${s.totalTasks} tasks · ${s.fileCount} files</span>
      </div>
    </div>`;
}

async function setArchived(id: string, archived: boolean) {
  try {
    const res = await fetch("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mindmapId: id, archived }),
    });
    if (!res.ok) throw new Error(serverJson<{ error?: string }>(await res.text()).error ?? `HTTP ${res.status}`);
  } catch (err) {
    alert(`Could not ${archived ? "archive" : "restore"} the session: ${errorMessage(err)}`);
  }
  await refreshSessions();
}

export function renderSessions() {
  const list = byId("session-list");
  const visible = filteredSessions();
  const archivedCount = state.sessions.filter((s) => s.archivedAt).length;
  byId("sessions-count").textContent = `Sessions (${state.sessions.length - archivedCount})`;

  const unreadable = byId("sessions-unreadable");
  unreadable.hidden = state.unreadableSessions.length === 0;
  unreadable.innerHTML = `
    <div class="sessions-unreadable-head">⚠ Can't read ${state.unreadableSessions.length} session${state.unreadableSessions.length === 1 ? "" : "s"}</div>
    ${state.unreadableSessions.map((s) => `<div class="sessions-unreadable-item"><code>${escXml(s.id)}</code> ${escXml(s.error)}</div>`).join("")}`;

  if (visible.length === 0) {
    list.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px;">${state.sessions.length ? "No matching sessions." : "No sessions yet."}</div>`;
    return;
  }

  // While filtering, show every match rather than hiding some in collapsed groups.
  const filtering = state.sessionQuery.trim() !== "";
  list.innerHTML = groupSessions(visible)
    .map((g) => {
      const collapsed = !filtering && collapsedGroups.has(g.key);
      return `
        <div class="session-group ${g.key === ARCHIVED_GROUP ? "archived" : ""}">
          <button class="session-group-head" data-group="${escXml(g.key)}" title="${escXml(g.hint)}" aria-expanded="${!collapsed}">
            <span class="session-group-chevron">${collapsed ? "▸" : "▾"}</span>
            <span class="session-group-name">${escXml(g.name)}</span>
            <span class="session-group-count">${g.items.length}</span>
          </button>
          ${collapsed ? "" : g.items.map(sessionItemHtml).join("")}
        </div>`;
    })
    .join("");

  list.querySelectorAll<HTMLElement>(".session-group-head").forEach((el) => {
    el.addEventListener("click", () => toggleGroup(el.dataset.group ?? ""));
  });
  list.querySelectorAll<HTMLElement>(".session-item").forEach((el) => {
    el.addEventListener("click", () => selectSession(el.dataset.sessionId));
  });
  list.querySelectorAll<HTMLElement>(".session-action").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.closest<HTMLElement>(".session-item")?.dataset.sessionId;
      if (id) setArchived(id, el.dataset.action === "archive");
    });
  });
}

/** Switch to a session, leaving the URL as it is. */
async function showSession(id: string) {
  state.currentId = id;
  state.selectedNodeId = ROOT;
  state.highlightedFilePath = null;
  state.changeKindFilter = null;
  document.body.classList.remove("sessions-open");
  renderSessions();
  document.querySelector(".session-item.active")?.scrollIntoView({ block: "nearest" });
  await fetchMindmapById(id);
}

/**
 * Open a session. Switching adds a history entry, so Back returns to the session you left. With
 * `replace`, for a session nobody picked, it doesn't, so Back leaves the viewer instead of landing
 * on a URL with no session in it.
 */
export async function selectSession(id: string | undefined, { replace = false } = {}) {
  if (!id || id === state.currentId) return;
  if (replace) history.replaceState(null, "", sessionHash(id));
  else history.pushState(null, "", sessionHash(id));
  await showSession(id);
}

/**
 * Switch to the session the URL names (Back, Forward or a pasted link). If there is no such
 * session, put back the URL of the open one.
 */
function followUrl() {
  const id = sessionIdFromHash(location.hash);
  if (id === state.currentId) return;
  if (state.sessions.some((s) => s.id === id)) showSession(id);
  else history.replaceState(null, "", sessionHash(state.currentId));
}

// Back and Forward fire both; a pasted link fires hashchange.
window.addEventListener("popstate", followUrl);
window.addEventListener("hashchange", followUrl);

export async function refreshSessions() {
  try {
    const res = await fetch("/api/mindmaps", { cache: "no-store" });
    if (!res.ok) return;
    const list = serverJson<MindmapList>(await res.text());
    state.sessions = list.mindmaps;
    state.unreadableSessions = list.unreadable;
    renderSessions();
  } catch {
    // Viewer opened without the API server; sessions list stays empty
  }
}

/** Apply a live event to the session list; the list stays newest first, like the server sends it. */
export function applyToSessions(event: Exclude<ViewerEvent, { type: "connected" }>) {
  state.sessions = state.sessions.filter((s) => s.id !== event.id);
  state.unreadableSessions = state.unreadableSessions.filter((s) => s.id !== event.id);
  if (event.type === "mindmap_updated") {
    state.sessions.push(event.item);
    state.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } else if (event.type === "mindmap_unreadable") {
    state.unreadableSessions.push({ id: event.id, error: event.error });
    state.unreadableSessions.sort((a, b) => a.id.localeCompare(b.id));
  }
  renderSessions();
}

export async function init() {
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

// Wide screens dock the sessions list (remembered); narrow ones show it as a drawer over the canvas.
const narrowScreen = matchMedia("(max-width: 900px)");
if (localStorage.getItem("synapse.sessionsCollapsed") === "1") document.body.classList.add("sessions-collapsed");
byId("sessions-toggle").onclick = () => {
  if (narrowScreen.matches) {
    document.body.classList.toggle("sessions-open");
    return;
  }
  const collapsed = document.body.classList.toggle("sessions-collapsed");
  localStorage.setItem("synapse.sessionsCollapsed", collapsed ? "1" : "0");
};

setInterval(renderSessions, 30000); // keep "x m ago" and live dots fresh
