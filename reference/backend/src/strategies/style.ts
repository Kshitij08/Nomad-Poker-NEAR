// "Plays like me": fits the Agent's five numbers to a player's own decisions, by inverting HeuristicBot.Decide:
//   nothing to call: bet when (strength >= raiseAbove and roll < aggression) or roll < bluffChance; else check.
//   facing a bet:    strength >= raiseAbove: raise (aggression) else call; else raise (bluffChance);
//                    else call when strength >= pot odds or >= 0.5; else fold below foldBelow; else call.
import { blend, clampProfile, PRESETS, type Profile } from "./profile.js";

export type Action = "fold" | "check" | "call" | "bet" | "raise";
export type Decision = {
  street: number;
  position: number;
  opponents: number;
  strength: number;     // what the bot would see (HandStrength.Estimate, minus 0.03 per extra opponent)
  pot: number;
  toCall: number;
  minRaiseTo: number;
  bigBlind: number;
  action: Action;
  amount: number;       // bet / raise "to"
};

export type Twin = {
  profile: Profile;
  decisions: number;
  confidence: number;   // 0..1: how much of the profile comes from the player's own decisions (rest = prior)
  matchRate: number | null; // share of held-out decisions the twin would choose the same way (null: too few)
};

/** Decisions needed for the fit to stand on its own; below that it leans on the prior. */
export const PRIOR_WEIGHT = 120;
const aggressive = (a: Action) => a === "bet" || a === "raise";

/** Fits a profile to decisions, blended with `prior` (default Tactician) while there are few of them. */
export function fitTwin(decisions: Decision[], prior: Profile = PRESETS.tactician): Twin {
  const usable = decisions.filter((d) => Number.isFinite(d.strength) && d.strength >= 0 && d.strength <= 1);
  if (usable.length === 0) return { profile: prior, decisions: 0, confidence: 0, matchRate: null };
  // Hold out every fifth decision to measure the match rate honestly.
  const train = usable.filter((_, i) => i % 5 !== 4);
  const test = usable.filter((_, i) => i % 5 === 4);
  const raw = fitRaw(train.length >= 20 ? train : usable, prior);
  const w = usable.length / (usable.length + PRIOR_WEIGHT);
  const profile = blend(raw, prior, w);
  return {
    profile,
    decisions: usable.length,
    confidence: w,
    matchRate: test.length >= 25 ? matchRate(profile, test) : null,
  };
}

function fitRaw(ds: Decision[], prior: Profile): Profile {
  // raiseAbove, aggression, bluffChance: the threshold that best explains when the player bets or raises.
  const grid = (lo: number, hi: number, step: number) => { const g: number[] = []; for (let v = lo; v <= hi + 1e-9; v += step) g.push(+v.toFixed(3)); return g; };
  let best = { ll: -Infinity, t: prior.raiseAbove, agg: prior.aggression, bluff: prior.bluffChance };
  for (const t of grid(0.45, 0.9, 0.01)) {
    const hi = ds.filter((d) => d.strength >= t), lo = ds.filter((d) => d.strength < t);
    const rate = (xs: Decision[], fallback: number) => (xs.length ? (xs.filter((d) => aggressive(d.action)).length + fallback * 2) / (xs.length + 2) : fallback);
    const bluff = Math.min(0.25, rate(lo, prior.bluffChance));
    // Above the threshold the bot bets with aggression, or bluffs anyway.
    const pHi = Math.max(0.02, Math.min(0.98, rate(hi, prior.aggression)));
    const pLo = Math.max(0.005, Math.min(0.98, bluff));
    let ll = 0;
    for (const d of hi) ll += Math.log(aggressive(d.action) ? pHi : 1 - pHi);
    for (const d of lo) ll += Math.log(aggressive(d.action) ? pLo : 1 - pLo);
    if (ll > best.ll) best = { ll, t, agg: Math.max(0, (pHi - pLo) / (1 - pLo)), bluff: pLo };
  }

  // foldBelow: among bets faced without the odds (and not raised), folds sit below the threshold, calls above.
  const faced = ds.filter((d) => d.toCall > 0 && !aggressive(d.action) && d.strength < best.t
    && d.strength < Math.max(0.5, d.toCall / (d.pot + d.toCall)));
  let foldBelow = prior.foldBelow;
  if (faced.length >= 8) {
    let bestErr = Infinity;
    for (const t of grid(0.1, 0.55, 0.01)) {
      let err = 0;
      for (const d of faced) err += (d.action === "fold") !== (d.strength < t) ? 1 : 0;
      if (err < bestErr || (err === bestErr && Math.abs(t - prior.foldBelow) < Math.abs(foldBelow - prior.foldBelow))) { bestErr = err; foldBelow = t; }
    }
  }

  // raiseFractionOfPot: median of (raise-to above the minimum) / pot basis, as SizeWager computes it.
  const sizes = ds.filter((d) => aggressive(d.action) && d.amount > 0 && d.pot + d.toCall > 0)
    .map((d) => (d.amount - d.minRaiseTo) / (d.pot + d.toCall)).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const raiseFractionOfPot = sizes.length >= 5 ? sizes[Math.floor(sizes.length / 2)] : prior.raiseFractionOfPot;

  return clampProfile({ foldBelow, raiseAbove: best.t, aggression: best.agg, bluffChance: best.bluff, raiseFractionOfPot });
}

/** What the bot would most likely do (its mode) for this decision's spot. */
export function predict(p: Profile, d: Decision): "fold" | "passive" | "aggressive" {
  if (d.toCall <= 0) {
    const pBet = d.strength >= p.raiseAbove ? p.aggression + (1 - p.aggression) * p.bluffChance : p.bluffChance;
    return pBet >= 0.5 ? "aggressive" : "passive";
  }
  if (d.strength >= p.raiseAbove) return p.aggression >= 0.5 ? "aggressive" : "passive";
  if (p.bluffChance >= 0.5) return "aggressive";
  const potOdds = d.toCall / (d.pot + d.toCall);
  if (d.strength >= potOdds || d.strength >= 0.5) return "passive";
  return d.strength < p.foldBelow ? "fold" : "passive";
}

const kind = (a: Action) => (a === "fold" ? "fold" : aggressive(a) ? "aggressive" : "passive");

/** Share of decisions where the bot's most likely choice (fold / check-call / bet-raise) is the player's. */
export function matchRate(p: Profile, ds: Decision[]): number {
  if (!ds.length) return 0;
  return ds.filter((d) => predict(p, d) === kind(d.action)).length / ds.length;
}
