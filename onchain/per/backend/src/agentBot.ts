// M12: the Agent's poker brain, a port of the game's own bot (Assets/Scripts/Bots: HeuristicBot, HandStrength,
// BotProfile) and of the program's legal actions (Per/Core/PerLegal.cs, from engine.rs). Cards are the program's
// 0..51: rank = c % 13 (0 = two), suit = c / 13.

export type Profile = { foldBelow: number; raiseAbove: number; aggression: number; bluffChance: number; raiseFractionOfPot: number };

export const PRESETS: Record<string, Profile> = {
  conservative: { foldBelow: 0.38, raiseAbove: 0.74, aggression: 0.32, bluffChance: 0.03, raiseFractionOfPot: 0.5 },
  balanced: { foldBelow: 0.3, raiseAbove: 0.66, aggression: 0.52, bluffChance: 0.07, raiseFractionOfPot: 0.62 },
  aggressive: { foldBelow: 0.22, raiseAbove: 0.58, aggression: 0.72, bluffChance: 0.12, raiseFractionOfPot: 0.78 },
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** The legal custom range (BotProfile.Clamped). */
export function clampProfile(p: Profile): Profile {
  return {
    foldBelow: clamp(p.foldBelow, 0.1, 0.55), raiseAbove: clamp(p.raiseAbove, 0.45, 0.9), aggression: clamp(p.aggression, 0.1, 0.95),
    bluffChance: clamp(p.bluffChance, 0, 0.25), raiseFractionOfPot: clamp(p.raiseFractionOfPot, 0.3, 1.2),
  };
}

// ---- legal actions (PerLegal.cs)
export const ST = { empty: 0, sittingOut: 1, active: 2, folded: 3, allIn: 4, busted: 5 } as const;
export const NO_SEAT = 255;
export type GameSeat = { status: number; stack: bigint; currentBet: bigint };
export type Game = { seatCount: number; seats: GameSeat[]; toAct: number; highBet: bigint; minRaise: bigint; pot: bigint; runout: boolean; board: number[]; boardLen: number; bigBlind: bigint; street: number };
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

// ---- the decision (HeuristicBot.cs)
export type Decision = { kind: "fold" | "check" | "call" | "bet" | "raise"; amount: bigint };

export function decide(p: Profile, hole: number[], board: number[], g: Game, opponents: number, rnd: () => number = Math.random): Decision {
  const l = legal(g)!;
  let s = strength(hole, board);
  s -= 0.03 * Math.max(0, opponents - 1);
  s += (rnd() - 0.5) * 0.06;
  s = clamp(s, 0, 1);
  const toCall = l.callAmount;
  const size = (): bigint => {
    const potBasis = Number(g.pot + toCall);
    const fraction = p.raiseFractionOfPot * (1 + (rnd() - 0.5) * 0.24);
    let target = Number(l.minRaiseTo) + potBasis * fraction;
    const bb = Number(g.bigBlind);
    if (bb > 0) { const r = Math.round(target / bb) * bb; if (r > 0) target = r; }
    let t = BigInt(Math.floor(target));
    if (t < l.minRaiseTo) t = l.minRaiseTo;
    if (t > l.maxRaiseTo) t = l.maxRaiseTo;
    return t;
  };
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
