import type { Card } from '../cards/card';
import type { DotNetRandom } from '../cards/random';

/**
 * Monte-Carlo equity for the brain-2 bot: the share of the pot a hand wins against random hands over random runouts.
 * Works on card indices (0..51). Port of Bots/Equity.cs.
 */
export const Equity = {
  estimate(hole: readonly Card[], board: readonly Card[] | null | undefined, opponents: number, rng: DotNetRandom, iterations: number): number {
    const n = Math.max(1, Math.min(opponents, 8));
    const boardCount = board?.length ?? 0;
    const used = new Array<boolean>(52).fill(false);
    const h0 = hole[0]!.index, h1 = hole[1]!.index;
    used[h0] = used[h1] = true;
    const known = [0, 0, 0, 0, 0];
    for (let i = 0; i < boardCount; i++) { known[i] = board![i]!.index; used[known[i]!] = true; }
    const deck = new Array<number>(52).fill(0);
    let deckCount = 0;
    for (let c = 0; c < 52; c++) if (!used[c]) deck[deckCount++] = c;

    const fill = 5 - boardCount, need = fill + 2 * n;
    const mine = [0, 0, 0, 0, 0, 0, 0];
    const theirs = [0, 0, 0, 0, 0, 0, 0];
    let won = 0;
    for (let it = 0; it < iterations; it++) {
      // A partial shuffle: just the cards this runout needs.
      for (let i = 0; i < need; i++) {
        const j = i + Math.trunc(rng.nextDouble() * (deckCount - i));
        const t = deck[i]!; deck[i] = deck[j]!; deck[j] = t;
      }
      for (let i = 0; i < 5; i++) {
        const c = i < boardCount ? known[i]! : deck[i - boardCount]!;
        mine[i] = theirs[i] = c;
      }
      mine[5] = h0; mine[6] = h1;
      const me = Equity.handValue(mine);
      let ties = 0;
      let beaten = false;
      for (let o = 0; o < n && !beaten; o++) {
        theirs[5] = deck[fill + 2 * o]!;
        theirs[6] = deck[fill + 2 * o + 1]!;
        const v = Equity.handValue(theirs);
        if (v > me) beaten = true;
        else if (v === me) ties++;
      }
      if (!beaten) won += 1.0 / (ties + 1);
    }
    return won / iterations;
  },

  /** Comparable value of the best 5 of these 7 card indices: higher wins, equal ties. Category = value >> 20. */
  handValue(cards: readonly number[]): number {
    const counts = new Array<number>(15).fill(0);
    const suits = [0, 0, 0, 0];
    const k = [0, 0, 0, 0, 0];
    let mask = 0;
    for (const c of cards) {
      const r = (c % 13) + 2;
      counts[r]!++;
      suits[Math.floor(c / 13)]! |= 1 << r;
      mask |= 1 << r;
    }
    for (let s = 0; s < 4; s++) {
      if (popCount(suits[s]!) < 5) continue;
      const sf = straightTop(suits[s]!);
      if (sf !== 0) return value(8, sf);
      top(suits[s]!, 0, 0, k, 5);
      return value(5, k[0]!, k[1]!, k[2]!, k[3]!, k[4]!);
    }
    let quad = 0, trip1 = 0, trip2 = 0, pair1 = 0, pair2 = 0;
    for (let r = 14; r >= 2; r--) {
      if (counts[r] === 4) quad = r;
      else if (counts[r] === 3) { if (trip1 === 0) trip1 = r; else if (trip2 === 0) trip2 = r; }
      else if (counts[r] === 2) { if (pair1 === 0) pair1 = r; else if (pair2 === 0) pair2 = r; }
    }
    if (quad !== 0) { top(mask, quad, 0, k, 1); return value(7, quad, k[0]!); }
    if (trip1 !== 0 && trip2 !== 0) return value(6, trip1, Math.max(trip2, pair1));
    if (trip1 !== 0 && pair1 !== 0) return value(6, trip1, pair1);
    const st = straightTop(mask);
    if (st !== 0) return value(4, st);
    if (trip1 !== 0) { top(mask, trip1, 0, k, 2); return value(3, trip1, k[0]!, k[1]!); }
    if (pair2 !== 0) { top(mask, pair1, pair2, k, 1); return value(2, pair1, pair2, k[0]!); }
    if (pair1 !== 0) { top(mask, pair1, 0, k, 3); return value(1, pair1, k[0]!, k[1]!, k[2]!); }
    top(mask, 0, 0, k, 5);
    return value(0, k[0]!, k[1]!, k[2]!, k[3]!, k[4]!);
  },
};

function value(category: number, r0: number, r1 = 0, r2 = 0, r3 = 0, r4 = 0): number {
  return ((((category * 16 + r0) * 16 + r1) * 16 + r2) * 16 + r3) * 16 + r4;
}

function top(mask: number, skip1: number, skip2: number, into: number[], count: number): void {
  into.fill(0);
  let got = 0;
  for (let r = 14; r >= 2 && got < count; r--) if ((mask & (1 << r)) !== 0 && r !== skip1 && r !== skip2) into[got++] = r;
}

function straightTop(m: number): number {
  if ((m & (1 << 14)) !== 0) m |= 2; // the ace plays low too
  for (let t = 14; t >= 5; t--) if (((m >> (t - 4)) & 31) === 31) return t;
  return 0;
}

function popCount(x: number): number {
  let n = 0;
  while (x !== 0) { x &= x - 1; n++; }
  return n;
}
