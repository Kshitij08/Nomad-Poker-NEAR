import { Rank } from './rank';
import { Suit } from './suit';

const RANK_NAMES: Record<number, string> = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
  9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
};

const SUIT_NAMES: Record<number, string> = { 0: 'Clubs', 1: 'Diamonds', 2: 'Hearts', 3: 'Spades' };
const SUIT_CHARS: Record<number, string> = { 0: 'c', 1: 'd', 2: 'h', 3: 's' };

/**
 * An immutable playing card. Port of Assets/Scripts/Core/Cards/Card.cs.
 * Compare with {@link Card.equals}, not `===` (although {@link Card.fromIndex} returns shared instances).
 */
export class Card {
  constructor(readonly rank: Rank, readonly suit: Suit) {
    Object.freeze(this);
  }

  /** 0..51 dense index (suit-major): suit * 13 + (rank - 2). */
  get index(): number {
    return this.suit * 13 + (this.rank - 2);
  }

  static fromIndex(index: number): Card {
    if (!Number.isInteger(index) || index < 0 || index > 51)
      throw new RangeError(`Card index must be 0..51, got ${index}.`);
    return ALL_CARDS[index]!;
  }

  equals(other: Card | null | undefined): boolean {
    return !!other && this.rank === other.rank && this.suit === other.suit;
  }

  /** Long name, e.g. "Ten of Hearts". Matches the child names inside Card.prefab. */
  toString(): string {
    return `${this.rankName} of ${SUIT_NAMES[this.suit] ?? String(this.suit)}`;
  }

  get rankName(): string {
    return RANK_NAMES[this.rank] ?? String(this.rank);
  }

  /** Compact form for logs, e.g. "Th", "As", "2c". */
  get short(): string {
    return `${this.rankChar}${SUIT_CHARS[this.suit] ?? '?'}`;
  }

  private get rankChar(): string {
    switch (this.rank) {
      case Rank.Ten: return 'T';
      case Rank.Jack: return 'J';
      case Rank.Queen: return 'Q';
      case Rank.King: return 'K';
      case Rank.Ace: return 'A';
      default: return String(this.rank);
    }
  }

  /** Parses the {@link short} form ("Th", "As", "2c"). Test/debug helper (not in the C# source). */
  static parse(s: string): Card {
    const r = '23456789TJQKA'.indexOf(s[0]!.toUpperCase());
    const su = 'cdhs'.indexOf(s[1]!.toLowerCase());
    if (r < 0 || su < 0 || s.length !== 2) throw new RangeError(`Bad card "${s}".`);
    return Card.fromIndex(su * 13 + r);
  }
}

const ALL_CARDS: readonly Card[] = Array.from({ length: 52 }, (_, i) => new Card(((i % 13) + 2) as Rank, Math.floor(i / 13) as Suit));
