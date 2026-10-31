/** Boots the viewer: composes `render()`, wires up the header and toolbar, and follows live events. */

import { isTask, CHANGE_KINDS as KIND_ORDER } from "../src/model/kinds.js";
import { aggregateFiles } from "../src/model/file-stats.js";
import type { MindmapDocument } from "../src/model/schema.js";
import { setViewMode } from "./canvas.js";
import { saveCollapsed } from "./collapse.js";
import { CHANGE_KINDS, fileCountText, toneClass } from "./display.js";
import { byId, errorMessage, serverJson } from "./dom.js";
import { updateMapSearchCount } from "./find.js";
import { VIEW_MODES, finishedBranches } from "./layout.js";
import { isMindmapDocument } from "./local-file.js";
import { applyToSessions, fetchMindmapById, init, leaveDeletedSession, loadMindmap, openLocalFile, refreshSessions, renderSessions, selectSession, type ViewerEvent } from "./sessions.js";
import { renderSidebar } from "./sidebar.js";
import { onRender, render, state } from "./state.js";
import { renderMap } from "./svg-render.js";
import { toast } from "./toast.js";

interface SyncGitResponse {
  synced?: number;
  mindmap?: MindmapDocument;
  error?: string;
}

const APP_TITLE = document.title;

/** Names the open session in the header and on the browser tab. */
function updateSessionName(doc: MindmapDocument | null) {
  const name = byId("session-name");
  name.textContent = doc?.title ?? "";
  name.title = doc?.title ?? "";
  document.title = doc ? `${doc.title} – Synapse` : APP_TITLE;
  const badge = byId("local-badge");
  badge.hidden = !state.localFile;
  badge.title = state.localFile ? `${state.localFile}, opened from disk. It isn't live and isn't in the session list.` : "";
}

function updateHeaderProgress(doc: MindmapDocument | null) {
  const wrap = byId("progress-summary");
  const fill = byId("progress-bar-fill");
  const txt = byId("progress-text");
  const filesTabBtn = byId("tab-files-btn");

  if (!doc) {
    wrap.style.display = "none";
    filesTabBtn.textContent = "Changes (0)";
    return;
  }

  const tasks = Object.values(doc.nodes).filter(isTask);
  const completed = tasks.filter((n) => n.status === "completed");
  const files = [...aggregateFiles(Object.values(doc.nodes)).values()];
  const logged = files.filter((f) => !f.autoDetected).length;
  const changed = files.filter((f) => f.touch.action !== "read");
  const changedAuto = changed.filter((f) => f.autoDetected).length;
  wrap.style.display = "flex";
  const pct = tasks.length > 0 ? Math.round((completed.length / tasks.length) * 100) : 0;
  fill.style.width = `${pct}%`;
  txt.textContent = `${completed.length}/${tasks.length} tasks (${pct}%) · ${fileCountText(logged, files.length)}`;
  filesTabBtn.textContent = `Changes (${changed.length - changedAuto}${changedAuto ? ` +${changedAuto}` : ""})`;
  filesTabBtn.title = `${changed.length - changedAuto} logged by an agent, ${changedAuto} auto-detected`;
}

const syncGitBtn = byId("sync-git-btn", HTMLButtonElement);
const legend = byId("legend");
const foldBtn = byId("fold-btn");

function updateFoldButton(doc: MindmapDocument | null) {
  const anyFolded = state.collapsed.size > 0;
  foldBtn.textContent = anyFolded ? "Unfold" : "Fold done";
  foldBtn.title = anyFolded ? "Unfold every branch" : "Fold the branches whose tasks are all completed";
  foldBtn.toggleAttribute("disabled", !doc || (!anyFolded && finishedBranches(doc).length === 0));
}

foldBtn.onclick = () => {
  const doc = state.currentDoc;
  if (!doc) return;
  state.collapsed = new Set(state.collapsed.size > 0 ? [] : finishedBranches(doc));
  saveCollapsed();
  render();
};

onRender(() => {
  const doc = state.currentDoc;
  document.body.classList.toggle("no-session", !doc);
  syncGitBtn.disabled = !state.currentId;
  legend.dataset.view = state.viewMode;
  updateFoldButton(doc);
  updateSessionName(doc);
  updateHeaderProgress(doc);
  renderSidebar(doc);
  renderMap(doc);
  updateMapSearchCount(doc);
});

document.querySelectorAll<HTMLElement>("#view-switcher button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = VIEW_MODES.find((m) => m === btn.dataset.mode);
    if (mode) setViewMode(mode);
  });
});

byId("legend-kinds").innerHTML = KIND_ORDER.map(
  (k) => `<span class="kind-tally ${toneClass(k)}" title="${CHANGE_KINDS[k].label}">${CHANGE_KINDS[k].glyph} ${k}</span>`,
).join("");

byId("refresh-btn").onclick = async () => {
  await refreshSessions();
  await fetchMindmapById(state.currentId);
};

syncGitBtn.onclick = async () => {
  syncGitBtn.disabled = true;
  try {
    const res = await fetch("/api/sync-git", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mindmapId: state.currentId }),
    });
    const data = serverJson<SyncGitResponse>(await res.text());
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (data.mindmap) loadMindmap(data.mindmap);
    const synced = data.synced ?? 0;
    toast(synced > 0 ? `Synced ${synced} changed file${synced === 1 ? "" : "s"} from git` : "Working tree clean (0 uncommitted changes)");
  } catch (err) {
    toast(`Git sync failed: ${errorMessage(err)}`, { error: true });
  }
  syncGitBtn.disabled = !state.currentId;
};

// File upload
const fileUpload = byId("file-upload", HTMLInputElement);
byId("upload-btn").onclick = () => {
  fileUpload.click();
};
fileUpload.onchange = async () => {
  const file = fileUpload.files?.[0];
  if (!file) return;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    if (isMindmapDocument(parsed)) openLocalFile(parsed, file.name);
    else toast(`${file.name} isn't a Synapse mindmap`, { error: true });
  } catch (err) {
    toast(`Invalid JSON: ${errorMessage(err)}`, { error: true });
  }
  fileUpload.value = "";
};

// ── Live Server-Sent Events (SSE) Connection ────────────────────
function connectSSE() {
  const indicator = byId("live-indicator");
  const liveText = byId("live-text");
  const es = new EventSource("/events");

  es.onopen = () => {
    indicator.classList.remove("offline");
    liveText.textContent = "Live";
  };

  // The first "connected" is covered by init(); a later one means events may have been missed.
  let reconnecting = false;

  es.onmessage = async (event) => {
    try {
      const payload = serverJson<ViewerEvent>(event.data);
      if (payload.type === "connected") {
        if (reconnecting) {
          await refreshSessions();
          await fetchMindmapById(state.currentId);
        }
        reconnecting = true;
        return;
      }
      applyToSessions(payload);
      if (payload.type === "mindmap_deleted" && payload.id === state.currentId) await leaveDeletedSession();
      // Only reload the canvas for the session being viewed; a file that can't be read isn't opened.
      if (payload.type !== "mindmap_updated") return;
      if (!state.currentId && !state.localFile) await selectSession(payload.id, { replace: true });
      else if (payload.id === state.currentId) await fetchMindmapById(state.currentId);
    } catch {
      // ignore malformed event
    }
  };

  es.onerror = () => {
    indicator.classList.add("offline");
    liveText.textContent = "Reconnecting…";
  };
}

init();
connectSSE();
