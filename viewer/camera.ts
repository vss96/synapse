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
