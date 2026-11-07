/**
 * Portrait for the screen-space overlay canvases (docs/portrait-design.md §Overlay canvases).
 *
 * Landscape keeps Unity's CanvasScaler (Scale With Screen Size 1920×1080, match 0.5). That formula only depends on the
 * screen's area, so on a 390×844 phone it gives a 979-unit-wide canvas and 32 px buttons: the 1,700-unit action row
 * does not fit and nothing is thumb-sized. Portrait uses a 720×1280 reference instead (s = min(W/720, H/1280)): a
 * 720-unit-wide canvas, so a Unity 81-unit button is ~44 px on a 390-px phone — and a few nodes are re-anchored
 * per canvas with `PortraitRects` (same nodes and art, new RectTransforms).
 */
import type { UNode, Vec2 } from '../hud/unityUi';
import { isPortrait } from './orientation';

/** Portrait reference resolution for the overlay canvases. */
export const PORTRAIT_REF: Vec2 = [720, 1280];

/** CanvasScaler scale factor: Unity's in landscape; the portrait reference in portrait. */
export function overlayScale(w: number, h: number): number {
  if (isPortrait()) return Math.min(w / PORTRAIT_REF[0], h / PORTRAIT_REF[1]);
  return Math.pow(2, 0.5 * Math.log2(w / 1920) + 0.5 * Math.log2(h / 1080));
}

export interface RectRule {
  anchorMin?: Vec2;
  anchorMax?: Vec2;
  /** Sets both anchors. */
  anchor?: Vec2;
  pivot?: Vec2;
  pos?: Vec2;
  size?: Vec2;
  scale?: Vec2;
}

interface SavedRect {
  anchorMin: Vec2;
  anchorMax: Vec2;
  pivot: Vec2;
  pos: Vec2;
  size: Vec2;
  scale: Vec2;
}

/**
 * Re-anchors nodes under `root` in portrait and restores their authored rects in landscape. Paths are UNode.find paths
 * from `root`; rules may also be a function of the canvas size (canvas units) for edge-relative placements.
 * Call `apply(canvasW, canvasH)` before `root.layout()` in the canvas's layout pass.
 */
export class PortraitRects {
  private readonly saved = new Map<UNode, SavedRect>();
  private portrait = false;

  constructor(
    private readonly root: UNode,
    private readonly rules: Record<string, RectRule> | ((w: number, h: number) => Record<string, RectRule>),
  ) {}

  apply(w = this.root.sizeDelta[0], h = this.root.sizeDelta[1]): boolean {
    const p = isPortrait();
    const rules = typeof this.rules === 'function' ? this.rules(w, h) : this.rules;
    if (!p) {
      if (this.portrait) for (const [n, s] of this.saved) restore(n, s);
      this.portrait = false;
      return false;
    }
    this.portrait = true;
    for (const [path, r] of Object.entries(rules)) {
      const n = this.root.find(path);
      if (!n) continue;
      if (!this.saved.has(n))
        this.saved.set(n, { anchorMin: [...n.anchorMin], anchorMax: [...n.anchorMax], pivot: [...n.pivot], pos: [...n.anchoredPosition], size: [...n.sizeDelta], scale: [...n.scale] });
      const am = r.anchor ?? r.anchorMin;
      const aM = r.anchor ?? r.anchorMax;
      if (am) n.anchorMin = [...am];
      if (aM) n.anchorMax = [...aM];
      if (r.pivot) n.pivot = [...r.pivot];
      if (r.pos) n.anchoredPosition = [...r.pos];
      if (r.size) n.sizeDelta = [...r.size];
      if (r.scale) n.scale = [...r.scale];
    }
    return true;
  }
}

function restore(n: UNode, s: SavedRect): void {
  n.anchorMin = [...s.anchorMin];
  n.anchorMax = [...s.anchorMax];
  n.pivot = [...s.pivot];
  n.anchoredPosition = [...s.pos];
  n.sizeDelta = [...s.size];
  n.scale = [...s.scale];
}
