/**
 * Typed access to data/theming-themes.json (tools/extract-unity-themes.mjs): the ThemeLibrary packs
 * (Assets/Resources/ThemeLibrary.asset), the Theme enum, and the art per ThemeSlot.
 */
import themeJson from '../data/theming-themes.json';
import { THEME_ENUM, type ThemeName } from './themeLogic';
import { HUD_DATA, assetUrl, type NodeData, type FontData, type SpriteData, type RGBA } from '../hud/unityUi';

/** Poker.Game.Theme. PlayerPrefs stores the enum index, so the order is fixed. */
export const THEMES = THEME_ENUM;
export type ThemeId = ThemeName;

/** Poker.Game.ThemeSlot (ThemedGraphic) — plus the pack fields the C# reads directly. */
export type ThemeSlot =
  | 'MenuBackground'
  | 'MenuButton'
  | 'TableBackground'
  | 'Board'
  | 'CardBack'
  | 'CardBackFolded'
  | 'Pot'
  | 'Preview'
  | 'ToggleTrack'
  | 'PanelPlate';

interface ColorJson {
  hex: string;
  rgba: [number, number, number, number];
}
interface PackJson {
  theme: string;
  index: number;
  displayName: string;
  menuButtonType: string;
  buttonLabelColor: ColorJson;
  accentColor: ColorJson;
  panelColor: ColorJson;
  art: Record<string, string | null>;
  hudSprites: { pot: string | null; menuButton: string | null };
}
export interface ThemeSpriteData extends SpriteData {
  unity?: string;
  note?: string;
}
interface ThemeJson {
  enum: string[];
  defaultTheme: string;
  prefKey: string;
  packs: PackJson[];
  sprites: Record<string, ThemeSpriteData>;
  fonts: Record<string, FontData & { file?: string }>;
  picker: {
    canvas: { scaler: { referenceResolution: [number, number]; matchWidthOrHeight: number } } | null;
    parents: { name: string; anchorMin: [number, number]; anchorMax: [number, number]; sizeDelta: [number, number]; anchoredPosition: [number, number] }[];
    root: NodeData;
    dockCloseSprite: string | null;
  };
}

export const THEME_DATA = themeJson as unknown as ThemeJson;

const rgba = (c: ColorJson): RGBA => ({ r: c.rgba[0], g: c.rgba[1], b: c.rgba[2], a: c.rgba[3] });

/** One ThemeLibrary.Pack. */
export interface ThemePack {
  readonly theme: ThemeId;
  readonly index: number;
  readonly displayName: string;
  readonly menuButtonType: string;
  readonly buttonLabelColor: RGBA;
  readonly accentColor: RGBA;
  /** Alpha 0 = "use a lightened accent" (ThemeManager.PanelColor). */
  readonly panelColor: RGBA;
  /** ThemeLibrary.Pack.panelPlate is set (none of the shipped packs set it). */
  readonly hasPanelPlate: boolean;
  /** Art per field (preview, menuButton, toggleTrack, tableBackground, board, cardBack, cardBackFolded, pot, panelPlate). */
  readonly art: Readonly<Record<string, ThemeSpriteData | null>>;
}

function spriteOf(key: string | null | undefined, preferHud: boolean): ThemeSpriteData | null {
  if (!key) return null;
  if (preferHud && HUD_DATA.sprites[key]) return HUD_DATA.sprites[key] as ThemeSpriteData;
  return THEME_DATA.sprites[key] ?? (HUD_DATA.sprites[key] as ThemeSpriteData | undefined) ?? null;
}

export const PACKS: readonly ThemePack[] = THEME_DATA.packs.map((p) => {
  const art: Record<string, ThemeSpriteData | null> = {};
  for (const [k, key] of Object.entries(p.art)) art[k] = spriteOf(key, k === 'pot' || k === 'menuButton');
  return Object.freeze({
    theme: p.theme as ThemeId,
    index: p.index,
    displayName: p.displayName || p.theme,
    menuButtonType: p.menuButtonType,
    buttonLabelColor: rgba(p.buttonLabelColor),
    accentColor: rgba(p.accentColor),
    panelColor: rgba(p.panelColor),
    hasPanelPlate: !!p.art.panelPlate,
    art: Object.freeze(art),
  });
});

export const DEFAULT_THEME: ThemeId = (THEME_DATA.defaultTheme as ThemeId) ?? 'Default';
/** ThemeManager.PrefKey. */
export const THEME_PREF_KEY = THEME_DATA.prefKey || 'Poker.ActiveTheme';

/** ThemeLibrary.Get: the pack for `theme`, else the first pack. */
export function getPack(theme: ThemeId): ThemePack {
  return PACKS.find((p) => p.theme === theme) ?? PACKS[0]!;
}

/** ThemeLibrary.SpriteFor (+ ToggleTrack / PanelPlate, which the C# reads straight off the pack). */
export function spriteFor(pack: ThemePack, slot: ThemeSlot): ThemeSpriteData | null {
  switch (slot) {
    case 'MenuBackground':
    case 'Preview':
      return pack.art.preview ?? null;
    case 'MenuButton':
      return pack.art.menuButton ?? null;
    case 'TableBackground':
      return pack.art.tableBackground ?? null;
    case 'Board':
      return pack.art.board ?? null;
    case 'CardBack':
      return pack.art.cardBack ?? null;
    case 'CardBackFolded':
      return pack.art.cardBackFolded ?? null;
    case 'Pot':
      return pack.art.pot ?? null;
    case 'ToggleTrack':
      return pack.art.toggleTrack ?? null;
    case 'PanelPlate':
      return pack.art.panelPlate ?? null;
  }
}

/** URL of a sprite's exported file (null when it has none). */
export function spriteUrl(s: ThemeSpriteData | null | undefined): string | null {
  return s?.file ? assetUrl(s.file) : null;
}
