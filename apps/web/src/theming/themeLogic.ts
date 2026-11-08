/**
 * Pure ports of the decision logic in Game/Theming (ThemeManager, ThemeBackgroundFitter) and
 * Game/Stakes/StakeTableSkin.cs. No DOM, no three.js — unit tested in __tests__/themeLogic.test.ts.
 */
import { StakeCatalog, type StakeTier } from '@nomad/engine/stakes/stakes';
import { formatN0 } from '@nomad/engine/util/dotnetMath';
import type { RGBA } from '../hud/unityUi';

export type ThemeName = 'Default' | 'Neon_City' | 'Forest' | 'Desert' | 'Town';
export const THEME_ENUM: readonly ThemeName[] = ['Default', 'Neon_City', 'Forest', 'Desert', 'Town'];

// ---------------------------------------------------------------- saved pick (ThemeManager.Awake)

/** `PlayerPrefs.GetInt(PrefKey, (int)defaultTheme)` → Enum.IsDefined ? (Theme)saved : defaultTheme. */
export function resolveSavedTheme(saved: number, fallback: ThemeName): ThemeName {
  return Number.isInteger(saved) && saved >= 0 && saved < THEME_ENUM.length ? THEME_ENUM[saved]! : fallback;
}

export const themeIndex = (t: ThemeName): number => THEME_ENUM.indexOf(t);

// ---------------------------------------------------------------- player pick vs stake skin (ThemeManager)

/**
 * The SetTheme / ApplyTableSkin / RestorePlayerTheme state machine: a stake-skinned table changes what is shown
 * without overwriting the player's saved pick, and leaving the table puts the pick back.
 */
export class ThemeSelection {
  current: ThemeName;
  private player: ThemeName;
  private tableSkinActive = false;

  constructor(initial: ThemeName) {
    this.current = initial;
    this.player = initial;
  }

  get playerTheme(): ThemeName {
    return this.player;
  }

  get isTableSkinActive(): boolean {
    return this.tableSkinActive;
  }

  /** SetTheme: returns the theme to persist + apply. */
  setTheme(theme: ThemeName): ThemeName {
    this.tableSkinActive = false;
    this.player = theme;
    this.current = theme;
    return theme;
  }

  /** ApplyTableSkin: remembers the pick (first time only), shows `theme`. */
  applyTableSkin(theme: ThemeName): ThemeName {
    if (!this.tableSkinActive) this.player = this.current;
    this.tableSkinActive = true;
    this.current = theme;
    return theme;
  }

  /** RestorePlayerTheme: null when no table skin was active (nothing to do). */
  restorePlayerTheme(): ThemeName | null {
    if (!this.tableSkinActive) return null;
    this.tableSkinActive = false;
    this.current = this.player;
    return this.player;
  }
}

// ---------------------------------------------------------------- colours (ThemeManager helpers)

export const WHITE: RGBA = { r: 1, g: 1, b: 1, a: 1 };
const luminance = (c: RGBA) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** UnityEngine.Color.RGBToHSV. */
export function rgbToHsv(c: RGBA): [number, number, number] {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === c.r) h = ((c.g - c.b) / d) / 6;
    else if (max === c.g) h = (2 + (c.b - c.r) / d) / 6;
    else h = (4 + (c.r - c.g) / d) / 6;
    if (h < 0) h += 1;
  }
  return [h, max > 0 ? d / max : 0, max];
}

/** UnityEngine.Color.HSVToRGB (hdr false). Alpha 1. */
export function hsvToRgb(h: number, s: number, v: number): RGBA {
  if (s === 0) return { r: v, g: v, b: v, a: 1 };
  const h6 = (h - Math.floor(h)) * 6;
  const i = Math.floor(h6);
  const f = h6 - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6]!;
  return { r, g, b, a: 1 };
}

export interface PackColors {
  theme: ThemeName;
  buttonLabelColor: RGBA;
  accentColor: RGBA;
  panelColor: RGBA;
  hasPanelPlate: boolean;
}

/** ThemeManager.ValueBorderColor: ConfirmPanel's 04.png rim — dark labels read as an outline, else a darkened accent. */
export function valueBorderColor(pack: PackColors): RGBA {
  const label = pack.buttonLabelColor;
  if (label.a > 0.01 && luminance(label) < 0.55) return label;
  const [h, s, v] = rgbToHsv(pack.accentColor);
  return hsvToRgb(h, clamp01(s * 1.15), v * 0.55);
}

/** Color.Lerp(accent, white, 0.62) — soft panel / header fill. */
export function lightPanelColor(accent: RGBA): RGBA {
  const t = 0.62;
  return { r: accent.r + (1 - accent.r) * t, g: accent.g + (1 - accent.g) * t, b: accent.b + (1 - accent.b) * t, a: accent.a + (1 - accent.a) * t };
}

/** ThemeManager.PanelColor: party / wallet panel + header fill. */
export function panelColor(pack: PackColors): RGBA {
  if (pack.theme === 'Neon_City') return WHITE;
  if (pack.panelColor.a > 0.01) return pack.panelColor;
  return lightPanelColor(pack.accentColor);
}

/** ThemeManager.ButtonPlateColor: menu-card CTA plate tint. */
export function buttonPlateColor(pack: PackColors): RGBA {
  if (pack.theme === 'Neon_City') return pack.panelColor.a > 0.01 ? pack.panelColor : pack.accentColor;
  if (pack.hasPanelPlate) return WHITE;
  return pack.accentColor;
}

/** ThemeManager.ContrastingLabelOn: white on dark plates, the preferred label on light ones. */
export function contrastingLabelOn(background: RGBA, preferred: RGBA): RGBA {
  return luminance(background) < 0.55 ? WHITE : preferred;
}

/** ThemeManager.IsTintableSprite: white Circle art takes the accent; pre-coloured xxx_ / pot plates stay white. */
export function isTintableSpriteName(name: string | null | undefined): boolean {
  if (!name) return true;
  if (name.toLowerCase() === 'circle') return true;
  if (name.toLowerCase().startsWith('xxx_')) return false;
  if (name.toLowerCase().startsWith('pot')) return false;
  return true;
}

// ---------------------------------------------------------------- layout (ThemeBackgroundFitter.FitCover)

/** Size that covers the parent without stretching (centred, pivot 0.5). Null when either size is degenerate. */
export function fitCover(spriteW: number, spriteH: number, parentW: number, parentH: number): [number, number] | null {
  if (parentW < 1 || parentH < 1 || spriteW < 1 || spriteH < 1) return null;
  return spriteW / spriteH >= parentW / parentH ? [spriteW * (parentH / spriteH), parentH] : [parentW, spriteH * (parentW / spriteW)];
}

// ---------------------------------------------------------------- StakeTableSkin

/** StakeTableSkin.ThemeFor: entry tables stay basic, higher stakes get premium looks. */
export function themeForStake(minBuyIn: number): ThemeName {
  if (minBuyIn >= 5000) return 'Neon_City';
  if (minBuyIn >= 1000) return 'Desert';
  if (minBuyIn >= 500) return 'Town';
  if (minBuyIn >= 100) return 'Forest';
  return 'Default';
}

/** StakeTableSkin.StakesFor: the stake tiers that sit at this table look. */
export function stakesForTheme(theme: ThemeName): StakeTier[] {
  switch (theme) {
    case 'Default':
      return [StakeCatalog.get(50)];
    case 'Forest':
      return [StakeCatalog.get(100)];
    case 'Town':
      return [StakeCatalog.get(500)];
    case 'Desert':
      return [StakeCatalog.get(1000)];
    case 'Neon_City':
      return [StakeCatalog.get(5000), StakeCatalog.get(10000)];
    default:
      return [StakeCatalog.Default];
  }
}

/** StakeTableSkin.PrimaryMinBuyIn: the lowest stake using this look. */
export function primaryMinBuyIn(theme: ThemeName): number {
  return stakesForTheme(theme)[0]?.minBuyIn ?? StakeCatalog.DefaultMinBuyIn;
}

export function canAffordTheme(theme: ThemeName, coins: number): boolean {
  return coins >= primaryMinBuyIn(theme);
}

/** StakeTableSkin.CompactBuyIn: 5000 → "5K", 500 → "500". */
export function compactBuyIn(amount: number): string {
  return amount >= 1000 ? `${Math.trunc(amount / 1000)}K` : formatN0(amount);
}

/** StakeTableSkin.StakeCaption: "Micro · 50\n1 / 2" (multi-stake tables get a trailing +). */
export function stakeCaption(theme: ThemeName): string {
  const stakes = stakesForTheme(theme);
  if (!stakes.length) return '';
  const t = stakes[0]!;
  let buyIn = compactBuyIn(t.minBuyIn);
  if (stakes.length > 1) buyIn += '+';
  return `${t.displayName} · ${buyIn}\n${t.blindsLabel}`;
}

/** StakeTableSkin.SelectThemeTable's pick: the highest stake on this table the player can afford, else its entry stake. */
export function pickStakeForTheme(theme: ThemeName, coins: number): StakeTier {
  const stakes = stakesForTheme(theme);
  let pick = stakes[0]!;
  for (const s of stakes) if (coins >= s.minBuyIn) pick = s;
  return pick;
}

/** ThemePicker.SelectedTableTheme: a chosen (known) stake decides the look, else the current theme. */
export function selectedTableTheme(selectedMinBuyIn: number, current: ThemeName): ThemeName {
  if (selectedMinBuyIn > 0 && StakeCatalog.isKnown(selectedMinBuyIn)) return themeForStake(selectedMinBuyIn);
  return current;
}

/** Tables picker card order (ThemePicker.BindCards): cheapest table to most expensive. Stable for ties. */
export function sortThemesByStake<T extends { theme: ThemeName }>(cards: readonly T[]): T[] {
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => primaryMinBuyIn(a.c.theme) - primaryMinBuyIn(b.c.theme) || a.i - b.i)
    .map((x) => x.c);
}

/** ThemePicker.ResolvePackIndex: match a card's authored label to a pack (display name, enum name, enum with spaces). */
export function resolvePackIndex(label: string | null, packs: readonly { theme: ThemeName; displayName: string }[], used: boolean[]): number {
  if (label) {
    const first = label.split('\n')[0]!;
    const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    for (let i = 0; i < packs.length; i++) {
      if (used[i]) continue;
      const p = packs[i]!;
      if (eq(p.displayName, first) || eq(p.theme, first) || eq(p.theme.replace(/_/g, ' '), first)) return i;
    }
  }
  return used.findIndex((u) => !u);
}
