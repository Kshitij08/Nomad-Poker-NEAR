import { Card } from './card';
import type { IRandom } from './random';
import { InvalidOperationError } from '../errors';

/**
 * A standard 52-card deck with a Fisher-Yates shuffle driven by an injected IRandom.
 * Dealing advances a pointer rather than mutating the list. Port of Core/Cards/Deck.cs.
 */
export class Deck {
  private readonly cards: Card[] = [];
  private nextIndex = 0;

  constructor() {
    this.reset();
  }

  get remaining(): number {
    return this.cards.length - this.nextIndex;
  }

  /** Rebuilds an ordered 52-card deck and resets the deal pointer. */
  reset(): void {
    this.cards.length = 0;
    for (let i = 0; i < 52; i++) this.cards.push(Card.fromIndex(i));
    this.nextIndex = 0;
  }

  /** Shuffles all 52 cards in place and resets the deal pointer. */
  shuffle(random: IRandom): void {
    if (!random) throw new TypeError('random is required.');
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = random.next(i + 1);
      const t = this.cards[i]!;
      this.cards[i] = this.cards[j]!;
      this.cards[j] = t;
    }
    this.nextIndex = 0;
  }

  deal(): Card {
    if (this.remaining <= 0) throw new InvalidOperationError('Cannot deal from an empty deck.');
    return this.cards[this.nextIndex++]!;
  }

  /** Discards the top card (the customary burn before each community street). */
  burn(): void {
    if (this.remaining <= 0) throw new InvalidOperationError('Cannot burn from an empty deck.');
    this.nextIndex++;
  }
}
