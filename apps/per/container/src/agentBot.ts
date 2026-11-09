// M12: the Agent's poker brain, a port of the game's own bot (Assets/Scripts/Bots: HeuristicBot, HandStrength,
// BotProfile) and of the program's legal actions (Per/Core/PerLegal.cs, from engine.rs). Cards are the program's
// 0..51: rank = c % 13 (0 = two), suit = c / 13.

/** The five numbers every profile has. */
export type Numbers = { foldBelow: number; raiseAbove: number; aggression: number; bluffChance: number; raiseFractionOfPot: number };
export const STREETS = ["preflop", "flop", "turn", "river"] as const;
export type Street = (typeof STREETS)[number];

/**
 * A profile is the five numbers plus optional v2 fields (docs/AGENTS_V2.md phase 2). Without the optional fields
 * a profile plays exactly as it always has:
 * - `positionWeight` 0..1: looser and more aggressive on the button, tighter early (0 = ignore position);
 * - `streets`: per-street overrides of the five numbers;
 * - `brain: 2`: equity-aware calling against pot odds and stack-to-pot ratio decisions (see decideV2).
 */
export type Profile = Numbers & { positionWeight?: number; brain?: number; streets?: Partial<Record<Street, Partial<Numbers>>> };

export const PRESETS: Record<string, Profile> = {
  conservative: { foldBelow: 0.38, raiseAbove: 0.74, aggression: 0.32, bluffChance: 0.03, raiseFractionOfPot: 0.5 },
  balanced: { foldBelow: 0.3, raiseAbove: 0.66, aggression: 0.52, bluffChance: 0.07, raiseFractionOfPot: 0.62 },
  aggressive: { foldBelow: 0.22, raiseAbove: 0.58, aggression: 0.72, bluffChance: 0.12, raiseFractionOfPot: 0.78 },
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clampNumbers = (p: Numbers): Numbers => ({
  foldBelow: clamp(p.foldBelow, 0.1, 0.55), raiseAbove: clamp(p.raiseAbove, 0.45, 0.9), aggression: clamp(p.aggression, 0.1, 0.95),
  bluffChance: clamp(p.bluffChance, 0, 0.25), raiseFractionOfPot: clamp(p.raiseFractionOfPot, 0.3, 1.2),
});
/** The legal custom range (BotProfile.Clamped). Optional v2 fields are kept only when present and valid. */
export function clampProfile(p: Profile): Profile {
  const out: Profile = clampNumbers(p);
  if (Number.isFinite(p.positionWeight) && p.positionWeight! > 0) out.positionWeight = clamp(p.positionWeight!, 0, 1);
  if (p.brain === 2) out.brain = 2;
  if (p.streets && typeof p.streets === "object") {
    const streets: Partial<Record<Street, Numbers>> = {};
    for (const st of STREETS) {
      const o = p.streets[st];
      if (!o || typeof o !== "object") continue;
      const merged = { ...clampNumbers(p) } as Numbers;
      for (const k of Object.keys(merged) as (keyof Numbers)[]) if (Number.isFinite(o[k])) merged[k] = Number(o[k]);
      streets[st] = clampNumbers(merged);
    }
    if (Object.keys(streets).length) out.streets = streets;
  }
  return out;
}

// ---- legal actions (PerLegal.cs)
export const ST = { empty: 0, sittingOut: 1, active: 2, folded: 3, allIn: 4, busted: 5 } as const;
export const NO_SEAT = 255;
export type GameSeat = { status: number; stack: bigint; currentBet: bigint };
export type Game = { seatCount: number; seats: GameSeat[]; button?: number; toAct: number; highBet: bigint; minRaise: bigint; pot: bigint; runout: boolean; board: number[]; boardLen: number; bigBlind: bigint; street: number };
export type Legal = { canCheck: boolean; canCall: boolean; callAmount: bigint; canBet: boolean; canRaise: boolean; minRaiseTo: bigint; maxRaiseTo: bigint; canAllIn: boolean };

export function legal(g: Game): Legal | null {
  if (g.toAct === NO_SEAT) return null;
  const p = g.seats[g.toAct];
  const toCall = g.highBet > p.currentBet ? g.highBet - p.currentBet : 0n;
  const callAmount = toCall < p.stack ? toCall : p.stack;
  const maxRaiseTo = p.currentBet + p.stack;
  let canActCount = 0;
  for (let i = 0; i < g.seatCount; i++) if (g.seats[i].status === ST.active && g.seats[i].stack > 0n) canActCount++;
  const opponentsCanAct = !g.runout && canActCount > 1;
  const canCheck = toCall === 0n, canCall = toCall > 0n && p.stack > 0n;
  let canBet = false, canRaise = false, minRaiseTo = 0n;
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  if (toCall === 0n) {
    if (p.stack > 0n && opponentsCanAct) { canBet = true; minRaiseTo = min(p.currentBet + g.minRaise, maxRaiseTo); }
  } else if (p.stack > toCall && opponentsCanAct) {
    canRaise = true;
    minRaiseTo = min(g.highBet + g.minRaise, maxRaiseTo);
  }
  let canAllIn = p.stack > 0n && (toCall > 0n || opponentsCanAct);
  if (toCall > 0n && p.stack > toCall && !opponentsCanAct) canAllIn = false;
  return { canCheck, canCall, callAmount, canBet, canRaise, minRaiseTo, maxRaiseTo, canAllIn };
}

// ---- hand strength (HandStrength.cs), with a small 5-of-7 category evaluator
const rankOf = (c: number) => (c % 13) + 2;
const suitOf = (c: number) => Math.floor(c / 13);

export function preflop(a: number, b: number): number {
  let hi = rankOf(a), lo = rankOf(b);
  if (lo > hi) [hi, lo] = [lo, hi];
  let score: number;
  if (hi === lo) score = 0.5 + ((hi - 2) / 12) * 0.5;
  else {
    score = ((hi - 2) / 12) * 0.5 + ((lo - 2) / 12) * 0.25;
    if (suitOf(a) === suitOf(b)) score += 0.08;
    const gap = hi - lo;
    if (gap === 1) score += 0.06;
    else if (gap === 2) score += 0.03;
    else if (gap >= 5) score -= 0.05;
  }
  return clamp(score, 0, 1);
}

/** Made-hand category of the best 5 of these cards (0 high card .. 8 straight flush) and its top rank. */
export function category(cards: number[]): { cat: number; top: number } {
  const ranks = cards.map(rankOf);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const bySuit = new Map<number, number[]>();
  for (const c of cards) bySuit.set(suitOf(c), [...(bySuit.get(suitOf(c)) ?? []), rankOf(c)]);
  const straightTop = (rs: number[]) => {
    const set = new Set(rs);
    if (set.has(14)) set.add(1);
    for (let top = 14; top >= 5; top--) if ([0, 1, 2, 3, 4].every((d) => set.has(top - d))) return top;
    return 0;
  };
  for (const rs of bySuit.values()) if (rs.length >= 5) { const sf = straightTop(rs); if (sf) return { cat: 8, top: sf }; }
  const groups = [...counts.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0]);
  if (groups[0][1] === 4) return { cat: 7, top: groups[0][0] };
  if (groups[0][1] === 3 && groups.length > 1 && groups[1][1] >= 2) return { cat: 6, top: groups[0][0] };
  for (const rs of bySuit.values()) if (rs.length >= 5) return { cat: 5, top: Math.max(...rs) };
  const st = straightTop(ranks);
  if (st) return { cat: 4, top: st };
  if (groups[0][1] === 3) return { cat: 3, top: groups[0][0] };
  if (groups[0][1] === 2 && groups.length > 1 && groups[1][1] === 2) return { cat: 2, top: groups[0][0] };
  if (groups[0][1] === 2) return { cat: 1, top: groups[0][0] };
  return { cat: 0, top: Math.max(...ranks) };
}

const CATEGORY_STRENGTH = [0.12, 0.35, 0.55, 0.68, 0.78, 0.85, 0.92, 0.97, 1.0];
export function strength(hole: number[], board: number[]): number {
  if (board.length === 0) return preflop(hole[0], hole[1]);
  const { cat, top } = category([...hole, ...board]);
  return clamp(CATEGORY_STRENGTH[cat] + ((top - 2) / 12) * 0.06, 0, 1);
}

// ---- full 7-card value and Monte-Carlo equity (brain 2)

function popcount(x: number) { let n = 0; while (x) { x &= x - 1; n++; } return n; }
const straightTop = (m: number) => {
  if (m & (1 << 14)) m |= 2; // the ace plays low too
  for (let top = 14; top >= 5; top--) if (((m >> (top - 4)) & 31) === 31) return top;
  return 0;
};
const pack = (cat: number, ks: number[]) => { let v = cat; for (let i = 0; i < 5; i++) v = v * 16 + (ks[i] ?? 0); return v; };
const topRanks = (m: number, n: number, skip: number[] = []) => {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < n; r--) if (m & (1 << r) && !skip.includes(r)) out.push(r);
  return out;
};

/** Comparable value of the best 5 of 5..7 cards: higher wins, equal ties. Category in the top digit, kickers below. */
export function handValue(cards: number[]): number {
  const counts = new Array<number>(15).fill(0);
  const suits = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) { const r = rankOf(c); counts[r]++; suits[suitOf(c)] |= 1 << r; mask |= 1 << r; }
  for (const sm of suits) {
    if (popcount(sm) >= 5) { const sf = straightTop(sm); return sf ? pack(8, [sf]) : pack(5, topRanks(sm, 5)); }
  }
  let quad = 0;
  const trips: number[] = [], pairs: number[] = [];
  for (let r = 14; r >= 2; r--) { if (counts[r] === 4) quad = r; else if (counts[r] === 3) trips.push(r); else if (counts[r] === 2) pairs.push(r); }
  if (quad) return pack(7, [quad, ...topRanks(mask, 1, [quad])]);
  if (trips.length > 1) return pack(6, [trips[0], Math.max(trips[1], pairs[0] ?? 0)]);
  if (trips.length && pairs.length) return pack(6, [trips[0], pairs[0]]);
  const st = straightTop(mask);
  if (st) return pack(4, [st]);
  if (trips.length) return pack(3, [trips[0], ...topRanks(mask, 2, [trips[0]])]);
  if (pairs.length >= 2) return pack(2, [pairs[0], pairs[1], ...topRanks(mask, 1, [pairs[0], pairs[1]])]);
  if (pairs.length) return pack(1, [pairs[0], ...topRanks(mask, 3, [pairs[0]])]);
  return pack(0, topRanks(mask, 5));
}

/** Share of the pot this hand wins against `opponents` random hands, over `iterations` random runouts (ties split). */
export function equity(hole: number[], board: number[], opponents: number, rnd: () => number, iterations = EQUITY_ITERATIONS): number {
  const n = Math.max(1, Math.min(opponents, 8));
  const used = new Set([...hole, ...board]);
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const fill = 5 - board.length, need = fill + 2 * n;
  let won = 0;
  for (let it = 0; it < iterations; it++) {
    // A partial shuffle: just the cards this runout needs.
    for (let i = 0; i < need; i++) { const j = i + Math.floor(rnd() * (deck.length - i)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    const runout = board.concat(deck.slice(0, fill));
    const mine = handValue(hole.concat(runout));
    let ties = 0, beaten = false;
    for (let o = 0; o < n && !beaten; o++) {
      const v = handValue([deck[fill + 2 * o], deck[fill + 2 * o + 1], ...runout]);
      if (v > mine) beaten = true;
      else if (v === mine) ties++;
    }
    if (!beaten) won += 1 / (ties + 1);
  }
  return won / iterations;
}

/** Monte-Carlo runouts per brain-2 decision. */
export const EQUITY_ITERATIONS = 240;

// ---- the decision (HeuristicBot.cs)
export type Decision = { kind: "fold" | "check" | "call" | "bet" | "raise"; amount: bigint };

/** Street index from the board: 0 preflop, 1 flop, 2 turn, 3 river. */
export const streetOf = (board: number[]) => (board.length === 0 ? 0 : board.length <= 3 ? 1 : board.length === 4 ? 2 : 3);

/** Seats before the button (0 = button, 1 = cutoff, ...), as the decision records store it; null when unknown. */
export function positionOf(g: Game): number | null {
  if (g.button === undefined || g.button === NO_SEAT || g.toAct === NO_SEAT || g.seatCount <= 0) return null;
  return (((g.button - g.toAct) % g.seatCount) + g.seatCount) % g.seatCount;
}

/**
 * How late this seat acts, -1 (first) .. +1 (button). Position counts empty seats too, so it's capped by the
 * number of opponents: with n opponents, n or more seats before the button is as early as it gets.
 */
export function lateness(position: number | null, opponents: number): number {
  if (position === null || position < 0) return 0;
  const n = Math.max(1, opponents);
  return 1 - (2 * Math.min(position, n)) / n;
}

/**
 * The numbers a profile plays in this spot: its street override if any, then shifted by position (looser, more
 * bluffs and lighter value bets late; the reverse early). Shared with the twin fitter (backend/src/strategies/style.ts)
 * and HeuristicBot.cs. With no positionWeight and no street override these are the profile's own five numbers.
 */
export function effective(p: Profile, street: number, late: number): Numbers {
  const o = p.streets?.[STREETS[street]];
  const base: Numbers = {
    foldBelow: o?.foldBelow ?? p.foldBelow, raiseAbove: o?.raiseAbove ?? p.raiseAbove, aggression: o?.aggression ?? p.aggression,
    bluffChance: o?.bluffChance ?? p.bluffChance, raiseFractionOfPot: o?.raiseFractionOfPot ?? p.raiseFractionOfPot,
  };
  const w = (p.positionWeight ?? 0) * late;
  if (!w) return base;
  return {
    ...base,
    foldBelow: clamp(base.foldBelow - POSITION_SHIFT.foldBelow * w, 0.05, 0.6),
    raiseAbove: clamp(base.raiseAbove - POSITION_SHIFT.raiseAbove * w, 0.4, 0.95),
    bluffChance: clamp(base.bluffChance * (1 + POSITION_SHIFT.bluff * w), 0, 0.4),
  };
}
/** How far positionWeight 1 moves the thresholds between the first seat and the button (half each way). */
export const POSITION_SHIFT = { foldBelow: 0.08, raiseAbove: 0.06, bluff: 0.75 };

export function decide(prof: Profile, hole: number[], board: number[], g: Game, opponents: number, rnd: () => number = Math.random): Decision {
  const l = legal(g)!;
  const p = effective(prof, streetOf(board), lateness(positionOf(g), opponents));
  if (prof.brain === 2) return decideV2(p, l, hole, board, g, opponents, rnd);
  let s = strength(hole, board);
  s -= 0.03 * Math.max(0, opponents - 1);
  s += (rnd() - 0.5) * 0.06;
  s = clamp(s, 0, 1);
  const toCall = l.callAmount;
  const size = (): bigint => sizeWager(p.raiseFractionOfPot, l, g, rnd);
  if (toCall <= 0n) {
    const valueBet = s >= p.raiseAbove && rnd() < p.aggression;
    const bluff = rnd() < p.bluffChance;
    if (l.canBet && (valueBet || bluff)) return { kind: "bet", amount: size() };
    return { kind: "check", amount: 0n };
  }
  const potOdds = Number(toCall) / Number(g.pot + toCall);
  if (s >= p.raiseAbove) {
    if (l.canRaise && rnd() < p.aggression) return { kind: "raise", amount: size() };
    if (l.canCall) return { kind: "call", amount: 0n };
  }
  if (l.canRaise && rnd() < p.bluffChance) return { kind: "raise", amount: size() };
  const worthCalling = s >= potOdds || s >= 0.5;
  if (worthCalling && l.canCall) return { kind: "call", amount: 0n };
  if (s < p.foldBelow) return { kind: "fold", amount: 0n };
  return l.canCall ? { kind: "call", amount: 0n } : { kind: "fold", amount: 0n };
}

/** HeuristicBot.SizeWager: min-raise plus a jittered fraction of the pot, rounded to a big blind, kept legal. */
function sizeWager(fractionOfPot: number, l: Legal, g: Game, rnd: () => number): bigint {
  const potBasis = Number(g.pot + l.callAmount);
  const fraction = fractionOfPot * (1 + (rnd() - 0.5) * 0.24);
  let target = Number(l.minRaiseTo) + potBasis * fraction;
  const bb = Number(g.bigBlind);
  if (bb > 0) { const r = Math.round(target / bb) * bb; if (r > 0) target = r; }
  let t = BigInt(Math.floor(target));
  if (t < l.minRaiseTo) t = l.minRaiseTo;
  if (t > l.maxRaiseTo) t = l.maxRaiseTo;
  return t;
}

/**
 * Brain 2. The profile's thresholds are read on a heads-up equity scale (equity against one random hand: 72o is
 * about 0.35, aces 0.85, top pair on the flop about 0.8) instead of the category score, so draws, kickers and a
 * pair shared with the board count for what they are. Then:
 * - facing a bet, it calls only with the equity the pot odds ask for, against a range that gets stronger the bigger
 *   the bet is (the classic bot called anything above foldBelow, an all-in with bottom pair included);
 * - stack-to-pot ratio: at a low SPR strong hands commit (all-in), and a raise or call that would leave a sliver
 *   behind goes all-in; deep, value bets are a little smaller;
 * - value: it bets and raises strong hands with `aggression`, rising to always as the hand nears the nuts (the
 *   classic brain checked back a full house as often as two pair);
 * - heads-up and checked to after the flop it stabs more (bluffChance plus a share of aggression): one opponent
 *   misses most flops.
 */
/** How often brain 2 bets or raises a hand at or above raiseAbove: aggression at the threshold, 1 at the nuts. */
const valueRate = (p: Numbers, h: number) => p.aggression + (1 - p.aggression) * clamp((h - p.raiseAbove) / Math.max(0.05, 1 - p.raiseAbove), 0, 1);

/**
 * Equity against n opponents as the heads-up equity at the same percentile of starting hands, so one raiseAbove plays the
 * same share of hands at any table size (HeuristicBot.HeadsUpEquivalent, same table: quantiles at 0, 5, ..., 100% of
 * every starting hand's equity against 1..7 random opponents).
 */
const EQUITY_QUANTILES: number[][] = [
[ 0.326, 0.349, 0.374, 0.392, 0.408, 0.420, 0.434, 0.453, 0.469, 0.481, 0.500, 0.511, 0.523, 0.536, 0.551, 0.571, 0.579, 0.600, 0.620, 0.653, 0.854 ],
  [ 0.197, 0.221, 0.233, 0.247, 0.258, 0.266, 0.283, 0.288, 0.300, 0.309, 0.320, 0.334, 0.342, 0.359, 0.369, 0.383, 0.400, 0.413, 0.442, 0.472, 0.732 ],
  [ 0.142, 0.154, 0.169, 0.179, 0.188, 0.196, 0.206, 0.212, 0.218, 0.230, 0.236, 0.249, 0.255, 0.265, 0.276, 0.291, 0.306, 0.323, 0.342, 0.373, 0.637 ],
  [ 0.103, 0.119, 0.129, 0.137, 0.148, 0.154, 0.162, 0.167, 0.172, 0.181, 0.187, 0.198, 0.203, 0.211, 0.219, 0.227, 0.247, 0.262, 0.280, 0.309, 0.561 ],
  [ 0.088, 0.096, 0.105, 0.113, 0.120, 0.126, 0.130, 0.138, 0.145, 0.151, 0.154, 0.166, 0.168, 0.174, 0.185, 0.191, 0.207, 0.220, 0.234, 0.268, 0.490 ],
  [ 0.071, 0.077, 0.088, 0.095, 0.101, 0.107, 0.112, 0.118, 0.122, 0.126, 0.133, 0.141, 0.145, 0.149, 0.160, 0.165, 0.183, 0.191, 0.204, 0.233, 0.445 ],
  [ 0.061, 0.068, 0.076, 0.083, 0.087, 0.090, 0.097, 0.100, 0.107, 0.111, 0.117, 0.123, 0.126, 0.133, 0.139, 0.145, 0.161, 0.169, 0.178, 0.211, 0.388 ],
];

export function headsUpEquivalent(eq: number, n: number): number {
  n = Math.max(1, Math.min(7, n));
  if (n === 1) return eq;
  const q = EQUITY_QUANTILES[n - 1], h = EQUITY_QUANTILES[0], last = q.length - 1;
  if (eq <= q[0]) return (h[0] * eq) / q[0];
  if (eq >= q[last]) return h[last] + ((1 - h[last]) * (eq - q[last])) / Math.max(1e-9, 1 - q[last]);
  let i = 1;
  while (q[i] < eq) i++;
  const t = q[i] > q[i - 1] ? (eq - q[i - 1]) / (q[i] - q[i - 1]) : 0;
  return h[i - 1] + t * (h[i] - h[i - 1]);
}

function decideV2(p: Numbers, l: Legal, hole: number[], board: number[], g: Game, opponents: number, rnd: () => number): Decision {
  const n = Math.max(1, opponents);
  const eq = equity(hole, board, n, rnd);
  const hu = clamp(headsUpEquivalent(eq, n) + (rnd() - 0.5) * 0.04, 0, 1); // heads-up-equivalent equity
  const toCall = l.callAmount;
  const pot = Number(g.pot), call = Number(toCall);
  const spr = Number(g.seats[g.toAct].stack - toCall) / Math.max(1, pot + call);
  const street = streetOf(board);
  const allIn = (kind: "bet" | "raise"): Decision => ({ kind, amount: l.maxRaiseTo });
  const size = (kind: "bet" | "raise"): Decision => {
    if (spr < 1.5) return allIn(kind);
    const amount = sizeWager(p.raiseFractionOfPot * (spr > 6 ? 0.85 : 1), l, g, rnd);
    // A wager that leaves under a third of the new pot behind might as well be all-in.
    return Number(l.maxRaiseTo - amount) < (pot + call + Number(amount)) / 3 ? allIn(kind) : { kind, amount };
  };

  if (toCall <= 0n) {
    if (!l.canBet) return { kind: "check", amount: 0n };
    if (hu >= p.raiseAbove && (spr < 1.5 || rnd() < valueRate(p, hu))) return size("bet");
    const stab = p.bluffChance + (n === 1 && street > 0 ? 0.35 * p.aggression : 0);
    // Semi-bluffs and stabs, but not on the river with a hand that might win by checking.
    const bluffable = street < 3 ? hu < p.raiseAbove : hu < p.foldBelow + 0.1;
    if (bluffable && rnd() < stab) return size("bet");
    return { kind: "check", amount: 0n };
  }

  const potOdds = call / (pot + call);
  // What a bet says: the bigger it is against the pot before it, the stronger the range behind it. Strong hands
  // keep most of their equity against a strong range and middling ones lose most of it, hence a power, not a
  // factor. A big blind isn't a bet: nothing to read into it.
  const blindOnly = street === 0 && g.highBet <= g.bigBlind;
  const betRatio = call / Math.max(1, pot - call);
  const vsRange = blindOnly ? eq : Math.pow(eq, 1 + 0.3 + 0.7 * Math.min(1.5, betRatio));
  const vsRangeHu = headsUpEquivalent(vsRange, n);
  const need = potOdds + 0.5 * (p.foldBelow - 0.3); // tighter profiles want a margin, looser ones give some

  if (vsRangeHu >= p.raiseAbove) {
    if (l.canRaise && (spr < 1.5 || rnd() < valueRate(p, vsRangeHu))) return size("raise");
    if (l.canCall) return { kind: "call", amount: 0n };
  }
  if (l.canRaise && spr > 2 && street < 3 && hu >= p.foldBelow && rnd() < p.bluffChance) return size("raise");
  if (l.canCall && vsRange >= need) return { kind: "call", amount: 0n };
  return { kind: "fold", amount: 0n };
}
