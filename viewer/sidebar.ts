/** The right-hand panel: the Inspector, Changes and Activity tabs. */

import { aggregateFiles, isAutoDetected, touchChanges, type AggregatedFile } from "../src/model/file-stats.js";
import { isChangeKind, isTask } from "../src/model/kinds.js";
import type { CodeChange, FileTouch, MindmapDocument, MindmapNode } from "../src/model/schema.js";
import { revealHighlighted, showNode } from "./canvas.js";
import { CHANGE_KINDS, TYPE_BADGES, kindOf, nodeChanges, tallyChanges, tallyHtml, toneClass } from "./display.js";
import { byId, errorMessage, escXml, setHtml, truncate } from "./dom.js";
import { ROOT, ancestors, subtree } from "./layout.js";
import { matchingFile } from "./search.js";
import { FILE_PAGE, SIDEBAR_TABS, nodeById, render, resetFileList, state } from "./state.js";
import { dayLabel } from "./time.js";
import { toast } from "./toast.js";

/** A change as shown in the sidebar; `via` lists the nodes that logged it. */
type DisplayChange = CodeChange & { via?: string[] };

/** Lists at least this long get a path filter. */
const FILTER_MIN_FILES = 10;

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

interface FileItemOptions {
  changes?: readonly DisplayChange[];
  meta?: string;
  /** Just the header row, for long lists of reads. */
  compact?: boolean;
  /** This file is why the card matches the find box. */
  findHit?: boolean;
}

function fileItemHtml(f: FileTouch, { changes = touchChanges(f), meta = "", compact = false, findHit = false }: FileItemOptions = {}) {
  const highlighted = state.highlightedFilePath === f.path;
  const classes = ["file-item", compact ? "read-only" : "", highlighted || findHit ? "active-highlight" : "", findHit ? "find-hit" : ""];
  const details = compact
    ? ""
    : `${f.summary ? `<div class="file-summary">${escXml(f.summary)}</div>` : ""}
      ${changes.length ? `<div class="change-list">${changes.map((c) => changeRowHtml(c, c.via && c.via.join(", "))).join("")}</div>` : ""}
      ${!changes.length && f.symbols && f.symbols.length ? `<div class="file-meta">Symbols: <code>${escXml(f.symbols.join(", "))}</code></div>` : ""}
      ${meta}`;
  return `
    <div class="${classes.join(" ")}" data-file-path="${escXml(f.path)}">
      <div class="file-header">
        <span class="action-badge ${toneClass(f.action)}">${escXml(f.action)}</span>
        <button class="file-path" data-focus="file:${escXml(f.path)}" aria-pressed="${highlighted}" title="Highlight the cards that touched this file">${filePathHtml(f)}</button>
      </div>
      ${details}
    </div>`;
}

/** One row of a file list. The HTML is only built for rows that are shown: a session can have thousands. */
interface FileRow {
  path: string;
  autoDetected: boolean;
  html: () => string;
}

/** The rows the path filter leaves. */
function filteredRows(rows: readonly FileRow[]): readonly FileRow[] {
  const q = state.fileQuery.trim().toLowerCase();
  return q ? rows.filter((r) => r.path.toLowerCase().includes(q)) : rows;
}

/**
 * A file list: logged files, then auto-detected ones behind a count, cut into pages, so the files an
 * agent meant to log stay findable in a session with thousands. A row someone asked for always shows.
 */
function fileListHtml(rows: readonly FileRow[], findHit?: string): string {
  const found = filteredRows(rows);
  const logged = found.filter((r) => !r.autoDetected);
  const auto = found.filter((r) => r.autoDetected);
  const wanted = (r: FileRow) => r.path === findHit || r.path === state.highlightedFilePath;
  const autoOpen = state.showAutoFiles || state.fileQuery.trim() !== "" || auto.some(wanted);
  const listed = autoOpen ? [...logged, ...auto] : logged;
  const limit = listed.reduce((max, r, i) => (wanted(r) ? Math.max(max, i + 1) : max), state.fileLimit);

  const shownLogged = logged.slice(0, limit);
  const shownAuto = autoOpen ? auto.slice(0, Math.max(0, limit - shownLogged.length)) : [];
  const toggle = auto.length
    ? `<button class="file-group-toggle" data-toggle-auto data-focus="toggle-auto" aria-expanded="${autoOpen}">${autoOpen ? "▾" : "▸"} Auto-detected files (${auto.length})</button>`
    : "";
  const more = listed.length - shownLogged.length - shownAuto.length;
  const moreButton = more > 0 ? `<button class="file-more secondary" data-show-more data-focus="show-more">Show ${Math.min(more, FILE_PAGE)} more (${more} left)</button>` : "";
  return `${shownLogged.map((r) => r.html()).join("")}${toggle}${shownAuto.map((r) => r.html()).join("")}${moreButton}`;
}

function fileFilterHtml(count: number): string {
  if (count < FILTER_MIN_FILES && !state.fileQuery) return "";
  return `<input id="file-filter" class="file-filter" data-focus="file-filter" type="search" placeholder="Filter files by path…" aria-label="Filter files by path" value="${escXml(state.fileQuery)}" autocomplete="off" spellcheck="false">`;
}

function noFilesFound(): string {
  return `<div style="color:var(--muted);font-size:12px;">No files match “${escXml(state.fileQuery.trim())}”.</div>`;
}

function breadcrumbHtml(doc: MindmapDocument, node: MindmapNode): string {
  const parents = ancestors(doc, node);
  if (parents.length === 0) return "";
  const crumbs = parents.map((n) => `<button class="crumb" data-jump-node="${escXml(n.id)}" data-focus="crumb:${escXml(n.id)}" title="${escXml(n.label)}">${escXml(truncate(n.label, 26))}</button>`);
  return `<nav class="breadcrumb" aria-label="Parent nodes">${crumbs.join(`<span aria-hidden="true">›</span>`)}</nav>`;
}

/** The node's children, and what their whole branch adds up to. */
function childrenHtml(doc: MindmapDocument, node: MindmapNode): string {
  const children = node.children.flatMap((id) => doc.nodes[id] ?? []);
  if (children.length === 0) return "";
  const below = subtree(doc, node).filter((n) => n.id !== node.id);
  const tasks = below.filter(isTask);
  const done = tasks.filter((n) => n.status === "completed").length;
  const progress = tasks.length ? ` · ${done}/${tasks.length} tasks done` : "";
  const rows = children.map((child) => {
    const status = isTask(child) ? `<span class="status-tag ${toneClass(child.status)}">${escXml(child.status.replace("_", " "))}</span>` : `<span class="type-tag ${toneClass(child.type)}">${escXml(child.type.replace("_", " "))}</span>`;
    return `<button class="link-item child-item" data-jump-node="${escXml(child.id)}" data-focus="child:${escXml(child.id)}">${status} <span>${escXml(child.label)}</span></button>`;
  });
  return `
    <div class="section-title">Child Nodes (${children.length})${progress} ${tallyHtml(below.flatMap(nodeChanges))}</div>
    ${rows.join("")}`;
}

function linksHtml(doc: MindmapDocument, node: MindmapNode): string {
  const related = doc.links.filter((l) => l.from === node.id || l.to === node.id);
  if (related.length === 0) return "";
  return `
    <div class="section-title">Concept & Data Flow Links (${related.length})</div>
    ${related
      .map((l) => {
        const isOut = l.from === node.id;
        const otherId = isOut ? l.to : l.from;
        const otherLabel = doc.nodes[otherId]?.label || otherId;
        return `
          <button class="link-item" data-jump-node="${escXml(otherId)}" data-focus="link:${escXml(l.id)}">
            <span class="link-item-line"><b>${isOut ? "──[" + escXml(l.label) + "]──▶" : "◀──[" + escXml(l.label) + "]──"}</b> ${escXml(otherLabel)}</span>
            ${l.notes ? `<span class="link-item-notes">${escXml(l.notes)}</span>` : ""}
          </button>
        `;
      })
      .join("")}
  `;
}

function inspectorHtml(doc: MindmapDocument, node: MindmapNode): string {
  const findHit = matchingFile(node, state.mapQuery);
  const rows = node.files.map((f): FileRow => ({ path: f.path, autoDetected: isAutoDetected(f), html: () => fileItemHtml(f, { findHit: f.path === findHit }) }));
  const filesHtml =
    node.files.length === 0
      ? `<div style="color:var(--muted);font-size:12px;">No files logged on this node yet.</div>`
      : filteredRows(rows).length === 0
        ? noFilesFound()
        : fileListHtml(rows, findHit);

  return `
    ${breadcrumbHtml(doc, node)}
    <div class="inspector-card">
      <div class="inspector-title">${escXml(node.label)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;">
        <span class="type-tag ${toneClass(node.type)}">${escXml(TYPE_BADGES[node.type] || node.type)}</span>
        ${isTask(node) ? `<span class="status-tag ${toneClass(node.status)}">${escXml(node.status.replace("_", " "))}</span>` : ""}
        <button class="copy-id" data-copy="${escXml(node.id)}" data-focus="copy-id" title="Copy this ID, to point an agent at the node">ID: <code>${escXml(node.id)}</code> ⧉</button>
      </div>
    </div>

    ${
      node.notes
        ? `<div class="section-title">Agent Thinking / Notes</div>
           <div class="notes-box">${escXml(node.notes)}</div>`
        : ""
    }

    ${childrenHtml(doc, node)}

    ${linksHtml(doc, node)}

    <div class="section-title">Files & Changes on Node (${node.files.length}) ${tallyHtml(nodeChanges(node))}</div>
    ${fileFilterHtml(node.files.length)}
    ${filesHtml}
  `;
}

function changesHtml(doc: MindmapDocument): string {
  const fileMap = aggregateFiles(Object.values(doc.nodes));
  if (fileMap.size === 0) {
    return `<div style="color:var(--muted);font-size:12.5px;">No files have been logged yet. Use <code>log_file_touch</code> or click <b>⎇ Sync Git</b>.</div>`;
  }

  const all = [...fileMap.values()].sort((a, b) => b.touch.timestamp.localeCompare(a.touch.timestamp));
  const changed = all.filter((f) => f.touch.action !== "read");
  const readOnly = all.filter((f) => f.touch.action === "read");
  const allChanges = changed.flatMap((f) => f.changes);

  const filterChips = [
    `<button class="kind-filter ${state.changeKindFilter ? "" : "active"}" data-kind="" data-focus="kind:" aria-pressed="${!state.changeKindFilter}">All ${allChanges.length}</button>`,
    ...tallyChanges(allChanges).map(
      ([k, n]) =>
        `<button class="kind-filter toned ${toneClass(k)} ${state.changeKindFilter === k ? "active" : ""}" data-kind="${k}" data-focus="kind:${k}" aria-pressed="${state.changeKindFilter === k}">${CHANGE_KINDS[k].glyph} ${CHANGE_KINDS[k].label} ${n}</button>`
    ),
  ].join("");

  const visible = state.changeKindFilter
    ? changed
        .map((f) => ({ f, changes: f.changes.filter((c) => kindOf(c) === state.changeKindFilter) }))
        .filter((x) => x.changes.length > 0)
    : changed.map((f) => ({ f, changes: f.changes }));

  const changeRows = visible.map(({ f, changes }): FileRow => ({
    path: f.touch.path,
    autoDetected: f.autoDetected,
    html: () =>
      fileItemHtml(f.touch, {
        changes,
        meta: `<div class="file-meta">via ${f.nodes.map((n) => `<b>${escXml(n.label)}</b>`).join(", ")}</div>`,
      }),
  }));
  const readRows = readOnly.map((f: AggregatedFile): FileRow => ({ path: f.touch.path, autoDetected: false, html: () => fileItemHtml(f.touch, { compact: true }) }));
  const changedHtml = filteredRows(changeRows).length ? fileListHtml(changeRows) : `<div style="color:var(--muted);font-size:12px;">No matching changes.</div>`;
  const showReads = filteredRows(readRows).length > 0 && !state.changeKindFilter;

  return `
    ${allChanges.length ? `<div class="kind-filters">${filterChips}</div>` : ""}
    ${fileFilterHtml(all.length)}
    <div class="section-title">Changed Files (${filteredRows(changeRows).length}) · newest first</div>
    ${changedHtml}
    ${showReads ? `<div class="section-title">Read for Context (${filteredRows(readRows).length})</div>${fileListHtml(readRows)}` : ""}
  `;
}

function activityHtml(doc: MindmapDocument): string {
  const log = doc.activityLog;
  if (log.length === 0) return `<div style="color:var(--muted);font-size:12.5px;">No activity recorded yet.</div>`;
  // Newest first, under a heading for each day. Entries about a node that still exists jump to it.
  let day = "";
  return log
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

const content = byId("sidebar-content");

export function renderSidebar(doc: MindmapDocument | null) {
  if (!doc) {
    content.innerHTML = `<div style="color:var(--muted);font-size:13px;">Load or create a mindmap to inspect plan tasks, HLD concepts, and touched code.</div>`;
    return;
  }
  if (state.activeTab === "inspector") {
    const node = nodeById(doc, state.selectedNodeId) ?? doc.nodes[ROOT];
    if (node) setHtml(content, inspectorHtml(doc, node));
  } else if (state.activeTab === "files") {
    setHtml(content, changesHtml(doc));
  } else {
    setHtml(content, activityHtml(doc));
  }
}

async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    toast(`Copied ${id}`);
  } catch (err) {
    toast(`Could not copy the ID: ${errorMessage(err)}`, { error: true });
  }
}

content.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const el = e.target.closest<HTMLElement>("[data-jump-node], [data-copy], [data-kind], [data-toggle-auto], [data-show-more], .file-item");
  if (!el) return;
  if (el.dataset.jumpNode !== undefined) {
    showNode(el.dataset.jumpNode);
  } else if (el.dataset.copy !== undefined) {
    void copyId(el.dataset.copy);
  } else if (el.dataset.kind !== undefined) {
    const kind = el.dataset.kind;
    state.changeKindFilter = isChangeKind(kind) ? kind : null;
    state.fileLimit = FILE_PAGE;
    render();
    if (state.changeKindFilter) revealHighlighted();
  } else if (el.dataset.toggleAuto !== undefined) {
    state.showAutoFiles = !state.showAutoFiles;
    renderSidebar(state.currentDoc);
  } else if (el.dataset.showMore !== undefined) {
    state.fileLimit += FILE_PAGE;
    renderSidebar(state.currentDoc);
  } else {
    const fp = el.dataset.filePath ?? null;
    state.highlightedFilePath = state.highlightedFilePath === fp ? null : fp;
    render();
    if (state.highlightedFilePath) revealHighlighted();
  }
});

content.addEventListener("input", (e) => {
  if (!(e.target instanceof HTMLInputElement) || e.target.id !== "file-filter") return;
  state.fileQuery = e.target.value;
  state.fileLimit = FILE_PAGE;
  renderSidebar(state.currentDoc);
});

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
    resetFileList();
    updateTabUI();
    render();
  });
});
