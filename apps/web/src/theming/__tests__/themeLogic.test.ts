import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ThemeSelection,
  buttonPlateColor,
  compactBuyIn,
  contrastingLabelOn,
  fitCover,
  hsvToRgb,
  lightPanelColor,
  panelColor,
  pickStakeForTheme,
  primaryMinBuyIn,
  resolvePackIndex,
  resolveSavedTheme,
  rgbToHsv,
  selectedTableTheme,
  sortThemesByStake,
  stakeCaption,
  themeForStake,
  valueBorderColor,
  type PackColors,
  type ThemeName,
} from '../themeLogic';
import { classifyThemeDefault } from '../../hud/hudTheme';
import { DEFAULT_THEME, PACKS, THEME_PREF_KEY, THEMES, getPack, spriteFor } from '../themeData';

const c = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });
const near = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, eps = 1e-3) => {
  expect(a.r).toBeCloseTo(b.r, 3);
  expect(a.g).toBeCloseTo(b.g, 3);
  expect(a.b).toBeCloseTo(b.b, 3);
  void eps;
};
const pack = (theme: ThemeName, label: ReturnType<typeof c>, accent: ReturnType<typeof c>, panel = c(0, 0, 0, 0)): PackColors => ({
  theme,
  buttonLabelColor: label,
  accentColor: accent,
  panelColor: panel,
  hasPanelPlate: false,
});
// Values from Assets/Resources/ThemeLibrary.asset
const SOLANA = pack('Default', c(0.011764706, 0.09019608, 0.2901961), c(0.12156863, 0.45882353, 0.6666667));
const NEON = pack('Neon_City', c(1, 1, 1), c(1, 0.7019608, 1), c(1, 0.7019608, 1));
const FOREST = pack('Forest', c(1, 1, 1), c(0.21568628, 0.4509804, 0.6156863));

describe('ThemeManager colour helpers', () => {
  it('ValueBorderColor: dark labels are the rim, white-label packs darken the accent', () => {
    near(valueBorderColor(SOLANA), SOLANA.buttonLabelColor);
    // Neon accent #FFB3FF: H 5/6, S .298 → S×1.15, V×.55
    near(valueBorderColor(NEON), c(0.55, 0.55 * (1 - 0.298 * 1.15), 0.55));
    const [h, s, v] = rgbToHsv(FOREST.accentColor);
    near(valueBorderColor(FOREST), hsvToRgb(h, Math.min(1, s * 1.15), v * 0.55));
  });

  it('RGB ↔ HSV round-trips like UnityEngine.Color', () => {
    for (const col of [SOLANA.accentColor, NEON.accentColor, FOREST.accentColor, c(0.3, 0.3, 0.3), c(1, 0, 0)]) {
      const [h, s, v] = rgbToHsv(col);
      near(hsvToRgb(h, s, v), col);
    }
    expect(rgbToHsv(c(1, 0.7019608, 1))[0]).toBeCloseTo(5 / 6, 4);
  });

  it('PanelColor / ButtonPlateColor / ContrastingLabelOn', () => {
    near(panelColor(NEON), c(1, 1, 1));
    near(panelColor(SOLANA), lightPanelColor(SOLANA.accentColor));
    near(lightPanelColor(c(0, 0, 0)), c(0.62, 0.62, 0.62));
    near(buttonPlateColor(NEON), NEON.panelColor);
    near(buttonPlateColor(SOLANA), SOLANA.accentColor);
    near(buttonPlateColor({ ...SOLANA, hasPanelPlate: true }), c(1, 1, 1));
    near(contrastingLabelOn(SOLANA.accentColor, SOLANA.buttonLabelColor), c(1, 1, 1));
    near(contrastingLabelOn(c(1, 0.7, 1), SOLANA.buttonLabelColor), SOLANA.buttonLabelColor);
  });
});

describe('ThemeManager pick vs stake table skin', () => {
  it('SetTheme / ApplyTableSkin / RestorePlayerTheme', () => {
    const s = new ThemeSelection('Forest');
    expect(s.restorePlayerTheme()).toBeNull(); // nothing to restore
    s.applyTableSkin('Neon_City');
    expect(s.current).toBe('Neon_City');
    expect(s.playerTheme).toBe('Forest');
    s.applyTableSkin('Desert'); // a second skin keeps the original pick
    expect(s.playerTheme).toBe('Forest');
    expect(s.restorePlayerTheme()).toBe('Forest');
    expect(s.current).toBe('Forest');
    s.applyTableSkin('Town');
    s.setTheme('Desert'); // picking while skinned ends the skin
    expect(s.isTableSkinActive).toBe(false);
    expect(s.restorePlayerTheme()).toBeNull();
    expect(s.current).toBe('Desert');
  });

  it('saved PlayerPrefs value: Enum.IsDefined or the default', () => {
    expect(resolveSavedTheme(2, 'Default')).toBe('Forest');
    expect(resolveSavedTheme(4, 'Default')).toBe('Town');
    expect(resolveSavedTheme(5, 'Default')).toBe('Default');
    expect(resolveSavedTheme(-1, 'Neon_City')).toBe('Neon_City');
    expect(resolveSavedTheme(Number.NaN, 'Default')).toBe('Default');
  });
});

describe('StakeTableSkin', () => {
  it('ThemeFor maps buy-ins to looks', () => {
    expect([0, 50, 99, 100, 499, 500, 999, 1000, 4999, 5000, 10000].map(themeForStake)).toEqual([
      'Default', 'Default', 'Default', 'Forest', 'Forest', 'Town', 'Town', 'Desert', 'Desert', 'Neon_City', 'Neon_City',
    ]);
  });

  it('captions, primary buy-ins, compact amounts', () => {
    expect(stakeCaption('Default')).toBe('Micro · 50\n1 / 2');
    expect(stakeCaption('Desert')).toBe('High · 1K\n25 / 50');
    expect(stakeCaption('Neon_City')).toBe('Elite · 5K+\n100 / 250');
    expect(compactBuyIn(500)).toBe('500');
    expect(compactBuyIn(10000)).toBe('10K');
    expect(primaryMinBuyIn('Town')).toBe(500);
  });

  it('SelectThemeTable picks the highest affordable stake on the table, else its entry stake', () => {
    expect(pickStakeForTheme('Neon_City', 20000).minBuyIn).toBe(10000);
    expect(pickStakeForTheme('Neon_City', 6000).minBuyIn).toBe(5000);
    expect(pickStakeForTheme('Neon_City', 10).minBuyIn).toBe(5000);
    expect(pickStakeForTheme('Forest', 1e6).minBuyIn).toBe(100);
  });

  it('ThemePicker.SelectedTableTheme: a known chosen stake wins over the current theme', () => {
    expect(selectedTableTheme(0, 'Forest')).toBe('Forest');
    expect(selectedTableTheme(1000, 'Forest')).toBe('Desert');
    expect(selectedTableTheme(123, 'Town')).toBe('Town');
  });

  it('cards sort cheapest → most expensive; labels match packs', () => {
    const authored: ThemeName[] = ['Default', 'Neon_City', 'Forest', 'Town', 'Desert']; // Cards_Holder order
    expect(sortThemesByStake(authored.map((theme) => ({ theme }))).map((x) => x.theme)).toEqual(['Default', 'Forest', 'Town', 'Desert', 'Neon_City']);
    const packs = PACKS.map((p) => ({ theme: p.theme, displayName: p.displayName }));
    const used = packs.map(() => false);
    expect(resolvePackIndex('NEON CITY', packs, used)).toBe(1);
    expect(resolvePackIndex('neon city\nElite · 5K+', packs, used)).toBe(1);
    expect(resolvePackIndex('Neon_City', packs, used)).toBe(1);
    used[0] = true;
    expect(resolvePackIndex('???', packs, used)).toBe(1); // first unused
  });
});

describe('ThemeBackgroundFitter.FitCover', () => {
  it('covers without stretching', () => {
    expect(fitCover(2880, 1080, 1920, 1080)).toEqual([2880, 1080]);
    expect(fitCover(1000, 1000, 1920, 1080)).toEqual([1920, 1920]);
    expect(fitCover(10, 10, 0, 100)).toBeNull();
  });
});

describe('HUD theme slots (hudTheme.classifyThemeDefault)', () => {
  const def = { pot: 'POT', menuButton: 'FRAME', label: SOLANA.buttonLabelColor, accent: SOLANA.accentColor };
  const col = (x: { r: number; g: number; b: number }, a = 1) => ({ rgba: [x.r, x.g, x.b, a] as [number, number, number, number] });
  it('recognises pot / frame sprites and label / accent / value-border colours', () => {
    expect(classifyThemeDefault({ image: { sprite: 'POT', color: col(c(1, 1, 1)) } }, def)).toEqual({ sprite: 'pot' });
    expect(classifyThemeDefault({ image: { sprite: 'FRAME' }, text: { color: col(SOLANA.buttonLabelColor) } }, def)).toEqual({ sprite: 'menuButton', textColor: 'label', textAlpha: 1 });
    expect(classifyThemeDefault({ image: { color: col(SOLANA.accentColor, 0.4) } }, def)).toEqual({ imageColor: 'accent', imageAlpha: 0.4 });
    expect(classifyThemeDefault({ rules: ['ApplyGameplayUi.images (ValueBorderColor)'], image: { color: col(SOLANA.buttonLabelColor) } }, def)).toEqual({ imageColor: 'valueBorder', imageAlpha: 1 });
    expect(classifyThemeDefault({ text: { color: col(c(0.12, 0.12, 0.14)) } }, def)).toBeNull(); // D-token ink is not themed
    expect(classifyThemeDefault(undefined, def)).toBeNull();
  });
});

describe('extracted theme data', () => {
  it('matches the C# enum, default and PlayerPrefs key', () => {
    expect([...THEMES]).toEqual(['Default', 'Neon_City', 'Forest', 'Desert', 'Town']);
    expect(DEFAULT_THEME).toBe('Default');
    expect(THEME_PREF_KEY).toBe('Poker.ActiveTheme');
    expect(PACKS.map((p) => p.displayName)).toEqual(['SOLANA', 'NEON CITY', 'FOREST', 'DESERT', 'TOWN']);
    expect(getPack('Town').buttonLabelColor.r).toBeCloseTo(0.42745098, 4);
  });

  it('every pack has its table art and HUD plates exported', () => {
    const pub = path.resolve(__dirname, '../../../public');
    for (const p of PACKS) {
      for (const slot of ['Board', 'TableBackground', 'CardBack', 'CardBackFolded', 'Pot', 'MenuButton', 'Preview'] as const) {
        const s = spriteFor(p, slot);
        expect(s?.file, `${p.theme} ${slot}`).toBeTruthy();
        expect(fs.existsSync(path.join(pub, s!.file!)), `${p.theme} ${slot} ${s!.file}`).toBe(true);
      }
      expect(spriteFor(p, 'Pot')!.border).toEqual([500, 406, 406, 415]);
    }
    // The default pack reuses the very files the table loads today (assets/3d).
    expect(spriteFor(getPack('Default'), 'Board')!.file).toBe('assets/3d/Board.webp');
    expect(spriteFor(getPack('Default'), 'CardBack')!.file).toBe('assets/3d/card_back_side.webp');
  });
});
