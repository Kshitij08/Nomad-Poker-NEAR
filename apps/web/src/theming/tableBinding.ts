/**
 * The table half of ThemeManager.Apply: felt (ApplyTableFelt), backdrop (Background_Image), card backs
 * (ApplyCardBacks → CardLibrary textures + SplineCardDealer.RefreshCardBacks) and the HUD chrome
 * (ApplyGameplayUi / ApplyPotChrome over the seat, pot and betting canvases). Applies the current pack now and
 * again on every 'theme:changed'.
 *
 *   bindThemeToTable(stage, ctx.services.theme);   // main.ts, after the modules are installed
 */
import type { TableStage } from '../table/tableStage';
import { setCardBackTextures } from '../three/cardModel';
import { applyHudThemeEverywhere } from '../hud/hudTheme';
import { spriteFor, spriteUrl, type ThemePack } from './themeData';
import type { ThemeService } from './themeService';

/** Applies `pack` to the table stage once. */
export function applyThemeToTable(stage: TableStage, theme: ThemeService, pack: ThemePack = theme.pack): void {
  // ApplyTableFelt: Table_Canvas/Image ← pack.board
  const board = spriteUrl(spriteFor(pack, 'Board'));
  if (board) stage.table.setFelt(board);
  // ApplyByName("Background_Image", tableBackground ?? preview)
  const bg = spriteUrl(spriteFor(pack, 'TableBackground') ?? spriteFor(pack, 'Preview'));
  if (bg) stage.table.setBackground(bg);
  // ApplyCardBacks
  setCardBackTextures(spriteUrl(spriteFor(pack, 'CardBack')), spriteUrl(spriteFor(pack, 'CardBackFolded')));
  stage.dealer.refreshCardBacks();
  // HUD chrome: every node built from unity-hud.json whose baked SOLANA override is pack-dependent (pot plates,
  // frames, label/accent tints) — the stage HUD and any table chrome other modules built from the same data
  // (the menu's Setting / LEAVE buttons…).
  applyHudThemeEverywhere(theme.hudPack(pack));
  stage.hud.layout();
}

/** Keeps the table skinned with the current pack. Returns an unbind function. */
export function bindThemeToTable(stage: TableStage, theme: ThemeService | undefined): () => void {
  if (!theme) return () => {};
  applyThemeToTable(stage, theme);
  return theme.onChanged((c) => applyThemeToTable(stage, theme, c.pack));
}
