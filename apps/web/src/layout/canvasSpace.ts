import { Matrix4 } from 'three';

/**
 * PORTRAIT HOOK shared by the world-space HUD (hud/worldCanvas.ts) and its depth pass (three/hudDepth.ts); written by
 * src/layout/portraitTable.ts. `matrix` maps Unity world space to three space — the Unity root's transform, normally
 * the plain Z mirror; the portrait table turns and scales that root. `upright` drops each canvas's rotation on screen
 * (the HUD stays readable on the turned table) and `hudScale` sizes it independently of the 3D zoom (`scales`
 * overrides it per canvas). `positions` optionally re-places a canvas (Unity world point) without touching its data.
 * Keys are the WorldCanvas instances.
 */
export const worldCanvasSpace = {
  matrix: new Matrix4().makeScale(1, 1, -1),
  upright: false,
  hudScale: 1,
  positions: new Map<object, [number, number, number]>(),
  scales: new Map<object, number>(),
};

/** Uniform scale of `worldCanvasSpace.matrix` (the portrait fit zoom; 1 in landscape). */
export function worldCanvasZoom(): number {
  const e = worldCanvasSpace.matrix.elements;
  return Math.hypot(e[0], e[1], e[2]);
}
