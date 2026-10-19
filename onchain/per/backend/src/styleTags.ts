// Marketplace style from what a strategy does, not from one raw number (review 20 Oct: "Tight" came from foldBelow,
// which barely changes how many hands an Agent plays, and "Pot odds" sat on every Agent strategy). The tables are the
// measured grid of Assets/Scripts/Net/NomadUi/AgentStrategyWords.cs (5-seat Coins table, the smart brain with thresholds
// normalised for table size; docs/AGENTS_V2.md section 9). backend/src/strategies/styleTags.ts is the same for Coins strategies.

type Numbers = { foldBelow: number; raiseAbove: number; aggression: number; bluffChance: number; raiseFractionOfPot: number };
type Styled = Numbers & { brain?: number; streets?: Partial<Record<"preflop" | "flop" | "turn" | "river", Numbers>> };

const RAISE = [0.45, 0.48, 0.5, 0.52, 0.55, 0.58, 0.6, 0.62, 0.65, 0.7, 0.8, 0.9];
const FOLD = [0.1, 0.25, 0.4, 0.55];
const AGGR = [0.1, 0.3, 0.5, 0.7, 0.95];
/** Hands played, by raiseAbove (rows) and foldBelow (columns). */
const VPIP = [
  [0.625, 0.584, 0.553, 0.52], [0.579, 0.522, 0.493, 0.444], [0.557, 0.495, 0.465, 0.41], [0.529, 0.441, 0.41, 0.349],
  [0.495, 0.395, 0.349, 0.285], [0.459, 0.342, 0.279, 0.212], [0.446, 0.323, 0.251, 0.181], [0.433, 0.305, 0.221, 0.155],
  [0.425, 0.293, 0.203, 0.125], [0.422, 0.279, 0.185, 0.1], [0.421, 0.28, 0.18, 0.096], [0.418, 0.277, 0.18, 0.094],
];
/** Raises before the flop, by raiseAbove (rows) and aggression (columns). */
const PFR = [
  [0.165, 0.251, 0.34, 0.428, 0.538], [0.137, 0.212, 0.288, 0.364, 0.456], [0.123, 0.189, 0.263, 0.331, 0.418],
  [0.104, 0.161, 0.221, 0.28, 0.352], [0.08, 0.127, 0.172, 0.219, 0.276], [0.063, 0.092, 0.121, 0.15, 0.185],
  [0.054, 0.077, 0.099, 0.124, 0.15], [0.048, 0.061, 0.079, 0.095, 0.113], [0.038, 0.049, 0.057, 0.066, 0.081],
  [0.032, 0.034, 0.038, 0.041, 0.045], [0.028, 0.028, 0.03, 0.031, 0.032], [0.024, 0.026, 0.026, 0.025, 0.025],
];
/** Share of after-the-flop actions that are bets or raises, by raiseAbove (rows) and aggression (columns). */
const AFQ = [
  [0.248, 0.296, 0.34, 0.384, 0.437], [0.239, 0.283, 0.33, 0.371, 0.416], [0.231, 0.271, 0.318, 0.354, 0.398],
  [0.226, 0.26, 0.307, 0.343, 0.385], [0.213, 0.251, 0.286, 0.32, 0.36], [0.2, 0.237, 0.268, 0.3, 0.335],
  [0.19, 0.221, 0.255, 0.281, 0.318], [0.176, 0.209, 0.24, 0.269, 0.304], [0.165, 0.191, 0.22, 0.248, 0.276],
  [0.14, 0.16, 0.188, 0.206, 0.235], [0.099, 0.116, 0.133, 0.145, 0.164], [0.059, 0.066, 0.074, 0.084, 0.092],
];

const idx = (xs: number[], x: number) => { let i = 0; while (i < xs.length - 2 && x > xs[i + 1]) i++; return i; };
const frac = (xs: number[], i: number, x: number) => Math.min(1, Math.max(0, (x - xs[i]) / (xs[i + 1] - xs[i])));
function lerp2(t: number[][], rows: number[], cols: number[], r: number, c: number): number {
  const i = idx(rows, r), j = idx(cols, c), tr = frac(rows, i, r), tc = frac(cols, j, c);
  const a = t[i][j] + (t[i][j + 1] - t[i][j]) * tc, b = t[i + 1][j] + (t[i + 1][j + 1] - t[i + 1][j]) * tc;
  return a + (b - a) * tr;
}

/** Share of hands it plays at a Coins table (measured), from its before-the-flop numbers. */
export const handsPlayed = (n: Numbers) => lerp2(VPIP, RAISE, FOLD, n.raiseAbove, n.foldBelow);
export const raisesBeforeFlop = (n: Numbers) => lerp2(PFR, RAISE, AGGR, n.raiseAbove, n.aggression);
export const pressure = (n: Numbers) => lerp2(AFQ, RAISE, AGGR, n.raiseAbove, n.aggression);

const before = (p: Styled) => p.streets?.preflop ?? p;
const after = (p: Styled) => p.streets?.flop ?? p.streets?.turn ?? p.streets?.river ?? p;

/** What a strategy does, measured: the vector the distinctness check and "similar strategies" compare. */
export type Behaviour = { handsPlayed: number; raisesBeforeFlop: number; pressure: number; bluff: number; betSize: number };
export function behaviour(p: Styled): Behaviour {
  const pre = before(p), post = after(p);
  return { handsPlayed: handsPlayed(pre), raisesBeforeFlop: raisesBeforeFlop(pre), pressure: pressure(post), bluff: post.bluffChance, betSize: post.raiseFractionOfPot };
}

/** Two strategies play alike (the review's tolerance: about 6 points of hands played, raises and pressure, 3 bluffs in
 *  100, 15% of the pot in bet size). */
export function alike(a: Behaviour, b: Behaviour): boolean {
  return Math.abs(a.handsPlayed - b.handsPlayed) <= 0.06 && Math.abs(a.raisesBeforeFlop - b.raisesBeforeFlop) <= 0.06
    && Math.abs(a.pressure - b.pressure) <= 0.06 && Math.abs(a.bluff - b.bluff) <= 0.03 && Math.abs(a.betSize - b.betSize) <= 0.15;
}

/** Distance in "tolerances" (1 = at the edge of alike), for ranking similar strategies. */
export function distance(a: Behaviour, b: Behaviour): number {
  return Math.max(Math.abs(a.handsPlayed - b.handsPlayed) / 0.06, Math.abs(a.raisesBeforeFlop - b.raisesBeforeFlop) / 0.06,
    Math.abs(a.pressure - b.pressure) / 0.06, Math.abs(a.bluff - b.bluff) / 0.03, Math.abs(a.betSize - b.betSize) / 0.15);
}

/** The style cell a strategy belongs to: how many hands it plays x how hard it pushes (9 cells). */
export function styleCell(b: Behaviour): string {
  const hands = b.handsPlayed >= 0.45 ? "Loose" : b.handsPlayed <= 0.25 ? "Tight" : "Medium";
  const push = b.pressure >= 0.3 ? "Aggressive" : b.pressure < 0.22 ? "Passive" : "Steady";
  return `${hands} ${push}`;
}

export function styleTags(p: Styled): string[] {
  const b = behaviour(p);
  const out: string[] = [];
  if (p.brain !== 2) out.push("Twin (plays like a person)");
  out.push(b.handsPlayed >= 0.45 ? "Loose" : b.handsPlayed <= 0.25 ? "Tight" : "Medium hands");
  out.push(b.pressure >= 0.3 ? "Aggressive" : b.pressure < 0.22 ? "Passive" : "Steady");
  if (b.bluff >= 0.06) out.push("Bluffer");
  if (b.betSize >= 0.85) out.push("Big bets");
  if (p.streets?.preflop || p.streets?.flop) out.push("Before / after the flop");
  return out;
}
