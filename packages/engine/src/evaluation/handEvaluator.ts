import type { Card } from '../cards/card';
import { HandCategory } from './handCategory';
import { HandValue } from './handValue';

/**
 * Evaluates the best 5-card poker hand from 5 to 7 cards. For 6/7 cards it tries every 5-card combination
 * (max C(7,5)=21) and keeps the strongest HandValue. Port of HandEvaluator.cs.
 */
export const HandEvaluator = {
  /** Convenience overload: hole cards + community board. */
  evaluateHand(hole: readonly Card[] | null | undefined, community: readonly Card[] | null | undefined): HandValue {
    const all: Card[] = [];
    if (hole) all.push(...hole);
    if (community) all.push(...community);
    return HandEvaluator.evaluate(all);
  },

  evaluate(cards: readonly Card[]): HandValue {
    if (!cards) throw new TypeError('cards is required.');
    const n = cards.length;
    if (n < 5 || n > 7) throw new RangeError(`Expected 5..7 cards, got ${n}.`);
    if (n === 5) return evaluate5(cards[0]!, cards[1]!, cards[2]!, cards[3]!, cards[4]!);

    let best = HandValue.Default;
    let first = true;
    for (let a = 0; a < n - 4; a++)
      for (let b = a + 1; b < n - 3; b++)
        for (let c = b + 1; c < n - 2; c++)
          for (let d = c + 1; d < n - 1; d++)
            for (let e = d + 1; e < n; e++) {
              const v = evaluate5(cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!);
              if (first || v.gt(best)) { best = v; first = false; }
            }
    return best;
  },
};

function evaluate5(c0: Card, c1: Card, c2: Card, c3: Card, c4: Card): HandValue {
  const rankCounts = new Array<number>(15).fill(0);
  const suitCounts = [0, 0, 0, 0];
  for (const c of [c0, c1, c2, c3, c4]) {
    rankCounts[c.rank]!++;
    suitCounts[c.suit]!++;
  }

  let isFlush = false;
  for (let s = 0; s < 4; s++) if (suitCounts[s] === 5) { isFlush = true; break; }

  const straightHigh = straightHighOf(rankCounts);
  const isStraight = straightHigh !== 0;

  // Distinct ranks grouped (count, rank), sorted by count desc then rank desc.
  const grpRank = [0, 0, 0, 0, 0];
  const grpCount = [0, 0, 0, 0, 0];
  let groups = 0;
  for (let r = 14; r >= 2; r--) {
    if (rankCounts[r] === 0) continue;
    grpRank[groups] = r;
    grpCount[groups] = rankCounts[r]!;
    groups++;
  }
  sortGroupsByCountThenRank(grpRank, grpCount, groups);

  const c0count = grpCount[0]!;
  const c1count = groups > 1 ? grpCount[1]! : 0;
  const g = grpRank as [number, number, number, number, number];

  if (isStraight && isFlush) return new HandValue(HandCategory.StraightFlush, straightHigh);
  if (c0count === 4) return new HandValue(HandCategory.FourOfAKind, g[0], g[1]);
  if (c0count === 3 && c1count === 2) return new HandValue(HandCategory.FullHouse, g[0], g[1]);
  if (isFlush) return new HandValue(HandCategory.Flush, g[0], g[1], g[2], g[3], g[4]);
  if (isStraight) return new HandValue(HandCategory.Straight, straightHigh);
  if (c0count === 3) return new HandValue(HandCategory.ThreeOfAKind, g[0], g[1], g[2]);
  if (c0count === 2 && c1count === 2) return new HandValue(HandCategory.TwoPair, g[0], g[1], g[2]);
  if (c0count === 2) return new HandValue(HandCategory.Pair, g[0], g[1], g[2], g[3]);
  return new HandValue(HandCategory.HighCard, g[0], g[1], g[2], g[3], g[4]);
}

/** Highest card of a 5-in-a-row, or 0. Handles the A-2-3-4-5 wheel (returns 5). */
function straightHighOf(rankCounts: number[]): number {
  for (let high = 14; high >= 6; high--) {
    let run = true;
    for (let r = high; r > high - 5; r--) if (rankCounts[r] === 0) { run = false; break; }
    if (run) return high;
  }
  if (rankCounts[14]! > 0 && rankCounts[2]! > 0 && rankCounts[3]! > 0 && rankCounts[4]! > 0 && rankCounts[5]! > 0) return 5;
  return 0;
}

function sortGroupsByCountThenRank(rank: number[], count: number[], n: number): void {
  for (let i = 1; i < n; i++) {
    const r = rank[i]!, c = count[i]!;
    let j = i - 1;
    while (j >= 0 && (count[j]! < c || (count[j] === c && rank[j]! < r))) {
      rank[j + 1] = rank[j]!;
      count[j + 1] = count[j]!;
      j--;
    }
    rank[j + 1] = r;
    count[j + 1] = c;
  }
}
