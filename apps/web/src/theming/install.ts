import type { AppContext } from '../app/app';
import { ThemeService } from './themeService';
import { ThemePickerScreen } from './themePicker';
import { setThemeServiceForGraphics } from './themedGraphic';

export { bindThemeToTable, applyThemeToTable } from './tableBinding';
export { themedColor, themedSprite, bindThemedGraphic, onThemeChanged, applyFrame, applyPotPlate, applyButtonLabels, applyMenuButton, applyMenuBackground, fitBackground } from './themedGraphic';
export type { ThemePickerParams, ThemePickerApi } from './themePicker';
export type { ThemeChange, ThemeColorKey } from './themeService';
export type { ThemeId, ThemePack, ThemeSlot } from './themeData';

/**
 * Theming module (port of Game/Theming): installs ctx.services.theme (ThemeManager) with the saved pick, and the
 * 'theme-picker' overlay (ThemePicker / Theme_Panel, the TABLES picker). The table is skinned by
 * bindThemeToTable(stage, ctx.services.theme), called from main.ts once the stage exists.
 */
export function install(ctx: AppContext): void {
  const theme = new ThemeService(ctx.events);
  ctx.services.theme = theme;
  setThemeServiceForGraphics(theme);
  ctx.router.register('theme-picker', (c) => new ThemePickerScreen(c, theme));
}
