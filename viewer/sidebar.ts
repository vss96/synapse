/** The right-hand panel: the Inspector, Changes and Activity tabs. */

import { isChangeKind, isTask } from "../src/model/kinds.js";
import { aggregateFiles, touchChanges } from "../src/model/file-stats.js";
import type { CodeChange, FileTouch, MindmapDocument } from "../src/model/schema.js";
import { revealHighlighted, showNode } from "./canvas.js";
import { CHANGE_KINDS, TYPE_BADGES, kindOf, nodeChanges, tallyChanges, tallyHtml, toneClass } from "./display.js";
import { byId, escXml } from "./dom.js";
import { ROOT } from "./layout.js";
import { SIDEBAR_TABS, nodeById, render, state } from "./state.js";
import { dayLabel } from "./time.js";

/** A change as shown in the sidebar; `via` lists the nodes that logged it. */
type DisplayChange = CodeChange & { via?: string[] };

function changeRowHtml(c: CodeChange, via?: string) {
  const k = kindOf(c);
  const name = c.kind === "rename" ? `${c.previousSymbol} → ${c.symbol}` : c.symbol;
  return `
    <div class="change-row ${toneClass(k)}">
      <span class="kind-badge">${CHANGE_KINDS[k].glyph} ${escXml(c.kind)}</span>
      <span><code>${escXml(name)}</code>${c.detail ? ` <span class="change-detail">— ${escXml(c.detail)}</span>` : ""}${via ? ` <span class="change-detail">(${escXml(via)})</span>` : ""}</span>
    </div>`;
}

function filePathHtml(f: FileTouch) {
  const from = f.action === "rename" ? `${escXml(f.previousPath)} → ` : "";
  return `${from}${escXml(f.path)}${f.lines ? `:${escXml(f.lines)}` : ""}`;
}

function fileItemHtml(
  f: FileTouch,
  { changes = touchChanges(f), meta = "" }: { changes?: readonly DisplayChange[]; meta?: string } = {}
) {
  const action = f.action;
  return `
    <div class="file-item ${state.highlightedFilePath === f.path ? "active-highlight" : ""}" data-file-path="${escXml(f.path)}">
      <div class="file-header">
        <span class="action-badge ${toneClass(action)}">${escXml(action)}</span>
        <span>${filePathHtml(f)}</span>
      </div>
      ${f.summary ? `<div class="file-summary">${escXml(f.summary)}</div>` : ""}
      ${changes.length ? `<div class="change-list">${changes.map((c) => changeRowHtml(c, c.via && c.via.join(", "))).join("")}</div>` : ""}
      ${!changes.length && f.symbols && f.symbols.length ? `<div class="file-meta">Symbols: <code>${escXml(f.symbols.join(", "))}</code></div>` : ""}
      ${meta}
    </div>`;
}

export function renderSidebar(doc: MindmapDocument | null) {
  const container = byId("sidebar-content");
  if (!doc) {
    container.innerHTML = `<div style="color:var(--muted);font-size:13px;">Load or create a mindmap to inspect plan tasks, HLD concepts, and touched code.</div>`;
    return;
  }

  if (state.activeTab === "inspector") {
    const node = nodeById(doc, state.selectedNodeId) ?? doc.nodes[ROOT];
    if (!node) return;
    const files = node.files;

    const relatedLinks = doc.links.filter(
      (l) => l.from === node.id || l.to === node.id
    );

    let linksHtml = "";
    if (relatedLinks.length > 0) {
      linksHtml = `
        <div class="section-title">Concept & Data Flow Links (${relatedLinks.length})</div>
        ${relatedLinks
          .map((l) => {
            const isOut = l.from === node.id;
            const otherId = isOut ? l.to : l.from;
            const otherLabel = doc.nodes[otherId]?.label || otherId;
            return `
              <div class="link-item" data-jump-node="${escXml(otherId)}">
                <div><b>${isOut ? "──[" + escXml(l.label) + "]──▶" : "◀──[" + escXml(l.label) + "]──"}</b> ${escXml(otherLabel)}</div>
                ${l.notes ? `<div style="font-size:11px;color:var(--muted);margin-top:3px;">${escXml(l.notes)}</div>` : ""}
              </div>
            `;
          })
          .join("")}
      `;
    }

    const filesHtml =
      files.length === 0
        ? `<div style="color:var(--muted);font-size:12px;">No files logged on this node yet.</div>`
        : files.map((f) => fileItemHtml(f)).join("");
    const nodeTally = tallyHtml(nodeChanges(node));

    container.innerHTML = `
      <div class="inspector-card">
        <div class="inspector-title">${escXml(node.label)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;">
          <span class="type-tag ${toneClass(node.type)}">${escXml(TYPE_BADGES[node.type] || node.type)}</span>
          ${isTask(node) ? `<span class="status-tag ${toneClass(node.status)}">${escXml(node.status.replace("_", " "))}</span>` : ""}
          <span style="font-size:11px;color:var(--muted);">ID: <code>${escXml(node.id)}</code></span>
        </div>
      </div>

      ${
        node.notes
          ? `<div class="section-title">Agent Thinking / Notes</div>
             <div class="notes-box">${escXml(node.notes)}</div>`
          : ""
      }

      ${linksHtml}

      <div class="section-title">Files & Changes on Node (${files.length}) ${nodeTally}</div>
      ${filesHtml}
    `;

  } else if (state.activeTab === "files") {
    const fileMap = aggregateFiles(Object.values(doc.nodes));
    if (fileMap.size === 0) {
      container.innerHTML = `<div style="color:var(--muted);font-size:12.5px;">No files have been logged yet. Use <code>log_file_touch</code> or click <b>⎇ Sync Git</b>.</div>`;
      return;
    }

    const all = [...fileMap.values()].sort((a, b) => b.touch.timestamp.localeCompare(a.touch.timestamp));
    const changed = all.filter((f) => f.touch.action !== "read");
    const readOnly = all.filter((f) => f.touch.action === "read");
    const allChanges = changed.flatMap((f) => f.changes);

    const filterChips = [
      `<button class="kind-filter ${state.changeKindFilter ? "" : "active"}" data-kind="">All ${allChanges.length}</button>`,
      ...tallyChanges(allChanges).map(
        ([k, n]) =>
          `<button class="kind-filter toned ${toneClass(k)} ${state.changeKindFilter === k ? "active" : ""}" data-kind="${k}">${CHANGE_KINDS[k].glyph} ${CHANGE_KINDS[k].label} ${n}</button>`
      ),
    ].join("");

    const visible = state.changeKindFilter
      ? changed
          .map((f) => ({ f, changes: f.changes.filter((c) => kindOf(c) === state.changeKindFilter) }))
          .filter((x) => x.changes.length > 0)
      : changed.map((f) => ({ f, changes: f.changes }));

    const changedHtml = visible.length
      ? visible
          .map(({ f, changes }) =>
            fileItemHtml(f.touch, {
              changes,
              meta: `<div class="file-meta">via ${f.nodes.map((n) => `<b>${escXml(n.label)}</b>`).join(", ")}</div>`,
            })
          )
          .join("")
      : `<div style="color:var(--muted);font-size:12px;">No matching changes.</div>`;

    const readHtml = readOnly
      .map(
        ({ touch }) => `
        <div class="file-item read-only ${state.highlightedFilePath === touch.path ? "active-highlight" : ""}" data-file-path="${escXml(touch.path)}">
          <div class="file-header"><span class="action-badge read">read</span><span>${filePathHtml(touch)}</span></div>
        </div>`
      )
      .join("");

    container.innerHTML = `
      ${allChanges.length ? `<div class="kind-filters">${filterChips}</div>` : ""}
      <div class="section-title">Changed Files (${changed.length}) · newest first</div>
      ${changedHtml}
      ${readOnly.length && !state.changeKindFilter ? `<div class="section-title">Read for Context (${readOnly.length})</div>${readHtml}` : ""}
    `;

    container.querySelectorAll<HTMLElement>(".kind-filter").forEach((el) => {
      el.addEventListener("click", () => {
        const kind = el.dataset.kind;
        state.changeKindFilter = kind && isChangeKind(kind) ? kind : null;
        render();
        if (state.changeKindFilter) revealHighlighted();
      });
    });
  } else if (state.activeTab === "activity") {
    const log = doc.activityLog;
    if (log.length === 0) {
      container.innerHTML = `<div style="color:var(--muted);font-size:12.5px;">No activity recorded yet.</div>`;
      return;
    }
    // Newest first, under a heading for each day. Entries about a node that still exists jump to it.
    let day = "";
    container.innerHTML = log
      .map((entry) => {
        const label = dayLabel(entry.timestamp);
        const heading = label === day ? "" : `<div class="section-title">${escXml(label)}</div>`;
        day = label;
        const time = new Date(entry.timestamp);
        const body = `
          <div class="activity-time" title="${escXml(time.toLocaleString())}">${escXml(time.toLocaleTimeString())}</div>
          <div>${escXml(entry.message)}</div>`;
        const node = entry.nodeId ? nodeById(doc, entry.nodeId) : undefined;
        return node
          ? `${heading}<button class="activity-item ${node.id === state.selectedNodeId ? "active" : ""}" data-jump-node="${escXml(node.id)}" title="Show “${escXml(node.label)}” on the map">${body}</button>`
          : `${heading}<div class="activity-item">${body}</div>`;
      })
      .join("");
  }

  container.querySelectorAll<HTMLElement>("[data-jump-node]").forEach((el) => {
    el.addEventListener("click", () => showNode(el.dataset.jumpNode ?? ROOT));
  });
  container.querySelectorAll<HTMLElement>(".file-item").forEach((el) => {
    el.addEventListener("click", () => {
      const fp = el.dataset.filePath ?? null;
      state.highlightedFilePath = state.highlightedFilePath === fp ? null : fp;
      render();
      if (state.highlightedFilePath) revealHighlighted();
    });
  });
}

export function updateTabUI() {
  document.querySelectorAll<HTMLElement>(".sidebar-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === state.activeTab);
  });
}

document.querySelectorAll<HTMLElement>(".sidebar-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = SIDEBAR_TABS.find((t) => t === btn.dataset.tab);
    if (!tab) return;
    state.activeTab = tab;
    if (state.activeTab !== "files") state.changeKindFilter = null;
    updateTabUI();
    render();
  });
});
