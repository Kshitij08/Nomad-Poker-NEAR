import type { Card } from '../cards/card';
import { HandEvaluator } from '../evaluation/handEvaluator';
import { HandCategory } from '../evaluation/handCategory';
import type { HandValue } from '../evaluation/handValue';

/** C# `float` arithmetic: round every intermediate to float32. */
const f = Math.fround;

/**
 * Cheap 0..1 hand-strength estimates for bots (and the local seat's "Hand" meter). Preflop uses a heuristic on the
 * two hole cards; postflop maps the made-hand category to a strength. Port of Bots/HandStrength.cs (float32 math).
 */
export const HandStrength = {
  estimate(hole: readonly Card[], community: readonly Card[] | null | undefined): number {
    if (!community || community.length === 0) return HandStrength.preflop(hole[0]!, hole[1]!);
    return HandStrength.postflop(HandEvaluator.evaluateHand(hole, community));
  },

  preflop(a: Card, b: Card): number {
    let hi: number = a.rank, lo: number = b.rank;
    if (lo > hi) [hi, lo] = [lo, hi];
    const pair = hi === lo;
    const suited = a.suit === b.suit;

    let score: number;
    if (pair) {
      // 22 ~ 0.50, AA ~ 1.00
      score = f(f(0.5) + f(f(f(hi - 2) / f(12)) * f(0.5)));
    } else {
      const hiN = f(f(hi - 2) / f(12));
      const loN = f(f(lo - 2) / f(12));
      score = f(f(hiN * f(0.5)) + f(loN * f(0.25)));
      if (suited) score = f(score + f(0.08));
      const gap = hi - lo;
      if (gap === 1) score = f(score + f(0.06)); // connectors
      else if (gap === 2) score = f(score + f(0.03));
      else if (gap >= 5) score = f(score - f(0.05)); // disconnected
    }
    return clamp01(score);
  },

  postflop(value: HandValue): number {
    let base: number;
    switch (value.category) {
      case HandCategory.StraightFlush: base = 1.0; break;
      case HandCategory.FourOfAKind: base = f(0.97); break;
      case HandCategory.FullHouse: base = f(0.92); break;
      case HandCategory.Flush: base = f(0.85); break;
      case HandCategory.Straight: base = f(0.78); break;
      case HandCategory.ThreeOfAKind: base = f(0.68); break;
      case HandCategory.TwoPair: base = f(0.55); break;
      case HandCategory.Pair: base = f(0.35); break;
      default: base = f(0.12); break;
    }
    // Nudge within the category by the primary tiebreaker rank (2..14 -> 0..~0.06).
    base = f(base + f(f(f(value.t0 - 2) / f(12)) * f(0.06)));
    return clamp01(base);
  },
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
