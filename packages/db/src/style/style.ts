// "Plays like me": fits the Agent's numbers to a player's own decisions, by inverting HeuristicBot.Decide (the
// classic rule; the twin is a classic-brain profile, since the records carry the bot's strength, not equity):
//   thresholds: the street's numbers, shifted by position (profile.ts effective(): positionWeight moves foldBelow
//               and raiseAbove down and bluffChance up on the button, the other way early);
//   nothing to call: bet when (strength >= raiseAbove and roll < aggression) or roll < bluffChance; else check.
//   facing a bet:    strength >= raiseAbove: raise (aggression) else call; else raise (bluffChance);
//                    else call when strength >= pot odds or >= 0.5; else fold below foldBelow; else call.
import { blend, clampProfile, effective, lateness, POSITION_SHIFT, PRESETS, STREETS, type Numbers, type Profile, type Street } from "./profile";

export type Action = "fold" | "check" | "call" | "bet" | "raise";
export type Decision = {
  street: number;
  position: number;     // seats before the button (0 = button)
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
/** Decisions on a street before it gets its own numbers (docs/AGENTS_V2.md §3: about 150 per street). */
export const STREET_MIN = 150;
const aggressive = (a: Action) => a === "bet" || a === "raise";
const late = (d: Decision) => lateness(d.position, d.opponents);

/** Fits a profile to decisions, blended with `prior` (default Tactician) while there are few of them. */
export function fitTwin(decisions: Decision[], prior: Profile = PRESETS.tactician): Twin {
  const usable = decisions.filter((d) => Number.isFinite(d.strength) && d.strength >= 0 && d.strength <= 1);
  if (usable.length === 0) return { profile: prior, decisions: 0, confidence: 0, matchRate: null };
  // Hold out every fifth decision to measure the match rate honestly.
  const train = usable.filter((_, i) => i % 5 !== 4);
  const test = usable.filter((_, i) => i % 5 === 4);
  const fitOn = train.length >= 20 ? train : usable;
  const raw = fitRaw(fitOn, prior);
  const w = usable.length / (usable.length + PRIOR_WEIGHT);
  let profile = blend(raw, prior, w);
  // Streets with enough decisions get their own numbers, leaning on the overall fit while they're thin.
  const streets: Partial<Record<Street, Numbers>> = {};
  STREETS.forEach((name, st) => {
    const ds = fitOn.filter((d) => d.street === st);
    if (ds.length < STREET_MIN) return;
    const own = fitRaw(ds, profile, profile.positionWeight ?? 0);
    const mixed = blend(own, profile, ds.length / (ds.length + PRIOR_WEIGHT));
    // Only when the street's own numbers explain it clearly better: a likelihood gain beyond what five more
    // parameters buy by chance (BIC), so noise doesn't split a player into four.
    const asStreet: Profile = { ...profile, streets: { [name]: numbers(mixed) } };
    if (logLik(asStreet, ds) - logLik(profile, ds) > 2.5 * Math.log(ds.length)) streets[name] = numbers(mixed);
  });
  if (Object.keys(streets).length) {
    // The base numbers now only play the other streets: fit them on those (same position weight).
    const rest = fitOn.filter((d) => !streets[STREETS[d.street]]);
    if (rest.length >= 20) profile = blend(fitRaw(rest, prior, profile.positionWeight ?? 0), prior, w);
    profile.streets = streets;
  }
  return {
    profile,
    decisions: usable.length,
    confidence: w,
    matchRate: test.length >= 25 ? matchRate(profile, test) : null,
  };
}

const numbers = (p: Numbers): Numbers => ({ foldBelow: p.foldBelow, raiseAbove: p.raiseAbove, aggression: p.aggression, bluffChance: p.bluffChance, raiseFractionOfPot: p.raiseFractionOfPot });
const grid = (lo: number, hi: number, step: number) => { const g: number[] = []; for (let v = lo; v <= hi + 1e-9; v += step) g.push(+v.toFixed(3)); return g; };

/**
 * The best profile for these decisions. positionWeight is searched too (unless `fixedWeight` is given): each weight
 * shifts every decision's thresholds by its position, and the weight whose fit explains the actions best wins.
 */
function fitRaw(ds: Decision[], prior: Profile, fixedWeight?: number): Profile {
  if (fixedWeight !== undefined) return fitAtWeight(ds, prior, fixedWeight).profile;
  let best = fitAtWeight(ds, prior, 0);
  // Position only shows with decisions from both ends of the table.
  const spread = ds.filter((d) => late(d) > 0.3).length >= 30 && ds.filter((d) => late(d) < -0.3).length >= 30;
  if (spread) for (const w of grid(0.1, 1, 0.1)) {
    const f = fitAtWeight(ds, prior, w);
    if (f.ll > best.ll + 2) best = f; // a little evidence before a weight counts (about e^2 better)
  }
  return best.profile;
}

/** Fit at one positionWeight: the five numbers, and how well (log-likelihood) they explain the actions. */
function fitAtWeight(ds: Decision[], prior: Profile, w: number): { profile: Profile; ll: number } {
  // In the bot, position moves the thresholds; equivalently it moves each decision's strength the other way.
  const raiseS = (d: Decision) => d.strength + POSITION_SHIFT.raiseAbove * w * late(d);
  const foldS = (d: Decision) => d.strength + POSITION_SHIFT.foldBelow * w * late(d);
  const bluffScale = (d: Decision) => Math.max(0, 1 + POSITION_SHIFT.bluff * w * late(d));

  // raiseAbove, aggression, bluffChance: the threshold that best explains when the player bets or raises.
  let best = { ll: -Infinity, t: prior.raiseAbove, agg: prior.aggression, bluff: prior.bluffChance };
  for (const t of grid(0.45, 0.9, 0.01)) {
    const hi = ds.filter((d) => raiseS(d) >= t), lo = ds.filter((d) => raiseS(d) < t);
    // Below the threshold the bot bets only by bluffing, at bluffChance scaled by position.
    const loBets = lo.filter((d) => aggressive(d.action)).length;
    const loExposure = lo.reduce((s, d) => s + bluffScale(d), 0);
    const bluff = Math.max(0.005, Math.min(0.25, (loBets + prior.bluffChance * 2) / (loExposure + 2)));
    const rateHi = hi.length ? (hi.filter((d) => aggressive(d.action)).length + prior.aggression * 2) / (hi.length + 2) : prior.aggression;
    // Above it the bot bets with aggression, or bluffs anyway.
    const pHi = Math.max(0.02, Math.min(0.98, rateHi));
    const agg = Math.max(0, (pHi - bluff) / (1 - bluff));
    let ll = 0;
    for (const d of hi) { const p = clampP(agg + (1 - agg) * Math.min(0.4, bluff * bluffScale(d))); ll += Math.log(aggressive(d.action) ? p : 1 - p); }
    for (const d of lo) { const p = clampP(Math.min(0.4, bluff * bluffScale(d))); ll += Math.log(aggressive(d.action) ? p : 1 - p); }
    if (ll > best.ll) best = { ll, t, agg, bluff };
  }

  // foldBelow: among bets faced without the odds (and not raised), folds sit below the threshold, calls above.
  // "Without the odds" is the bot's own test failing: strength under the pot odds and under 0.5.
  const faced = ds.filter((d) => d.toCall > 0 && !aggressive(d.action) && raiseS(d) < best.t && !worthCalling(d));
  let foldBelow = prior.foldBelow, foldLl = 0;
  if (faced.length >= 8) {
    let bestErr = Infinity;
    for (const t of grid(0.1, 0.55, 0.01)) {
      let err = 0;
      for (const d of faced) err += (d.action === "fold") !== (foldS(d) < t) ? 1 : 0;
      if (err < bestErr || (err === bestErr && Math.abs(t - prior.foldBelow) < Math.abs(foldBelow - prior.foldBelow))) { bestErr = err; foldBelow = t; }
    }
    // Scored as if the player strays from the rule 5% of the time, so it adds to the betting fit's likelihood.
    foldLl = bestErr * Math.log(0.05) + (faced.length - bestErr) * Math.log(0.95);
  }

  // raiseFractionOfPot: median of (raise-to above the minimum) / pot basis, as SizeWager computes it.
  const sizes = ds.filter((d) => aggressive(d.action) && d.amount > 0 && d.pot + d.toCall > 0)
    .map((d) => (d.amount - d.minRaiseTo) / (d.pot + d.toCall)).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const raiseFractionOfPot = sizes.length >= 5 ? sizes[Math.floor(sizes.length / 2)] : prior.raiseFractionOfPot;

  const profile = clampProfile({ foldBelow, raiseAbove: best.t, aggression: best.agg, bluffChance: best.bluff, raiseFractionOfPot, positionWeight: w });
  return { profile, ll: best.ll + foldLl };
}
const clampP = (p: number) => Math.max(0.005, Math.min(0.995, p));
const worthCalling = (d: Decision) => d.strength >= d.toCall / (d.pot + d.toCall) || d.strength >= 0.5;

/** Log-likelihood of the actions (fold / check-call / bet-raise) under the classic rule, straying 5% from its folds. */
export function logLik(profile: Profile, ds: Decision[]): number {
  let ll = 0;
  for (const d of ds) {
    const p = effective(profile, d.street, late(d));
    const k = kind(d.action);
    let pAgg: number, pFold: number;
    if (d.toCall <= 0) { pAgg = d.strength >= p.raiseAbove ? p.aggression + (1 - p.aggression) * p.bluffChance : p.bluffChance; pFold = 0; }
    else if (d.strength >= p.raiseAbove) { pAgg = p.aggression; pFold = 0; }
    else { pAgg = p.bluffChance; pFold = (1 - pAgg) * (!worthCalling(d) && d.strength < p.foldBelow ? 0.95 : 0.05); }
    const pr = k === "aggressive" ? pAgg : k === "fold" ? pFold : 1 - pAgg - pFold;
    ll += Math.log(clampP(pr));
  }
  return ll;
}

/** What the bot would most likely do (its mode) for this decision's spot. */
export function predict(profile: Profile, d: Decision): "fold" | "passive" | "aggressive" {
  const p = effective(profile, d.street, late(d));
  if (d.toCall <= 0) {
    const pBet = d.strength >= p.raiseAbove ? p.aggression + (1 - p.aggression) * p.bluffChance : p.bluffChance;
    return pBet >= 0.5 ? "aggressive" : "passive";
  }
  if (d.strength >= p.raiseAbove) return p.aggression >= 0.5 ? "aggressive" : "passive";
  if (p.bluffChance >= 0.5) return "aggressive";
  if (worthCalling(d)) return "passive";
  return d.strength < p.foldBelow ? "fold" : "passive";
}

const kind = (a: Action) => (a === "fold" ? "fold" : aggressive(a) ? "aggressive" : "passive");

/** Share of decisions where the bot's most likely choice (fold / check-call / bet-raise) is the player's. */
export function matchRate(p: Profile, ds: Decision[]): number {
  if (!ds.length) return 0;
  return ds.filter((d) => predict(p, d) === kind(d.action)).length / ds.length;
}
