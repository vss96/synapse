import { describe, expect, it } from "bun:test";
import { MAX_SCALE, MIN_SCALE, centerCamera, fitCamera, fitScale, zoomAt, type Camera } from "../viewer/camera.js";

const toScreen = (cam: Camera, x: number, y: number) => ({ x: x * cam.scale + cam.tx, y: y * cam.scale + cam.ty });

describe("viewer camera", () => {
  it("zooms around the given point instead of the top-left corner", () => {
    const cam = { scale: 0.5, tx: 40, ty: -20 };
    // The scene point currently under (300, 200) must stay under it.
    const scene = { x: (300 - cam.tx) / cam.scale, y: (200 - cam.ty) / cam.scale };
    for (const factor of [1.2, 1 / 1.2, 3]) {
      const next = zoomAt(cam, factor, 300, 200);
      const p = toScreen(next, scene.x, scene.y);
      expect(p.x).toBeCloseTo(300);
      expect(p.y).toBeCloseTo(200);
    }
  });

  it("clamps zoom and keeps the anchor at the limit", () => {
    expect(zoomAt({ scale: 3, tx: 0, ty: 0 }, 10, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAt({ scale: 0.1, tx: 0, ty: 0 }, 0.01, 0, 0).scale).toBe(MIN_SCALE);
  });

  it("fits the whole scene, centred, without enlarging small scenes", () => {
    const view = { w: 800, h: 600 };
    const big = fitCamera({ w: 1600, h: 600 }, view);
    expect(big.scale).toBe(0.5);
    expect(toScreen(big, 800, 300)).toEqual({ x: 400, y: 300 });
    expect(fitScale({ w: 200, h: 100 }, view)).toBe(1);
    expect(fitScale({ w: 200, h: 100 }, { w: 0, h: 0 })).toBe(1);
  });

  it("centres a scene point in the viewport", () => {
    const cam = centerCamera(1000, 50, { w: 400, h: 300 });
    expect(cam.scale).toBe(1);
    expect(toScreen(cam, 1000, 50)).toEqual({ x: 200, y: 150 });
  });
});
