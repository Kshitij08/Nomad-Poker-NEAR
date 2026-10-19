// Marketplace style tags from what a strategy does, not from one raw number (review 20 Oct: "Tight" came from foldBelow,
// which barely changes how many hands an Agent plays, and "Pot odds" sat on every Agent strategy). Hands played is the
// measured table of Assets/Scripts/Net/NomadUi/AgentStrategyWords.cs (VpipByRaiseFold: 5-seat Coins table, the smart
// brain with thresholds normalised for table size). per/backend/src/styleTags.ts is the same for SOL strategies.

type Numbers = { foldBelow: number; raiseAbove: number; aggression: number; bluffChance: number; raiseFractionOfPot: number };
type Styled = Numbers & { brain?: number; streets?: Partial<Record<"preflop" | "flop" | "turn" | "river", Numbers>> };

const RAISE = [0.45, 0.48, 0.5, 0.52, 0.55, 0.58, 0.6, 0.62, 0.65, 0.7, 0.8, 0.9];
const FOLD = [0.1, 0.25, 0.4, 0.55];
const VPIP = [
  [0.625, 0.584, 0.553, 0.52], [0.579, 0.522, 0.493, 0.444], [0.557, 0.495, 0.465, 0.41], [0.529, 0.441, 0.41, 0.349],
  [0.495, 0.395, 0.349, 0.285], [0.459, 0.342, 0.279, 0.212], [0.446, 0.323, 0.251, 0.181], [0.433, 0.305, 0.221, 0.155],
  [0.425, 0.293, 0.203, 0.125], [0.422, 0.279, 0.185, 0.1], [0.421, 0.28, 0.18, 0.096], [0.418, 0.277, 0.18, 0.094],
];

const idx = (xs: number[], x: number) => { let i = 0; while (i < xs.length - 2 && x > xs[i + 1]) i++; return i; };
const frac = (xs: number[], i: number, x: number) => Math.min(1, Math.max(0, (x - xs[i]) / (xs[i + 1] - xs[i])));

/** Share of hands it plays at a Coins table (measured), from its before-the-flop numbers. */
export function handsPlayed(n: Numbers): number {
  const i = idx(RAISE, n.raiseAbove), j = idx(FOLD, n.foldBelow);
  const tr = frac(RAISE, i, n.raiseAbove), tc = frac(FOLD, j, n.foldBelow);
  const a = VPIP[i][j] + (VPIP[i][j + 1] - VPIP[i][j]) * tc, b = VPIP[i + 1][j] + (VPIP[i + 1][j + 1] - VPIP[i + 1][j]) * tc;
  return a + (b - a) * tr;
}

export function styleTags(p: Styled): string[] {
  const pre = p.streets?.preflop ?? p;
  const post = p.streets?.flop ?? p.streets?.turn ?? p.streets?.river ?? p;
  const out: string[] = [];
  if (p.brain !== 2) out.push("Twin (plays like a person)");
  const hands = handsPlayed(pre);
  out.push(hands >= 0.45 ? "Loose" : hands <= 0.25 ? "Tight" : "Medium hands");
  out.push(post.aggression >= 0.6 ? "Aggressive" : post.aggression <= 0.3 ? "Passive" : "Steady");
  if (post.bluffChance >= 0.06) out.push("Bluffer");
  if (post.raiseFractionOfPot >= 0.85) out.push("Big bets");
  if (p.streets?.preflop || p.streets?.flop) out.push("Before / after the flop");
  return out;
}
