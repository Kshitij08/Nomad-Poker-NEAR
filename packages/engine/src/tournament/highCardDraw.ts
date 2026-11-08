import type { Card } from '../cards/card';
import { Deck } from '../cards/deck';
import type { IRandom } from '../cards/random';
import { ArgumentOutOfRangeError } from '../errors';
import { compareNum, dotnetSort } from './dotnetSort';

/** Port of the DrawnCard struct. */
export interface DrawnCard {
  readonly entrantId: string;
  readonly card: Card;
}

/**
 * Settles a tie by dealing each player one card from a shuffled deck. Rank decides, then suit (spades, hearts,
 * diamonds, clubs), and the cards are all different — so there is never a re-draw. Port of HighCardDraw.cs.
 */
export const HighCardDraw = {
  /** Everyone's card, best first. */
  draw(entrantIds: readonly string[], rng: IRandom): DrawnCard[] {
    if (!entrantIds) throw new TypeError('entrantIds is required.');
    if (!rng) throw new TypeError('rng is required.');
    if (entrantIds.length > 52) throw new ArgumentOutOfRangeError('entrantIds: One deck holds 52 cards.');

    const deck = new Deck();
    deck.shuffle(rng);
    const drawn: DrawnCard[] = entrantIds.map((id) => Object.freeze({ entrantId: id, card: deck.deal() }));
    return dotnetSort(drawn, (a, b) => compareNum(strength(b.card), strength(a.card)));
  },
} as const;

function strength(card: Card): number {
  return card.rank * 4 + card.suit;
}
