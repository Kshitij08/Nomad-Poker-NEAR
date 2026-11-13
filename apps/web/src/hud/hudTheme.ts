/**
 * THEME HOOK (theming module) for the uGUI → DOM layer.
 *
 * unity-hud.json bakes ThemeManager's overrides for the default pack (SOLANA) into every node as `themeDefault`.
 * Those overrides only ever use a handful of pack values: the pot capsule and menuButton frame sprites, the label
 * colour, the accent colour (alpha kept) and ConfirmPanel's ValueBorderColor. buildNode() records which of them a
 * node used (its `themeSlots`), so the theming module can re-skin an already built tree with another pack
 * (`applyHudThemeToTree`) — the same thing ThemeManager.Apply does when the player picks a theme.
 *
 * Nothing here changes the HUD until a theme is applied: with no active pack the baked SOLANA values stay.
 */
import type { RGBA, SpriteData, UNode } from './unityUi';

export type HudColorSlot = 'label' | 'accent' | 'valueBorder';

/** Which pack values a node's themeDefault came from. */
export interface NodeThemeSlots {
  sprite?: 'pot' | 'menuButton';
  imageColor?: HudColorSlot;
  /** Alpha the themed image colour keeps (TintKeepAlpha) — taken from the baked value. */
  imageAlpha?: number;
  textColor?: 'label';
  textAlpha?: number;
}

/** The pack values the HUD needs (built by the theming module from theming-themes.json). */
export interface HudThemePack {
  pot: SpriteData;
  menuButton: SpriteData;
  menuButtonType: string;
  label: RGBA;
  accent: RGBA;
  /** ThemeManager.ValueBorderColor(pack). */
  valueBorder: RGBA;
}

/** The default pack's keys/colours, to recognise what a baked themeDefault value came from. */
export interface DefaultThemeKeys {
  pot: string;
  menuButton: string;
  label: RGBA;
  accent: RGBA;
}

interface BakedThemeDefault {
  rules?: string[];
  image?: { sprite?: string; color?: { rgba: [number, number, number, number] } };
  text?: { color?: { rgba: [number, number, number, number] } };
}

const sameRgb = (c: [number, number, number, number], k: RGBA) =>
  Math.abs(c[0] - k.r) < 0.002 && Math.abs(c[1] - k.g) < 0.002 && Math.abs(c[2] - k.b) < 0.002;

/** Maps a node's baked default-pack override back to the pack slots it used (null = nothing pack-dependent). */
export function classifyThemeDefault(td: BakedThemeDefault | undefined, def: DefaultThemeKeys): NodeThemeSlots | null {
  if (!td) return null;
  const out: NodeThemeSlots = {};
  const im = td.image;
  if (im?.sprite === def.pot) out.sprite = 'pot';
  else if (im?.sprite === def.menuButton) out.sprite = 'menuButton';
  if (im?.color) {
    const c = im.color.rgba;
    if ((td.rules ?? []).some((r) => r.includes('ValueBorderColor'))) out.imageColor = 'valueBorder';
    else if (sameRgb(c, def.accent)) out.imageColor = 'accent';
    else if (sameRgb(c, def.label)) out.imageColor = 'label';
    if (out.imageColor) out.imageAlpha = c[3];
  }
  const tc = td.text?.color?.rgba;
  if (tc && sameRgb(tc, def.label)) {
    out.textColor = 'label';
    out.textAlpha = tc[3];
  }
  return Object.keys(out).length ? out : null;
}

let active: HudThemePack | null = null;

/**
 * Redesign v2: one purple HUD skin on every table (docs/ui-style-guide.md). The room's scene (felt, backdrop, card
 * backs) still follows the theme; the HUD plates and buttons no longer take the pack's sprites and colours.
 */
export const hudSkin = { v2: true };

/** The pack buildNode() applies to newly built nodes (null = keep the baked default). */
export function getActiveHudTheme(): HudThemePack | null {
  return hudSkin.v2 ? null : active;
}

export function setActiveHudTheme(pack: HudThemePack | null): void {
  active = pack;
}

/** Applies a pack to one node's recorded slots (no layout). */
export function applyThemeSlots(n: UNode, pack: HudThemePack): void {
  const s = n.themeSlots;
  if (!s) return;
  if (n.image) {
    if (s.sprite === 'pot') {
      n.image.sprite = pack.pot;
      n.image.type = 'Sliced';
    } else if (s.sprite === 'menuButton') {
      n.image.sprite = pack.menuButton;
      n.image.type = pack.menuButtonType;
    }
    if (s.imageColor) n.image.color = { ...pack[s.imageColor], a: s.imageAlpha ?? 1 };
  }
  if (n.text && s.textColor) n.text.color = { ...pack.label, a: s.textAlpha ?? 1 };
}

/**
 * Every live node built with pack-dependent overrides — whoever built it (the stage HUD, the menu's table chrome,
 * chat…). ThemeManager.Apply re-skins everything in the loaded scenes, so a theme change reaches them all.
 */
const themedNodes = new Set<WeakRef<UNode>>();

/** buildNode() registers nodes that have theme slots. */
export function trackThemedNode(n: UNode): void {
  themedNodes.add(new WeakRef(n));
}

/** ThemeManager.Apply over the HUD layer: re-skins every tracked node with `pack` and re-renders it. */
export function applyHudThemeEverywhere(pack: HudThemePack): void {
  active = pack;
  if (hudSkin.v2) return;
  for (const ref of themedNodes) {
    const n = ref.deref();
    if (!n) {
      themedNodes.delete(ref);
      continue;
    }
    applyThemeSlots(n, pack);
    n.render();
  }
}

/** Re-skins every themed node under `root` with `pack`, then re-renders it. */
export function applyHudThemeToTree(root: UNode, pack: HudThemePack): void {
  if (hudSkin.v2) return;
  let any = false;
  for (const n of root.walk()) {
    if (!n.themeSlots) continue;
    applyThemeSlots(n, pack);
    any = true;
  }
  if (any) root.layout();
}
