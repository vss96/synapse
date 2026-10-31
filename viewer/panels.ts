/** The panels around the canvas: showing and hiding the session list, the sidebar and the legend. */

import { byId } from "./dom.js";
import { render, state } from "./state.js";

const SESSIONS_KEY = "synapse.sessionsCollapsed";
const SIDEBAR_KEY = "synapse.sidebarCollapsed";
const LEGEND_KEY = "synapse.legendClosed";

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: every panel starts in its default state
  }
}

function remember(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Storage blocked or full: the panel still toggles, it just isn't remembered.
  }
}

// Wide screens dock the sessions list (remembered); narrow ones show it as a drawer over the canvas.
const narrowScreen = matchMedia("(max-width: 900px)");
const sessionsToggle = byId("sessions-toggle");
const sidebarToggle = byId("sidebar-toggle");
const legendToggle = byId("legend-toggle");

function syncSessionsToggle() {
  const shown = narrowScreen.matches ? document.body.classList.contains("sessions-open") : !document.body.classList.contains("sessions-collapsed");
  sessionsToggle.setAttribute("aria-expanded", String(shown));
}

export function closeDrawer(): void {
  document.body.classList.remove("sessions-open");
  syncSessionsToggle();
}

if (remembered(SESSIONS_KEY) === "1") document.body.classList.add("sessions-collapsed");
syncSessionsToggle();
narrowScreen.addEventListener("change", syncSessionsToggle);

sessionsToggle.onclick = () => {
  if (narrowScreen.matches) document.body.classList.toggle("sessions-open");
  else remember(SESSIONS_KEY, document.body.classList.toggle("sessions-collapsed"));
  syncSessionsToggle();
};
byId("drawer-backdrop").onclick = closeDrawer;

function setSidebarOpen(open: boolean) {
  document.body.classList.toggle("sidebar-collapsed", !open);
  sidebarToggle.setAttribute("aria-expanded", String(open));
  remember(SIDEBAR_KEY, !open);
}

/** Show the sidebar, for a card that was just picked. */
export function openSidebar(): void {
  if (document.body.classList.contains("sidebar-collapsed")) setSidebarOpen(true);
}

const toggleSidebar = () => setSidebarOpen(document.body.classList.contains("sidebar-collapsed"));

function setLegendOpen(open: boolean) {
  document.body.classList.toggle("legend-closed", !open);
  legendToggle.setAttribute("aria-expanded", String(open));
}

if (remembered(SIDEBAR_KEY) === "1") setSidebarOpen(false);
sidebarToggle.onclick = toggleSidebar;

// There's no room to leave the legend open beside a narrow canvas, so it starts closed there.
const legendSaved = remembered(LEGEND_KEY);
setLegendOpen(legendSaved === null ? !narrowScreen.matches : legendSaved === "0");
legendToggle.onclick = () => {
  const open = document.body.classList.contains("legend-closed");
  setLegendOpen(open);
  remember(LEGEND_KEY, !open);
};

document.addEventListener("keydown", (e) => {
  const t = e.target;
  const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
  if (e.key === "]" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    toggleSidebar();
  } else if (e.key === "Escape" && document.body.classList.contains("sessions-open")) {
    closeDrawer();
    sessionsToggle.focus();
  } else if (e.key === "Escape" && !typing && (state.highlightedFilePath || state.changeKindFilter)) {
    state.highlightedFilePath = null;
    state.changeKindFilter = null;
    render();
  }
});
