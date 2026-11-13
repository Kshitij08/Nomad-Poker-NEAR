/**
 * Portrait placements for the table's screen-space overlay canvases (docs/portrait-design.md §Table chrome). Canvas
 * units on the 720-wide portrait reference (portraitRects.ts); the bottom row clears the home bar (safe area).
 *
 *   ┌──────────────────────────────┐
 *   │ [LEAVE]                 (⚙)  │  top row: LEAVE moves up from the action row (rarely used, has a confirm)
 *   │          table …             │
 *   │ (chat) (☺)                   │  chat / reactions toggles sit above the row, left
 *   │ [ CALL ] [CHECK/FOLD] [RAISE]│  three equal thumb buttons, full width
 *   └──────────────────────────────┘
 * The raise (Confirm) panel stacks into three rows over the action row: presets, slider + amount, CONFIRM.
 */
import type { UNode } from '../hud/unityUi';
import { safeArea } from './orientation';
import { PortraitRects, type RectRule } from './portraitRects';

/** Action row geometry (canvas units, bottom-anchored centre line). */
export const PORTRAIT_ROW = { y: 66, h: 84, w: 232, gap: 6 };
/** Top chrome row centre (canvas units below the top edge). */
export const PORTRAIT_TOP_ROW_Y = 52;

const safeBottomUnits = (root: UNode) => safeArea().bottom / Math.max(0.05, root.renderScale);
const safeTopUnits = (root: UNode) => safeArea().top / Math.max(0.05, root.renderScale);

export function portraitBettingRects(root: UNode): PortraitRects {
  return new PortraitRects(root, () => {
    const y = PORTRAIT_ROW.y + safeBottomUnits(root);
    // v2: a side gutter (plus the side safe areas) so the row doesn't touch the screen edges.
    const ins = safeArea();
    const side = 14 + Math.max(ins.left, ins.right) / Math.max(0.05, root.renderScale);
    const w = Math.min(PORTRAIT_ROW.w, (root.sizeDelta[0] - 2 * side - 2 * PORTRAIT_ROW.gap) / 3);
    const step = w + PORTRAIT_ROW.gap;
    const btn = (x: number): RectRule => ({ anchor: [0.5, 0], pivot: [0.5, 0.5], pos: [x, y], size: [w, PORTRAIT_ROW.h] });
    const panelH = 316;
    const panelY = y - PORTRAIT_ROW.h / 2 + panelH / 2 - 6;
    const preset = (i: number): RectRule => ({ pos: [(i - 2) * 132, 100], size: [122, 54] });
    return {
      // Redesign v2 order: Fold · Check/Call · Bet/Raise (Fold no longer in the middle under the thumb).
      'Check/fold': btn(-step),
      Call: btn(0),
      'Callany or raise': btn(step),
      Confirm_Panel: { anchor: [0.5, 0], pivot: [0.5, 0.5], pos: [0, panelY], size: [700, panelH] },
      'Confirm_Panel/close': { pos: [322, 130], size: [52, 52] },
      'Confirm_Panel/button_min': preset(0),
      'Confirm_Panel/button_1/4': preset(1),
      'Confirm_Panel/button_1/2': preset(2),
      'Confirm_Panel/button_3/4': preset(3),
      'Confirm_Panel/button_all-in': preset(4),
      'Confirm_Panel/Slider': { pos: [-100, 18], size: [440, 54] },
      'Confirm_Panel/Value': { pos: [228, 18] },
      'Confirm_Panel/Confirm': { pos: [0, -96], size: [664, 92] },
    };
  });
}

/** NomadTableHud (menu module): the Setting gear top-right, LEAVE top-left. */
export function portraitNomadTableRects(root: UNode): PortraitRects {
  return new PortraitRects(root, () => {
    const y = -(PORTRAIT_TOP_ROW_Y + safeTopUnits(root));
    return {
      Setting: { anchor: [1, 1], pivot: [0.5, 0.5], pos: [-58, y] },
      Nomad_Leave: { anchor: [0, 1], pivot: [0, 0.5], pos: [20, y], size: [196, 70] },
    };
  });
}

/**
 * Network table chrome (net module): everything moves into the top row so the bottom stays the action row's —
 *   [LEAVE] [room code]          (☺) (💬) (⚙)
 *            [+ bot]
 * The chat window and the reaction tray hang down from their toggles on the right instead of rising from the bottom
 * left (where the bottom-left seat is in portrait).
 */
export function portraitNetChromeRects(root: UNode): PortraitRects {
  return new PortraitRects(root, () => {
    const top = 12 + safeTopUnits(root);
    const row = -(PORTRAIT_TOP_ROW_Y + safeTopUnits(root));
    const toggle: RectRule = { anchor: [1, 1], pivot: [1, 0.5], pos: [0, -(PORTRAIT_TOP_ROW_Y - 12)], size: [72, 72] };
    return {
      Chat_Panel: { anchor: [1, 1], pivot: [1, 1], pos: [-104, -top] },
      'Chat_Panel/Chat_Toggle': toggle,
      'Chat_Panel/Chat_Window': { anchor: [1, 1], pivot: [1, 1], pos: [96, -84] },
      Reaction_Panel: { anchor: [1, 1], pivot: [1, 1], pos: [-186, -top] },
      'Reaction_Panel/Reaction_Toggle': toggle,
      'Reaction_Panel/Reaction_Tray': { anchor: [1, 1], pivot: [1, 1], pos: [178, -84] },
      InviteButton: { anchor: [0, 1], pivot: [0, 0.5], pos: [224, row], size: [236, 64] },
      'InviteButton/Text': { scale: [0.8, 0.8] },
      AddBotButton: { anchor: [0, 1], pivot: [0, 0.5], pos: [226, row - 62], size: [150, 50] },
      // Landscape moves these to the bottom row (Redesign v2); portrait keeps Unity's centre spot.
      Join_Table: { anchor: [0.5, 0.5], pivot: [0.5, 0.5], pos: [0, 0] },
      'Start Game': { anchor: [0.5, 0.5], pivot: [0.5, 0.5], pos: [0, 0] },
    };
  });
}
