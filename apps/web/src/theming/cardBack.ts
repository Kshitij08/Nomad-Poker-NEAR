/**
 * The card back a player wears at every table (a Shop item, `deck:<theme>`), else the free Nomad back. It replaces
 * only the card-back textures; the room's background, felt and HUD stay the room's. Saved per device; a deck is worn
 * only while the player owns it.
 */
import { PlayerPrefs } from '../app/services';
import { getPack, spriteFor, spriteUrl, THEMES, type ThemeId, type ThemePack } from './themeData';
import { assetUrl } from '../hud/unityUi';

const KEY = 'Nomad.CardBack';
const listeners = new Set<() => void>();
let owns: (itemId: string) => boolean = () => false;

export const cardBackItemId = (theme: ThemeId | string): string => `deck:${theme}`;

/** The economy tells the theming module what the player owns (set once at install). */
export function setCardBackOwnership(fn: (itemId: string) => boolean): void {
  owns = fn;
}

/** The equipped card-back theme, if it's set and owned. */
export function equippedCardBack(): ThemeId | null {
  const t = PlayerPrefs.getString(KEY, '') as ThemeId;
  return t && (THEMES as readonly string[]).includes(t) && owns(cardBackItemId(t)) ? t : null;
}

export function equipCardBack(theme: ThemeId | null): void {
  PlayerPrefs.setString(KEY, theme ?? '');
  for (const fn of [...listeners]) fn();
}

let lastWorn: ThemeId | null | undefined;

/** Ownership can arrive after the table was skinned (the server's items load at sign-in): re-skin when the worn deck changes. */
export function recheckCardBack(): void {
  const now = equippedCardBack();
  if (now === lastWorn) return;
  lastWorn = now;
  for (const fn of [...listeners]) fn();
}

export function onCardBackChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The free card back every player has: a solid Nomad purple with a faint "Nomad Poker" mark (gold frame), and its
 * grey twin for folded cards. Same size and UVs as the room decks (732 × 1024, rounded corners). The room decks are
 * Shop items now, so a table no longer shows its room's deck unless the player owns and wears it.
 */
export const FREE_CARD_BACK = 'assets/theming/cardbacks/nomad_free_back.webp';
export const FREE_CARD_BACK_FOLDED = 'assets/theming/cardbacks/nomad_free_back_folded.webp';

/** The card-back textures for a table skinned with `pack`: the equipped deck's, else the free Nomad back. */
export function cardBackTextures(_pack: ThemePack): [string | null, string | null] {
  const eq = equippedCardBack();
  if (!eq) return [assetUrl(FREE_CARD_BACK), assetUrl(FREE_CARD_BACK_FOLDED)];
  const src = getPack(eq);
  return [spriteUrl(spriteFor(src, 'CardBack')), spriteUrl(spriteFor(src, 'CardBackFolded'))];
}

/** Preview art for a deck (the Shop's card art). `'free'` is the default Nomad back. */
export function cardBackPreview(theme: ThemeId | string): string | null {
  if (theme === 'free') return assetUrl(FREE_CARD_BACK);
  return spriteUrl(spriteFor(getPack(theme as ThemeId), 'CardBack'));
}
