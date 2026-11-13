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
import { cardBackTextures, onCardBackChanged } from './cardBack';
import type { ThemeService } from './themeService';

/** Applies `pack` to the table stage once. */
export function applyThemeToTable(stage: TableStage, theme: ThemeService, pack: ThemePack = theme.pack): void {
  // ApplyTableFelt: Table_Canvas/Image ← pack.board
  const board = spriteUrl(spriteFor(pack, 'Board'));
  if (board) stage.table.setFelt(board);
  // ApplyByName("Background_Image", tableBackground ?? preview)
  const bg = spriteUrl(spriteFor(pack, 'TableBackground') ?? spriteFor(pack, 'Preview'));
  if (bg) stage.table.setBackground(bg);
  // ApplyCardBacks (or the deck the player wears: a Shop card back replaces only these textures)
  setCardBackTextures(...cardBackTextures(pack));
  stage.dealer.refreshCardBacks();
  // HUD chrome: every node built from unity-hud.json whose baked SOLANA override is pack-dependent (pot plates,
  // frames, label/accent tints) — the stage HUD and any table chrome other modules built from the same data
  // (the menu's Setting / LEAVE buttons…).
  applyHudThemeEverywhere(theme.hudPack(pack));
  // The v2 HUD tints the action row and status chips with the room's colours (hud/v2hud.css, html[data-room]).
  if (typeof document !== 'undefined') document.documentElement.dataset.room = pack.theme;
  stage.hud.layout();
}

/** Keeps the table skinned with the current pack. Returns an unbind function. */
export function bindThemeToTable(stage: TableStage, theme: ThemeService | undefined): () => void {
  if (!theme) return () => {};
  applyThemeToTable(stage, theme);
  const offTheme = theme.onChanged((c) => applyThemeToTable(stage, theme, c.pack));
  const offDeck = onCardBackChanged(() => {
    setCardBackTextures(...cardBackTextures(theme.pack));
    stage.dealer.refreshCardBacks();
  });
  return () => {
    offTheme();
    offDeck();
  };
}
