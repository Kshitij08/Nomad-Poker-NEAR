/**
 * Portrait seat HUD (docs/portrait-design.md §Seats): the landscape `Name_Canvas` puts the name bar beside the avatar
 * (≈ 1,650 canvas units wide), which cannot fit three seats across a phone. In portrait every seat stacks instead:
 * avatar on top, the same Name_bar art centred under it (narrower), the status pill (Bottom_bar) peeking out below,
 * the D/SB/BB token beside the avatar (off the plate) and the hand-strength panel under the stack. Same nodes, sprites, fonts and
 * colours — only their RectTransforms move.
 *
 * The seat's on-enable clips (Name_Graphics_In, Botton_name_Bar) write these rects while they play, so the portrait
 * values are re-asserted every frame (only when they differ) — the pop-in scale animation still plays; the bar's
 * slide-out from behind the avatar becomes part of the pop.
 */
import type { UNode, Vec2 } from '../hud/unityUi';
import type { SeatHudView } from '../hud/seatHud';

interface RectTarget {
  path: string;
  anchor?: Vec2;
  pos?: Vec2;
  size?: Vec2;
}

/** Canvas units, avatar centre = (0, 0), y up. */
const STACK: RectTarget[] = [
  { path: 'Graphics/Name_bar', anchor: [0.5, 0.5], pos: [0, -400], size: [840, 295] },
  { path: 'Graphics/Name_bar/Name_txt', pos: [0, 73], size: [-150, -188] },
  { path: 'Graphics/Name_bar/Amount_txt', pos: [0, -36], size: [-150, -22] },
  // D / SB / BB: off the plate, in the corner right of the avatar (v2hud.css sizes it 200 wide in portrait).
  { path: 'Graphics/Name_bar/D_Token', anchor: [1, 0.5], pos: [-134, 225] },
  { path: 'Graphics/Bottom_bar', anchor: [0.5, 0.5], pos: [0, -590], size: [760, 295] },
];
/** The hand-strength panel (local seat): under the stack. */
const HAND: RectTarget = { path: 'Graphics/Hand', anchor: [0.5, 0.5], pos: [0, -820] };

/** Extent of the stacked seat in canvas units from the avatar centre (for the table fit and the overlap check). */
export { STACKED_SEAT_BOX } from './portraitLayout';

interface Saved {
  node: UNode;
  anchorMin: Vec2;
  anchorMax: Vec2;
  pos: Vec2;
  size: Vec2;
}

export class PortraitSeats {
  private on = false;
  private readonly saved = new Map<SeatHudView, Saved[]>();

  constructor(private readonly seats: readonly SeatHudView[]) {
    for (const seat of seats) {
      const list: Saved[] = [];
      for (const t of [...STACK, HAND]) {
        const node = seat.root.find(t.path);
        if (node) list.push({ node, anchorMin: [...node.anchorMin], anchorMax: [...node.anchorMax], pos: [...node.anchoredPosition], size: [...node.sizeDelta] });
      }
      this.saved.set(seat, list);
    }
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    for (const seat of this.seats) {
      if (!on) {
        for (const s of this.saved.get(seat) ?? []) {
          s.node.anchorMin = [...s.anchorMin];
          s.node.anchorMax = [...s.anchorMax];
          s.node.anchoredPosition = [...s.pos];
          s.node.sizeDelta = [...s.size];
        }
        if (seat.root.activeInHierarchy) seat.root.layout();
      } else this.enforce(seat, true);
    }
  }

  /** Per frame in portrait: re-assert the stacked rects on visible seats (clips may have written them). */
  frame(): void {
    if (!this.on) return;
    for (const seat of this.seats) if (seat.visible) this.enforce(seat, false);
  }

  private enforce(seat: SeatHudView, force: boolean): void {
    let dirty = force;
    const apply = (t: RectTarget) => {
      const n = seat.root.find(t.path);
      if (!n) return;
      if (t.anchor && (n.anchorMin[0] !== t.anchor[0] || n.anchorMin[1] !== t.anchor[1] || n.anchorMax[0] !== t.anchor[0] || n.anchorMax[1] !== t.anchor[1])) {
        n.anchorMin = [...t.anchor];
        n.anchorMax = [...t.anchor];
        dirty = true;
      }
      if (t.pos && (n.anchoredPosition[0] !== t.pos[0] || n.anchoredPosition[1] !== t.pos[1])) {
        n.anchoredPosition = [...t.pos];
        dirty = true;
      }
      if (t.size && (n.sizeDelta[0] !== t.size[0] || n.sizeDelta[1] !== t.size[1])) {
        n.sizeDelta = [...t.size];
        dirty = true;
      }
    };
    for (const t of STACK) apply(t);
    const hand = seat.root.find(HAND.path);
    if (hand?.activeSelf) apply(HAND);
    if (dirty && seat.root.activeInHierarchy) seat.root.layout();
  }
}
