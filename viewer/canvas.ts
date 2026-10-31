/** The map's camera: pan, zoom, and bringing cards into view. */

import { isTask } from "../src/model/kinds.js";
import type { MindmapDocument } from "../src/model/schema.js";
import {
  READABLE_SCALE,
  centerCamera,
  fitCamera,
  fitScale,
  revealCamera,
  wheelZoomFactor,
  zoomAt,
  type Box,
  type Camera,
  type Size,
} from "./camera.js";
import { byId, query } from "./dom.js";
import { ROOT, type ViewMode } from "./layout.js";
import { isHighlighted, render, state } from "./state.js";

// View Mode Switcher (Split / Plan / HLD)
export function setViewMode(mode: ViewMode) {
  state.viewMode = mode;
  document.querySelectorAll<HTMLElement>("#view-switcher button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.viewMode)
  );
  requestFreshView();
  render();
}

/** Select a node picked in the sidebar and bring it into view, switching to the split view if this view hides it. */
export function showNode(id: string) {
  state.selectedNodeId = id;
  if (nodeBoxes.has(id) || state.viewMode === "all") render();
  else setViewMode("all");
  revealNodes([id]);
}

const viewport = byId("viewport");
export const svgEl = byId("svg", SVGSVGElement);

let camera: Camera = { scale: 1, tx: 0, ty: 0 };
let panning = false, startX = 0, startY = 0, startTx = 0, startTy = 0;
/** Size of the laid-out tree and the box of each visible card, in scene coordinates. */
let sceneSize: Size = { w: 0, h: 0 };
export const nodeBoxes = new Map<string, Box>();
/** Set when a session or view is opened, so the next render picks a fresh camera. */
let viewPending = true;
let lastActiveId: string | null = null;

export function setSceneSize(size: Size): void {
  sceneSize = size;
}

/** Ask for a fresh camera on the next render: a new session or view is opening. */
export function requestFreshView(): void {
  viewPending = true;
}

/**
 * Move the camera only for a new session or view, or when the agent moves on to another task;
 * otherwise live updates and clicks keep whatever the user panned to.
 */
export function placeCamera(doc: MindmapDocument): void {
  const active = activeNodeId(doc);
  if (viewPending || active !== lastActiveId) initialView();
  viewPending = false;
  lastActiveId = active;
  applyTransform();
}

function applyTransform() {
  const { scale, tx, ty } = camera;
  svgEl.querySelector(".scene")?.setAttribute("transform", `translate(${tx} ${ty}) scale(${scale})`);
}

function viewSize(): Size {
  const r = svgEl.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

/** The task the agent is working on (latest updated in progress) if it is in this view, else the root. */
function activeNodeId(doc: MindmapDocument): string {
  const active = Object.values(doc.nodes)
    .filter((n) => isTask(n) && n.status === "in_progress" && nodeBoxes.has(n.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return active?.id ?? ROOT;
}

function focusActive() {
  if (!state.currentDoc) return;
  const id = activeNodeId(state.currentDoc);
  const box = nodeBoxes.get(id);
  const view = viewSize();
  // With no active task, keep the root at the left edge so its branches fill the view.
  if (box) camera = centerCamera(id === ROOT ? box.x - 40 + view.w / 2 : box.x + box.w / 2, box.y + box.h / 2, view);
  applyTransform();
}

function fitView() {
  camera = fitCamera(sceneSize, viewSize());
  applyTransform();
}

/** Fit the whole map when it is readable that way, otherwise show the active task at full size. */
function initialView() {
  if (fitScale(sceneSize, viewSize()) >= READABLE_SCALE) fitView();
  else focusActive();
}

/** Move the camera, if needed, to show these cards (the ones drawn in the current view). */
export function revealNodes(ids: readonly string[]) {
  const boxes = ids.flatMap((id) => nodeBoxes.get(id) ?? []);
  if (boxes.length === 0) return;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const w = Math.max(...boxes.map((b) => b.x + b.w)) - x;
  const h = Math.max(...boxes.map((b) => b.y + b.h)) - y;
  camera = revealCamera(camera, { x, y, w, h }, viewSize());
  applyTransform();
}

export function revealHighlighted() {
  if (state.currentDoc) revealNodes(Object.values(state.currentDoc.nodes).filter(isHighlighted).map((n) => n.id));
}

function zoomFromCenter(factor: number) {
  const { w, h } = viewSize();
  camera = zoomAt(camera, factor, w / 2, h / 2);
  applyTransform();
}

byId("zoom-in").onclick = () => zoomFromCenter(1.2);
byId("zoom-out").onclick = () => zoomFromCenter(1 / 1.2);
byId("zoom-fit").onclick = fitView;
byId("zoom-focus").onclick = focusActive;

// End #svg above the bottom overlays (legend, zoom controls) so fitting and centering use the
// unobstructed area; panned content still shows beneath them because #svg doesn't clip.
const bottomOverlays = query(".canvas-bottom");
const fitAboveOverlays = () => {
  svgEl.style.height = `${Math.max(0, bottomOverlays.offsetTop - 8)}px`;
};
fitAboveOverlays(); // now, not only when observed: the first view is measured against this size
const overlayObserver = new ResizeObserver(fitAboveOverlays);
[viewport, bottomOverlays].forEach((el) => overlayObserver.observe(el));

viewport.addEventListener("mousedown", (e) => {
  if (e.target instanceof Element && (e.target.closest(".node-group") || e.target.closest(".controls") || e.target.closest(".map-search"))) return;
  panning = true;
  startX = e.clientX; startY = e.clientY;
  startTx = camera.tx; startTy = camera.ty;
});
window.addEventListener("mousemove", (e) => {
  if (!panning) return;
  camera = { ...camera, tx: startTx + (e.clientX - startX), ty: startTy + (e.clientY - startY) };
  applyTransform();
});
window.addEventListener("mouseup", () => { panning = false; });

// Zoom around the cursor, so whatever is under it stays put.
viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = svgEl.getBoundingClientRect();
  camera = zoomAt(camera, wheelZoomFactor(e), e.clientX - r.left, e.clientY - r.top);
  applyTransform();
}, { passive: false });
