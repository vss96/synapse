/**
 * Pan/zoom math for the canvas: a camera maps scene coordinates (the laid-out tree) to the
 * viewport as `screen = scene * scale + (tx, ty)`. Pure, so it is unit-tested without a DOM.
 */

export interface Camera {
  scale: number;
  tx: number;
  ty: number;
}

export interface Size {
  w: number;
  h: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 4;
/** Below this, card text is too small to read, so the initial view focuses a node instead of fitting. */
export const READABLE_SCALE = 0.75;

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** Zoom by `factor`, keeping the scene point under viewport point (cx, cy) where it is. */
export function zoomAt(cam: Camera, factor: number, cx: number, cy: number): Camera {
  const scale = clampScale(cam.scale * factor);
  const k = scale / cam.scale;
  return { scale, tx: cx - (cx - cam.tx) * k, ty: cy - (cy - cam.ty) * k };
}

/** The scale that fits the whole scene into the viewport, never enlarging past 1. */
export function fitScale(scene: Size, view: Size): number {
  if (scene.w <= 0 || scene.h <= 0 || view.w <= 0 || view.h <= 0) return 1;
  return clampScale(Math.min(1, view.w / scene.w, view.h / scene.h));
}

/** The whole scene, centred. */
export function fitCamera(scene: Size, view: Size): Camera {
  const scale = fitScale(scene, view);
  return { scale, tx: (view.w - scene.w * scale) / 2, ty: (view.h - scene.h * scale) / 2 };
}

/** Scene point (x, y) in the middle of the viewport at `scale`. */
export function centerCamera(x: number, y: number, view: Size, scale = 1): Camera {
  const s = clampScale(scale);
  return { scale: s, tx: view.w / 2 - x * s, ty: view.h / 2 - y * s };
}

/** A rectangle in scene coordinates, from its top-left corner. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The camera that shows `box` (e.g. the selected or highlighted cards) at least `margin` pixels
 * inside the viewport. It zooms out only as far as the box needs, zooms in only up to a readable
 * scale, and is `cam` itself when the box is already in view at such a scale.
 */
export function revealCamera(cam: Camera, box: Box, view: Size, margin = 40): Camera {
  const room = { w: view.w - 2 * margin, h: view.h - 2 * margin };
  if (box.w <= 0 || box.h <= 0 || room.w <= 0 || room.h <= 0) return cam;
  const fits = clampScale(Math.min(room.w / box.w, room.h / box.h));
  const scale = Math.min(fits, Math.max(cam.scale, Math.min(READABLE_SCALE, fits)));
  const left = box.x * cam.scale + cam.tx;
  const top = box.y * cam.scale + cam.ty;
  const inView =
    left >= margin && top >= margin && left + box.w * cam.scale <= view.w - margin && top + box.h * cam.scale <= view.h - margin;
  if (scale === cam.scale && inView) return cam;
  return centerCamera(box.x + box.w / 2, box.y + box.h / 2, view, scale);
}
