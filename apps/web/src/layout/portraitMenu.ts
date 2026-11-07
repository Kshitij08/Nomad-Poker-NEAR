/**
 * Portrait for the Nomad menu screens (docs/portrait-design.md §Menu). The art team's screens are 16:9; in portrait
 * every menu canvas switches to a 1080×1920 reference (Expand: the canvas is 1080 units wide on a phone) and each
 * screen's existing nodes are re-anchored into a single column by the rules below — same nodes, sprites, fonts and
 * bindings, new RectTransforms. Landscape restores every authored rect.
 *
 * A rule is data: `pins` (fixed placements, like a RectTransform edit) and `stacks` (blocks laid top-to-bottom in a
 * container, each scaled to fit the column; `row` blocks keep their authored x spread, scaled to the new width).
 * Framed screens (NomadUiHost.Fit169) get their Frame169 stretched over the whole canvas first.
 */
import type { UNode, Vec2 } from '../hud/unityUi';
import { isPortrait, safeArea } from './orientation';
import type { RectRule } from './portraitRects';

/** Portrait reference for every menu-style canvas whose landscape reference is 1920×1080. */
export const MENU_PORTRAIT_REF: Vec2 = [1080, 1920];

/** CanvasScaler reference to use now (menu canvases call this with their landscape reference). */
export function menuReference(ref: Vec2): Vec2 {
  return isPortrait() && ref[0] === 1920 && ref[1] === 1080 ? MENU_PORTRAIT_REF : ref;
}

interface Block {
  /** One node, or several that share one row (each keeps its authored x, scaled to the container width). */
  path?: string;
  row?: string[];
  /** Fixed scale, 'fit' (to the column width, up to maxScale) or 'fill' (also up to the height left). */
  scale?: number | 'fit' | 'fill';
  maxScale?: number;
  /** Natural size for nodes whose authored rect stretches (anchors apart). */
  size?: Vec2;
  /** Resize the node itself (not scale) to the column width × this height; 'rest' = the height left. */
  resize?: { h: number | 'rest'; w?: number };
  gap?: number;
  x?: number;
}

interface Stack {
  /** Container path (default: the screen root, or its Frame169). */
  in?: string;
  /** Authored width the row x positions were designed for (default 1920, or the container's authored width). */
  authoredW?: number;
  top?: number;
  bottom?: number;
  gap?: number;
  margin?: number;
  /** Centre the stacked blocks vertically in the space. */
  center?: boolean;
  blocks: Block[];
}

interface ScreenRule {
  frame?: boolean;
  pins?: Record<string, RectRule>;
  stacks?: Stack[];
}

type RuleFn = (W: number, H: number) => ScreenRule;

/** Tournaments_* share their top bar, 2×2 tabs and a two-panel body. */
const tournaments = (first: string, second: string | null): RuleFn => () => ({
  frame: true,
  pins: {
    'TopBar/Title': { anchor: [0.5, 1], pos: [0, -150] },
    'TopBar/HeaderLine': { anchor: [0.5, 1], pos: [0, -196], size: [1080, 2] },
    'TopBar/Mode': { anchor: [1, 1], pos: [-300, -61] },
    'TopBar/CoinIcon': { anchor: [1, 1], pos: [-215, -61] },
    'TopBar/Coins': { anchor: [1, 1], pos: [-110, -61] },
    'Tabs/Tab_Browse': { anchor: [0.5, 1], pos: [-262, -250], size: [500, 76] },
    'Tabs/Tab_MyTournaments': { anchor: [0.5, 1], pos: [262, -250], size: [500, 76] },
    'Tabs/Tab_Host': { anchor: [0.5, 1], pos: [-262, -338], size: [500, 76] },
    'Tabs/Tab_JoinByCode': { anchor: [0.5, 1], pos: [262, -338], size: [500, 76] },
  },
  stacks: [
    { top: 400, bottom: 20, blocks: [{ path: 'Body', resize: { h: 'rest', w: 1060 } }] },
    {
      in: 'Body',
      authoredW: 1766,
      top: 0,
      bottom: 0,
      margin: 0,
      gap: 24,
      blocks: second ? [{ path: first, scale: 'fit', maxScale: 1 }, { path: second, scale: 'fill', maxScale: 1.4 }] : [{ path: first, scale: 'fill', maxScale: 1 }],
    },
  ],
});

/** Agents_* share the top bar, the agent header and the 3 tabs. */
const agentsTop: Record<string, RectRule> = {
  'Btn_Close': { anchor: [0, 1], pos: [110, -61] },
  'TopBar/Title': { anchor: [0.5, 1], pos: [0, -150] },
  'TopBar/Subtitle': { anchor: [0.5, 1], pos: [0, -200] },
  'TopBar/Coins': { anchor: [1, 1], pos: [-110, -61] },
};

const RULES: Record<string, RuleFn> = {
  Login: () => ({ stacks: [{ center: true, blocks: [{ path: 'Panel', scale: 'fit', maxScale: 1.24 }] }] }),

  MainMenu: () => ({
    pins: {
      'TopBar/Stat_Coins': { anchor: [0, 1], pos: [130, -96] },
      'TopBar/Stat_Level': { anchor: [0, 1], pos: [318, -96] },
      'TopBar/Stat_High': { anchor: [0, 1], pos: [497, -96] },
      'TopBar/PlayerCapsule': { anchor: [1, 1], pos: [-262, -99] },
      'BottomBar/Btn_Settings': { anchor: [1, 1], pos: [-58, -97] },
      ProfileDropdown: { anchor: [1, 1], pos: [-240, -421] },
    },
    stacks: [
      {
        center: true,
        top: 180,
        bottom: 200,
        gap: 36,
        blocks: [
          { path: 'Center/Logo', scale: 1.3, gap: 60 },
          { path: 'Center/Btn_Tables', scale: 1.6 },
          { path: 'Center/Btn_QuickPlay', scale: 1.6 },
          { path: 'Center/Btn_PartyMenu', scale: 1.6 },
        ],
      },
    ],
  }),

  TableSelect_TownLobby: () => ({
    frame: true,
    pins: {
      'TopBar/Title': { anchor: [0.5, 1], pos: [0, -150] },
      'TopBar/TitleUnderline': { anchor: [0.5, 1], pos: [0, -194] },
      'TopBar/ModeToggle': { anchor: [1, 1], pos: [-330, -61] },
      'TopBar/Coins': { anchor: [1, 1], pos: [-110, -61] },
    },
    stacks: [
      {
        top: 230,
        bottom: 30,
        gap: 28,
        blocks: [
          { path: 'ThemePreview', scale: 'fit', maxScale: 1 },
          { path: 'ThemeCards', size: [1342, 400], scale: 'fit', maxScale: 1, gap: 10 },
          { path: 'SelectedTablePanel', scale: 'fill', maxScale: 1.5 },
        ],
      },
    ],
  }),

  Friends: (_W, H) => ({
    frame: true,
    pins: {
      'Frame/Tabs': { anchor: [0.5, 1], pivot: [0.5, 1], pos: [-110, -30] },
      'Frame/FriendsCount': { anchor: [1, 1], pivot: [1, 1], pos: [-24, -40] },
      'Frame/List': { anchor: [0.5, 1], pivot: [0.5, 1], pos: [0, -130], size: [1030, Math.max(500, H - 160 - 130 - 889 * 0.75 - 70)] },
      'Frame/ProfileColumn': { anchor: [0.5, 0], pivot: [0.5, 0], pos: [0, 24], scale: [0.75, 0.75] },
    },
    stacks: [{ top: 140, bottom: 20, blocks: [{ path: 'Frame', resize: { h: 'rest', w: 1060 } }] }],
  }),

  PartyMenu: () => ({
    frame: true,
    stacks: [
      {
        center: true,
        top: 150,
        bottom: 40,
        gap: 30,
        blocks: [
          { path: 'TopBar/Title', scale: 'fit', maxScale: 1 },
          { path: 'TopBar/Subtitle', scale: 1 },
          { path: 'Center/Illus_CardsAndChips', scale: 1 },
          { path: 'Center/Card_Create', scale: 'fill', maxScale: 1.3 },
          { path: 'Center/Card_Join', scale: 'fill', maxScale: 1.3 },
        ],
      },
    ],
  }),

  Leaderboard: () => ({
    frame: true,
    stacks: [
      { top: 130, bottom: 20, blocks: [{ path: 'Frame', resize: { h: 'rest', w: 1060 } }] },
      {
        in: 'Frame',
        authoredW: 1219,
        center: true,
        top: 40,
        bottom: 30,
        gap: 26,
        blocks: [
          { row: ['Title', 'Coins'] },
          { row: ['Tab_Weekly', 'Tab_Monthly', 'Tab_Hands', 'Tab_Friends'] },
          { path: 'Table', scale: 'fill', maxScale: 1.2 },
          { row: ['YourRankTag', 'YourRankLine'] },
          { path: 'Row_You', scale: 'fit', maxScale: 1 },
          { row: ['Btn_Prev', 'Page', 'Btn_Next'] },
          { row: ['InfoIcon', 'ResetInfo'] },
        ],
      },
    ],
  }),

  Tournaments_Browse: tournaments('Panel_Available', 'Panel_Selected'),
  Tournaments_MyTournaments: tournaments('Panel_List', 'Panel_Details'),
  Tournaments_Host: tournaments('Panel_Form', 'Panel_Summary'),
  Tournaments_JoinByCode: tournaments('Panel_Join', null),

  Agents_Overview: () => ({
    frame: true,
    pins: agentsTop,
    stacks: [
      {
        top: 250,
        bottom: 30,
        gap: 22,
        blocks: [
          { path: 'AgentHeader', scale: 'fit' },
          { row: ['Tabs/Tab_Overview', 'Tabs/Tab_Strategy', 'Tabs/Tab_SessionHistory'], scale: 'fit' },
          { path: 'Panel_YourAgent', scale: 'fit', maxScale: 1.15 },
          { path: 'Panel_SessionSetup', scale: 'fit', maxScale: 1.15 },
          { path: 'Panel_RecentPerformance', scale: 'fit' },
          { path: 'Btn_ReviewDeploy', resize: { h: 96, w: 1040 } },
        ],
      },
    ],
  }),

  Agents_Strategy: () => ({
    frame: true,
    pins: agentsTop,
    stacks: [
      {
        top: 250,
        bottom: 30,
        gap: 22,
        blocks: [
          { path: 'AgentHeader', scale: 'fit' },
          { row: ['Tabs/Tab_Overview', 'Tabs/Tab_Strategy', 'Tabs/Tab_SessionHistory'], scale: 'fit' },
          { path: 'Panel_Playstyle', scale: 'fit' },
          { path: 'Panel_Parameters', scale: 'fit' },
          { path: 'Btn_Reset', scale: 'fit', maxScale: 1.15 },
          { path: 'Btn_UseStrategy', scale: 'fit', maxScale: 1.15 },
        ],
      },
    ],
  }),

  Agents_SessionHistory: () => ({
    frame: true,
    pins: agentsTop,
    stacks: [
      {
        top: 250,
        bottom: 30,
        gap: 22,
        blocks: [
          { path: 'AgentHeader', scale: 'fit' },
          { row: ['Tabs/Tab_Overview', 'Tabs/Tab_Strategy', 'Tabs/Tab_SessionHistory'], scale: 'fit' },
          { path: 'Panel_Stats', scale: 'fit' },
          { path: 'Panel_History', scale: 'fill', maxScale: 1 },
        ],
      },
    ],
  }),

  LevelRewards: () => ({
    frame: true,
    stacks: [
      { top: 130, bottom: 20, blocks: [{ path: 'Content', resize: { h: 'rest', w: 1060 } }] },
      {
        in: 'Content',
        authoredW: 1440,
        top: 20,
        bottom: 20,
        gap: 24,
        blocks: [
          { path: 'Panel_Level', scale: 'fit', maxScale: 1 },
          { path: 'Panel_Track', scale: 'fit', maxScale: 1 },
          { row: ['MissionsTitle', 'Tab_Daily', 'Tab_Weekly'] },
          { path: 'Viewport', scale: 'fill', maxScale: 1 },
        ],
      },
    ],
  }),

  // The machine art sits in the middle ~900 units of the 1920-wide Content: keep it full size, the empty sides overflow.
  LuckySlot_Win: () => ({ stacks: [{ center: true, top: 140, bottom: 260, blocks: [{ path: 'Content', scale: 1.05 }] }] }),
  LuckySlot_Lost: () => ({ stacks: [{ center: true, top: 140, bottom: 260, blocks: [{ path: 'Content', scale: 1.05 }] }] }),

  /** NomadDialogs' modal layer: each window scales to fit the column (message boxes grow, Settings shrinks). */
  NomadMessage: (W, H) => ({ pins: centredPanelPins(dialogRoot, W, H, 1.25) }),
  Connecting: () => ({ stacks: [{ center: true, blocks: [{ path: 'Panel', scale: 'fit', maxScale: 1.5 }] }] }),

  /** PER table HUD (web3): the TEE/status strip spans the width under the table's top row; Verify opens wide. */
  PerTableHud: () => {
    const safeTop = safeArea().top / Math.max(0.05, dialogScale);
    return {
      pins: {
        Status: { anchorMin: [0.02, 1], anchorMax: [0.98, 1], pivot: [0.5, 1], pos: [0, -(150 + safeTop)], size: [0, 96] },
        Verify: { anchorMin: [0.03, 0.12], anchorMax: [0.97, 0.72], pivot: [0.5, 0.5], pos: [0, 0], size: [0, 0] },
      },
    };
  },
};
/** Render scale of the root being laid out (for safe-area conversions inside rules). */
let dialogScale = 1;

/** Screens without Frame169 whose stretched containers get the safe-area inset. */
const SCREENS_WITH_SAFE_INSET = new Set(['MainMenu', 'LuckySlot_Win', 'LuckySlot_Lost']);

let dialogRoot: UNode | null = null;

/**
 * Generic portrait for a dialog-style canvas: every centred, fixed-size node (anchors together at the middle) found
 * directly under the root or under its full-screen containers is scaled to fill the column (up to `max`).
 */
function centredPanelPins(root: UNode | null, W: number, H: number, max: number): Record<string, RectRule> {
  const pins: Record<string, RectRule> = {};
  const visit = (n: UNode, path: string, depth: number) => {
    for (const c of n.children) {
      const p = path ? `${path}/${c.name}` : c.name;
      const stretched = c.anchorMin[0] === 0 && c.anchorMin[1] === 0 && c.anchorMax[0] === 1 && c.anchorMax[1] === 1;
      if (stretched) {
        if (depth < 2) visit(c, p, depth + 1);
        continue;
      }
      const centred = c.anchorMin[0] === 0.5 && c.anchorMax[0] === 0.5 && c.anchorMin[1] === 0.5 && c.anchorMax[1] === 0.5;
      if (!centred || c.name.startsWith('BG')) continue;
      const a = root ? authored(root, c) : null;
      const size = a?.size ?? c.sizeDelta;
      if (size[0] < 200 || size[1] < 120) continue; // labels / icons, not panels
      const k = Math.min(max, (W - 40) / size[0], (H - 160) / size[1]);
      pins[p] = { scale: [k, k] };
    }
  };
  if (root) visit(root, '', 0);
  return pins;
}

// ---------------------------------------------------------------------------------------------------- engine

interface Saved {
  anchorMin: Vec2;
  anchorMax: Vec2;
  pivot: Vec2;
  pos: Vec2;
  size: Vec2;
  scale: Vec2;
}
const saved = new WeakMap<UNode, Map<UNode, Saved>>();

function remember(root: UNode, n: UNode): void {
  let m = saved.get(root);
  if (!m) saved.set(root, (m = new Map()));
  if (!m.has(n)) m.set(n, { anchorMin: [...n.anchorMin], anchorMax: [...n.anchorMax], pivot: [...n.pivot], pos: [...n.anchoredPosition], size: [...n.sizeDelta], scale: [...n.scale] });
}

function authored(root: UNode, n: UNode): Saved {
  return saved.get(root)?.get(n) ?? { anchorMin: [...n.anchorMin], anchorMax: [...n.anchorMax], pivot: [...n.pivot], pos: [...n.anchoredPosition], size: [...n.sizeDelta], scale: [...n.scale] };
}

function pin(root: UNode, n: UNode, r: RectRule): void {
  remember(root, n);
  const am = r.anchor ?? r.anchorMin;
  const aM = r.anchor ?? r.anchorMax;
  if (am) n.anchorMin = [...am];
  if (aM) n.anchorMax = [...aM];
  if (r.pivot) n.pivot = [...r.pivot];
  if (r.pos) n.anchoredPosition = [...r.pos];
  if (r.size) n.sizeDelta = [...r.size];
  if (r.scale) n.scale = [...r.scale];
}

/**
 * Called by the menu canvases (ScreenCanvas) before each layout pass with the root at its new canvas size. Applies
 * the root's portrait rule, or restores the authored rects in landscape.
 */
export function portraitMenuLayout(root: UNode, fallback: 'none' | 'panels' = 'none'): void {
  const rule = RULES[root.name] ?? (fallback === 'panels' ? (W: number, H: number) => ({ pins: centredPanelPins(root, W, H, 1.5) }) : undefined);
  if (!rule) return;
  if (!isPortrait()) {
    const m = saved.get(root);
    if (m) {
      for (const [n, s] of m) {
        n.anchorMin = [...s.anchorMin];
        n.anchorMax = [...s.anchorMax];
        n.pivot = [...s.pivot];
        n.anchoredPosition = [...s.pos];
        n.sizeDelta = [...s.size];
        n.scale = [...s.scale];
      }
      saved.delete(root);
    }
    return;
  }
  if (root.name === 'NomadMessage') dialogRoot = root;
  dialogScale = root.renderScale;
  const W = root.sizeDelta[0];
  const safe = safeArea();
  const sTop = safe.top / Math.max(0.05, root.renderScale);
  const sBottom = safe.bottom / Math.max(0.05, root.renderScale);
  const H = root.sizeDelta[1];
  const r = rule(W, H);
  const frame = r.frame ? root.find('Frame169') : null;
  const base = frame ?? root;
  const inset = (n: UNode) => pin(root, n, { anchorMin: [0, 0], anchorMax: [1, 1], pivot: [0.5, 0.5], pos: [0, -(sTop - sBottom) / 2], size: [0, -(sTop + sBottom)], scale: [1, 1] });
  if (frame) inset(frame);
  else if (SCREENS_WITH_SAFE_INSET.has(root.name)) {
    // Unframed screens: their full-screen containers (not the backgrounds) move inside the notch / home bar.
    for (const c of root.children) {
      const stretched = c.anchorMin[0] === 0 && c.anchorMin[1] === 0 && c.anchorMax[0] === 1 && c.anchorMax[1] === 1;
      if (stretched && !c.name.startsWith('BG') && !c.name.endsWith('ClickOutside')) inset(c);
    }
  }
  for (const [path, p] of Object.entries(r.pins ?? {})) {
    const n = base.find(path);
    if (n) pin(root, n, p);
  }
  const baseH = frame ? H - sTop - sBottom : H;
  // Stacks directly under an unframed root (Login panel, slot machine, dialogs) keep clear of the insets themselves.
  const own = !frame && !SCREENS_WITH_SAFE_INSET.has(root.name);
  for (const st of r.stacks ?? []) runStack(root, base, st, W, baseH, own ? sTop : 0, own ? sBottom : 0);
}

function natural(root: UNode, n: UNode, b: Block): Vec2 {
  if (b.size) return b.size;
  const a = authored(root, n);
  return [a.size[0], a.size[1]];
}

function runStack(root: UNode, base: UNode, st: Stack, rootW: number, rootH: number, sTop: number, sBottom: number): void {
  const container = st.in ? base.find(st.in) : base;
  if (!container) return;
  let W = rootW;
  let H = rootH;
  if (st.in) {
    // A container laid out by an earlier stack: its size is what that stack gave it.
    W = container.sizeDelta[0];
    H = container.sizeDelta[1];
  }
  const margin = st.margin ?? 20;
  const colW = W - 2 * margin;
  const top = (st.top ?? 40) + sTop;
  const bottom = (st.bottom ?? 40) + sBottom;
  const gap = st.gap ?? 24;
  const authoredW = st.authoredW ?? 1920;

  type Item = { nodes: UNode[]; xs: number[]; w: number; h: number; k: number; b: Block };
  const items: Item[] = [];
  for (const b of st.blocks) {
    if (b.row) {
      const nodes = b.row.map((p) => container.find(p)).filter((n): n is UNode => !!n);
      if (!nodes.length) continue;
      // Centre-relative x of each authored node (in the authored container width), then the row's extent.
      const xs = nodes.map((n) => {
        const a = authored(root, n);
        const w = a.size[0];
        return a.anchorMin[0] * authoredW + a.pos[0] + (0.5 - a.pivot[0]) * w - authoredW / 2;
      });
      const lo = Math.min(...nodes.map((n, i) => xs[i] - authored(root, n).size[0] / 2));
      const hi = Math.max(...nodes.map((n, i) => xs[i] + authored(root, n).size[0] / 2));
      const h = Math.max(...nodes.map((n) => authored(root, n).size[1]));
      items.push({ nodes, xs, w: hi - lo, h, k: 1, b });
      continue;
    }
    const n = b.path ? container.find(b.path) : null;
    if (!n) continue;
    const [w, h] = b.resize ? [b.resize.w ?? colW, typeof b.resize.h === 'number' ? b.resize.h : 0] : natural(root, n, b);
    items.push({ nodes: [n], xs: [b.x ?? 0], w, h, k: 1, b });
  }
  // Scales: fixed / fit first, then 'fill' and resize 'rest' share what is left.
  let used = 0;
  for (const it of items) {
    const s = it.b.scale;
    if (it.b.resize) it.k = 1;
    else if (typeof s === 'number') it.k = s;
    else if (s === 'fit' || it.b.row) it.k = Math.min(it.b.maxScale ?? 1, colW / Math.max(1, it.w));
    else if (s !== 'fill') it.k = 1;
    if (s !== 'fill' && !(it.b.resize && it.b.resize.h === 'rest')) used += it.h * it.k;
    used += it.b.gap ?? gap;
  }
  used -= items.length ? (items[items.length - 1].b.gap ?? gap) : 0;
  const avail = H - top - bottom;
  const fills = items.filter((it) => it.b.scale === 'fill' || (it.b.resize && it.b.resize.h === 'rest'));
  const left = Math.max(0, avail - used);
  for (const it of fills) {
    if (it.b.resize) it.h = left / fills.length;
    else it.k = Math.min(it.b.maxScale ?? 1, colW / Math.max(1, it.w), left / fills.length / Math.max(1, it.h));
  }
  let total = items.reduce((t, it, i) => t + it.h * it.k + (i < items.length - 1 ? (it.b.gap ?? gap) : 0), 0);
  // Too tall: shrink everything (never clip a row off the screen).
  const shrink = total > avail ? avail / total : 1;
  total *= shrink;
  let y = top + (st.center ? Math.max(0, (avail - total) / 2) : 0);
  for (const it of items) {
    const k = it.k * shrink;
    it.nodes.forEach((n, i) => {
      if (it.b.resize) {
        pin(root, n, { anchor: [0.5, 1], pivot: [0.5, 1], pos: [0, -y], size: [it.w, it.h * shrink], scale: [1, 1] });
        return;
      }
      const x = it.b.row ? it.xs[i] * k : it.xs[i];
      const a = authored(root, n);
      // Row members keep their own height, centred on the row's line.
      const dy = it.b.row ? ((it.h - a.size[1]) / 2) * k : 0;
      pin(root, n, { anchor: [0.5, 1], pivot: [0.5, 1], pos: [x, -(y + dy)], size: it.b.size ?? (it.b.row ? a.size : undefined), scale: [k, k] });
    });
    y += it.h * k + (it.b.gap ?? gap) * shrink;
  }
}

/**
 * Overlay canvases outside the menu (retention, economy) with a 1920×1080 CanvasScaler: in portrait they use the
 * same 1080×1920 Expand reference as the menu (centred panels then fit the column). null = keep the Unity formula.
 */
export function portraitScaleFor(ref: readonly number[], w: number, h: number): number | null {
  if (!isPortrait() || ref[0] !== 1920 || ref[1] !== 1080) return null;
  return Math.min(w / MENU_PORTRAIT_REF[0], h / MENU_PORTRAIT_REF[1]);
}
