/**
 * Port of Game/Theming/ThemeManager.cs as an app service (ctx.services.theme).
 *
 * The player's pick is saved in PlayerPrefs under the C# key ("Poker.ActiveTheme", the Theme enum index) and
 * re-applied at boot. A stake-skinned table (StakeTableSkin.ApplyForStake → ApplyTableSkin) shows another pack
 * without overwriting the pick; RestorePlayerTheme puts it back when leaving the table.
 *
 * Every apply emits 'theme:changed' on ctx.events (payload ThemeChange) — the web counterpart of
 * ThemeManager.ThemeApplied. Whatever shows themed art listens to it: the table (bindThemeToTable), the
 * HUD, menu graphics (bindThemedGraphic / themedColor / themedSprite), the picker.
 */
import type { EventBus } from '../app/app';
import { PlayerPrefs } from '../app/services';
import type { RGBA } from '../hud/unityUi';
import type { HudThemePack } from '../hud/hudTheme';
import { DEFAULT_THEME, PACKS, THEMES, THEME_PREF_KEY, getPack, spriteFor, spriteUrl, type ThemeId, type ThemePack, type ThemeSlot, type ThemeSpriteData } from './themeData';
import {
  ThemeSelection,
  buttonPlateColor,
  contrastingLabelOn,
  lightPanelColor,
  panelColor,
  resolveSavedTheme,
  themeForStake,
  themeIndex,
  valueBorderColor,
  WHITE,
} from './themeLogic';

export type ThemeChangeReason = 'boot' | 'player' | 'table-skin' | 'restore';

export interface ThemeChange {
  readonly theme: ThemeId;
  readonly pack: ThemePack;
  readonly reason: ThemeChangeReason;
}

/** Named theme colours for menu / HUD code (all from ThemeManager's helpers). */
export type ThemeColorKey =
  | 'label' // pack.buttonLabelColor (ThemeManager.LabelColor)
  | 'accent' // pack.accentColor
  | 'panel' // ThemeManager.PanelColor (party / wallet panels, MenuHeader)
  | 'lightPanel' // LightPanelColor(accent)
  | 'buttonPlate' // ThemeManager.ButtonPlateColor (menu-card CTAs)
  | 'buttonPlateLabel' // ContrastingLabelOn(ButtonPlateColor, label)
  | 'valueBorder' // ThemeManager.ValueBorderColor
  | 'white';

export const THEME_CHANGED = 'theme:changed';

export class ThemeService {
  private readonly sel: ThemeSelection;

  constructor(private readonly events: EventBus) {
    const saved = PlayerPrefs.getInt(THEME_PREF_KEY, themeIndex(DEFAULT_THEME));
    this.sel = new ThemeSelection(resolveSavedTheme(saved, DEFAULT_THEME));
  }

  /** Theme enum values in order. */
  readonly themes: readonly ThemeId[] = THEMES;
  /** ThemeLibrary.Packs. */
  readonly packs: readonly ThemePack[] = PACKS;

  /** ThemeManager.CurrentTheme: what is shown now (the pick, or a stake table skin). */
  get current(): ThemeId {
    return this.sel.current;
  }

  /** The player's saved pick (differs from `current` while a stake table skin is active). */
  get playerTheme(): ThemeId {
    return this.sel.playerTheme;
  }

  get tableSkinActive(): boolean {
    return this.sel.isTableSkinActive;
  }

  /** The pack shown now. */
  get pack(): ThemePack {
    return getPack(this.sel.current);
  }

  getPack(theme: ThemeId): ThemePack {
    return getPack(theme);
  }

  /** ThemeManager.LabelColor. */
  get labelColor(): RGBA {
    return this.pack.buttonLabelColor;
  }

  /** ThemeManager.SetTheme: switch, save (PlayerPrefs, C# key + enum index), re-skin. */
  setTheme(theme: ThemeId): void {
    this.sel.setTheme(theme);
    PlayerPrefs.setInt(THEME_PREF_KEY, themeIndex(theme));
    this.emit('player');
  }

  /** ThemeManager.ApplyTableSkin: stake-based table look; the saved pick is kept. */
  applyTableSkin(theme: ThemeId): void {
    this.sel.applyTableSkin(theme);
    this.emit('table-skin');
  }

  /** StakeTableSkin.ApplyForStake: skins free-play tables by stake; money (SOL) tables keep the player's look. */
  applyTableSkinForStake(minBuyIn: number, moneyTable = false): void {
    if (moneyTable) return;
    this.applyTableSkin(themeForStake(minBuyIn));
  }

  /** ThemeManager.RestorePlayerTheme (StakeTableSkin.RestoreMenuTheme): back to the pick after a skinned table. */
  restorePlayerTheme(): void {
    if (this.sel.restorePlayerTheme() !== null) this.emit('restore');
  }

  /** Re-announces the current pack (ThemeManager.Apply on scene load) — e.g. after new themed UI was built. */
  reapply(): void {
    this.emit('boot');
  }

  /** Subscribes to 'theme:changed'. Returns an unsubscribe function. */
  onChanged(fn: (change: ThemeChange) => void): () => void {
    return this.events.on<ThemeChange>(THEME_CHANGED, fn);
  }

  /** A themed colour of the current (or given) pack. */
  color(key: ThemeColorKey, pack: ThemePack = this.pack): RGBA {
    switch (key) {
      case 'label':
        return pack.buttonLabelColor;
      case 'accent':
        return pack.accentColor;
      case 'panel':
        return panelColor(pack);
      case 'lightPanel':
        return lightPanelColor(pack.accentColor);
      case 'buttonPlate':
        return buttonPlateColor(pack);
      case 'buttonPlateLabel':
        return contrastingLabelOn(buttonPlateColor(pack), pack.buttonLabelColor);
      case 'valueBorder':
        return valueBorderColor(pack);
      case 'white':
        return WHITE;
    }
  }

  /** The current (or given) pack's sprite for a ThemedGraphic slot. */
  sprite(slot: ThemeSlot, pack: ThemePack = this.pack): ThemeSpriteData | null {
    return spriteFor(pack, slot);
  }

  /** URL of that sprite's file. */
  spriteUrl(slot: ThemeSlot, pack: ThemePack = this.pack): string | null {
    return spriteUrl(spriteFor(pack, slot));
  }

  /** The pack values the table HUD needs (hudTheme.ts). */
  hudPack(pack: ThemePack = this.pack): HudThemePack {
    return {
      pot: pack.art.pot!,
      menuButton: pack.art.menuButton!,
      menuButtonType: pack.menuButtonType,
      label: pack.buttonLabelColor,
      accent: pack.accentColor,
      valueBorder: valueBorderColor(pack),
    };
  }

  private emit(reason: ThemeChangeReason): void {
    const change: ThemeChange = { theme: this.sel.current, pack: this.pack, reason };
    this.events.emit(THEME_CHANGED, change);
  }
}

declare module '../app/app' {
  interface Services {
    /** ThemeManager port — set by the theming module's install (first module, so always present after boot). */
    theme?: ThemeService;
  }
}
