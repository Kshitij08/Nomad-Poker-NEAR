import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { hudContentBounds, hudQuadMatrix, type HudNode, type HudPlaneSource } from '../hudDepth';

function node(p: Partial<HudNode> & { children?: HudNode[] }): HudNode {
  return {
    children: [],
    activeSelf: true,
    anchorMin: [0.5, 0.5],
    anchorMax: [0.5, 0.5],
    anchoredPosition: [0, 0],
    sizeDelta: [100, 100],
    pivot: [0.5, 0.5],
    scale: [1, 1],
    rotation: 0,
    groupAlpha: 1,
    image: null,
    text: null,
    ...p,
  };
}

describe('hudContentBounds', () => {
  it('unions active graphics in canvas units around the pivot (y up)', () => {
    const bar = node({ image: {}, anchoredPosition: [300, -50], sizeDelta: [400, 100], pivot: [0, 0.5] });
    const hidden = node({ image: {}, anchoredPosition: [-900, 0], activeSelf: false });
    const root = node({ sizeDelta: [500, 500], children: [node({ image: {}, sizeDelta: [500, 500] }), bar, hidden] });
    expect(hudContentBounds(root)).toEqual([-250, -250, 700, 250]);
  });

  it('follows rotation, scale and stretched anchors', () => {
    const rotated = node({ image: {}, sizeDelta: [200, 100], rotation: 90 });
    const stretched = node({ text: {}, anchorMin: [0, 0], anchorMax: [1, 0], sizeDelta: [0, 20], pivot: [0.5, 0] });
    const root = node({ sizeDelta: [400, 400], children: [node({ scale: [2, 2], sizeDelta: [0, 0], children: [rotated] }), stretched] });
    const b = hudContentBounds(root)!;
    expect(b.map((v) => Math.round(v))).toEqual([-200, -200, 200, 200]);
    const only = node({ sizeDelta: [400, 400], children: [node({ scale: [2, 2], sizeDelta: [0, 0], children: [rotated] })] });
    expect(hudContentBounds(only)!.map((v) => Math.round(v))).toEqual([-100, -200, 100, 200]);
  });

  it('is null when nothing draws', () => {
    expect(hudContentBounds(node({ children: [node({})] }))).toBeNull();
  });
});

describe('hudQuadMatrix', () => {
  it('lays the rect flat on the canvas plane (Unity z negated, canvas +y = Unity +z)', () => {
    const c: HudPlaneSource = {
      root: node({}),
      position: [1, 0.92, 2],
      unitScale: 0.01,
      shaker: { angle: 0, axis: [0, 0, 1] },
      eulerOffset: null,
    };
    const m = hudQuadMatrix(c, [0, 0, 100, 50], new Matrix4());
    const corner = (x: number, y: number) => new Vector3(x, y, 0).applyMatrix4(m).toArray().map((v) => +v.toFixed(6));
    expect(corner(-0.5, -0.5)).toEqual([1, 0.92, -2]);
    expect(corner(0.5, 0.5)).toEqual([2, 0.92, -2.5]);
  });

  it('spins in the table plane about the pivot with the shaker', () => {
    const c: HudPlaneSource = {
      root: node({}),
      position: [0, 1, 0],
      unitScale: 1,
      shaker: { angle: 90, axis: [0, 0, 1] },
      eulerOffset: null,
    };
    const m = hudQuadMatrix(c, [0, -0.5, 1, 0.5], new Matrix4());
    // Canvas +x end (1, 0) turns counter-clockwise on screen to canvas +y = Unity +z = three −z.
    const p = new Vector3(0.5, 0, 0).applyMatrix4(m);
    expect([p.x, p.y, p.z].map((v) => +v.toFixed(6) + 0)).toEqual([0, 1, -1]);
  });
});
