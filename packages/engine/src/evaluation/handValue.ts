import { HandCategory } from './handCategory';

const RANK_WORDS: Record<number, string> = {
  14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten', 9: 'Nine', 8: 'Eight',
  7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two',
};

const rankWord = (r: number): string => RANK_WORDS[r] ?? String(r);

/**
 * A fully comparable score for a 5-card hand: the category plus up to five tiebreaker ranks ordered from
 * most to least significant. Two HandValues comparing equal is a genuine split-pot tie. Port of HandValue.cs.
 */
export class HandValue {
  constructor(
    readonly category: HandCategory,
    readonly t0 = 0,
    readonly t1 = 0,
    readonly t2 = 0,
    readonly t3 = 0,
    readonly t4 = 0,
  ) {}

  compareTo(other: HandValue): number {
    let c = cmp(this.category, other.category); if (c !== 0) return c;
    c = cmp(this.t0, other.t0); if (c !== 0) return c;
    c = cmp(this.t1, other.t1); if (c !== 0) return c;
    c = cmp(this.t2, other.t2); if (c !== 0) return c;
    c = cmp(this.t3, other.t3); if (c !== 0) return c;
    return cmp(this.t4, other.t4);
  }

  gt(o: HandValue): boolean { return this.compareTo(o) > 0; }
  lt(o: HandValue): boolean { return this.compareTo(o) < 0; }
  gte(o: HandValue): boolean { return this.compareTo(o) >= 0; }
  lte(o: HandValue): boolean { return this.compareTo(o) <= 0; }
  equals(o: HandValue): boolean { return this.compareTo(o) === 0; }

  /** Human-readable description for showdown UI, e.g. "Full House, Kings full of Twos". */
  describe(): string {
    const R = rankWord;
    const Rp = (r: number) => rankWord(r) + 's';
    switch (this.category) {
      case HandCategory.StraightFlush: return this.t0 === 14 ? 'Royal Flush' : `Straight Flush, ${R(this.t0)} high`;
      case HandCategory.FourOfAKind: return `Four of a Kind, ${Rp(this.t0)}`;
      case HandCategory.FullHouse: return `Full House, ${Rp(this.t0)} full of ${Rp(this.t1)}`;
      case HandCategory.Flush: return `Flush, ${R(this.t0)} high`;
      case HandCategory.Straight: return `Straight, ${R(this.t0)} high`;
      case HandCategory.ThreeOfAKind: return `Three of a Kind, ${Rp(this.t0)}`;
      case HandCategory.TwoPair: return `Two Pair, ${Rp(this.t0)} and ${Rp(this.t1)}`;
      case HandCategory.Pair: return `Pair of ${Rp(this.t0)}`;
      default: return `High Card, ${R(this.t0)}`;
    }
  }

  /** The C# `default(HandValue)`: HighCard with all-zero tiebreakers. */
  static readonly Default = new HandValue(HandCategory.HighCard);
}

function cmp(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
