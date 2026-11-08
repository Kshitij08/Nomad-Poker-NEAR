import { DotNetRandom } from '../cards/random';
import { PlayerAction, type LegalActions } from '../actions/actions';
import { BotProfile } from './botProfile';
import { toCall, type BotContext, type IPokerBot } from './botContext';
import { Equity } from './equity';
import { HandStrength } from './handStrength';
import { roundHalfEven } from '../util/dotnetMath';

const f = Math.fround;

/**
 * A believable rule-based opponent: estimates its hand strength, compares it against pot odds and its own
 * thresholds, and mixes in occasional bluffs. Each instance draws its own BotProfile.personality. Pass a seed to
 * make a bot replay identically (and identically to the Unity build: the RNG is a port of System.Random and the
 * classic brain uses float32 math). Port of Bots/HeuristicBot.cs.
 */
export class HeuristicBot implements IPokerBot {
  private readonly profile: BotProfile;
  private readonly rng: DotNetRandom;

  /** Monte-Carlo runouts per brain-2 decision. */
  static readonly EquityIterations = 240;

  /**
   * `new HeuristicBot(seed?)` — filler bot with a drawn personality (what the single-player table uses), or
   * `new HeuristicBot(profile, seed?)` — fixed strategy profile (AFK agents).
   */
  constructor(seed?: number | null);
  constructor(profile: BotProfile, seed?: number | null);
  constructor(a?: number | null | BotProfile, b?: number | null) {
    if (a instanceof BotProfile) {
      this.rng = b == null ? new DotNetRandom() : new DotNetRandom(b);
      this.profile = a.clamped();
    } else {
      this.rng = a == null ? new DotNetRandom() : new DotNetRandom(a);
      this.profile = BotProfile.personality(this.rng); // drawn from the same stream, so a seed fixes it too
    }
  }

  get Profile(): BotProfile {
    return this.profile;
  }

  decide(ctx: BotContext): PlayerAction {
    const legal = ctx.legal;
    const p = this.profile.effective(streetOf(ctx), BotProfile.lateness(ctx.position, ctx.opponentsInHand));
    if (this.profile.brain === BotProfile.BrainV2) return this.decideV2(ctx, p);

    let s = HandStrength.estimate(ctx.holeCards, ctx.community);
    s = f(s - f(f(0.03) * Math.max(0, ctx.opponentsInHand - 1))); // discount for facing more opponents
    s = f(s + f(f(this.rng.nextDouble() - 0.5) * f(0.06))); // small noise so play isn't robotic
    s = Math.max(0, Math.min(1, s));

    const call = toCall(ctx);
    if (call <= 0) {
      const valueBet = s >= p.raiseAbove && this.roll() < p.aggression;
      const bluff = this.roll() < p.bluffChance;
      if (legal.canBet && (valueBet || bluff)) return PlayerAction.bet(this.sizeWager(ctx, legal, p.raiseFractionOfPot));
      return PlayerAction.check();
    }

    const potOdds = f(f(call) / f(ctx.pot + call));

    // Strong hand: raise for value sometimes, otherwise just call.
    if (s >= p.raiseAbove) {
      if (legal.canRaise && this.roll() < p.aggression) return PlayerAction.raise(this.sizeWager(ctx, legal, p.raiseFractionOfPot));
      if (legal.canCall) return PlayerAction.call();
    }

    // Occasional bluff raise.
    if (legal.canRaise && this.roll() < p.bluffChance) return PlayerAction.raise(this.sizeWager(ctx, legal, p.raiseFractionOfPot));

    // Continue when we have the equity; fold clearly weak hands.
    const worthCalling = s >= potOdds || s >= 0.5;
    if (worthCalling && legal.canCall) return PlayerAction.call();
    if (s < p.foldBelow) return PlayerAction.fold();

    return legal.canCall ? PlayerAction.call() : PlayerAction.fold();
  }

  /** Brain 2: equity vs pot odds and stack-to-pot ratio. Not used by single-player filler bots (brain 0). */
  private decideV2(ctx: BotContext, p: BotProfile): PlayerAction {
    const legal = ctx.legal;
    const n = Math.max(1, ctx.opponentsInHand);
    const eq = Equity.estimate(ctx.holeCards, ctx.community, n, this.rng, HeuristicBot.EquityIterations);
    const hu = clamp01(HeuristicBot.headsUpEquivalent(eq, n) + (this.rng.nextDouble() - 0.5) * 0.04);
    const tc = toCall(ctx);
    const pot = ctx.pot, call = tc;
    const spr = (ctx.myStack - tc) / Math.max(1.0, pot + call);
    const street = streetOf(ctx);

    const allIn = (bet: boolean) => (bet ? PlayerAction.bet(legal.maxRaiseTo) : PlayerAction.raise(legal.maxRaiseTo));
    const size = (bet: boolean): PlayerAction => {
      if (spr < 1.5) return allIn(bet);
      const amount = this.sizeWager(ctx, legal, f(p.raiseFractionOfPot * (spr > 6 ? f(0.85) : 1)));
      // A wager that leaves under a third of the new pot behind might as well be all-in.
      if (legal.maxRaiseTo - amount < (pot + call + amount) / 3.0) return allIn(bet);
      return bet ? PlayerAction.bet(amount) : PlayerAction.raise(amount);
    };

    if (tc <= 0) {
      if (!legal.canBet) return PlayerAction.check();
      if (hu >= p.raiseAbove && (spr < 1.5 || this.roll() < valueRate(p, hu))) return size(true);
      const stab = p.bluffChance + (n === 1 && street > 0 ? 0.35 * p.aggression : 0);
      const bluffable = street < 3 ? hu < p.raiseAbove : hu < p.foldBelow + 0.1;
      if (bluffable && this.roll() < stab) return size(true);
      return PlayerAction.check();
    }

    const potOdds = call / (pot + call);
    const blindOnly = street === 0 && ctx.myCurrentBet + tc <= ctx.bigBlind;
    const betRatio = call / Math.max(1.0, pot - call);
    const vsRange = blindOnly ? eq : Math.pow(eq, 1.3 + 0.7 * Math.min(1.5, betRatio));
    const vsRangeHu = HeuristicBot.headsUpEquivalent(vsRange, n);
    const need = potOdds + 0.5 * (p.foldBelow - 0.3);

    if (vsRangeHu >= p.raiseAbove) {
      if (legal.canRaise && (spr < 1.5 || this.roll() < valueRate(p, vsRangeHu))) return size(false);
      if (legal.canCall) return PlayerAction.call();
    }
    if (legal.canRaise && spr > 2 && street < 3 && hu >= p.foldBelow && this.roll() < p.bluffChance) return size(false);
    if (legal.canCall && vsRange >= need) return PlayerAction.call();
    return PlayerAction.fold();
  }

  /** Equity against n opponents mapped to the heads-up equity at the same percentile of starting hands. */
  static headsUpEquivalent(eq: number, n: number): number {
    n = Math.max(1, Math.min(7, n));
    if (n === 1) return eq;
    const q = EQUITY_QUANTILES[n - 1]!;
    const h = EQUITY_QUANTILES[0]!;
    const last = q.length - 1;
    if (eq <= q[0]!) return (h[0]! * eq) / q[0]!;
    if (eq >= q[last]!) return h[last]! + ((1 - h[last]!) * (eq - q[last]!)) / Math.max(1e-9, 1 - q[last]!);
    let i = 1;
    while (q[i]! < eq) i++;
    const t = q[i]! > q[i - 1]! ? (eq - q[i - 1]!) / (q[i]! - q[i - 1]!) : 0;
    return h[i - 1]! + t * (h[i]! - h[i - 1]!);
  }

  private roll(): number {
    return this.rng.nextDouble();
  }

  /**
   * A legal bet/raise "to" amount around min-raise plus a fraction of the pot, jittered and snapped to a whole big
   * blind (banker's rounding, as C# Math.Round).
   */
  private sizeWager(ctx: BotContext, legal: LegalActions, fractionOfPot: number): number {
    const min = legal.minRaiseTo;
    const max = legal.maxRaiseTo;
    const potBasis = ctx.pot + toCall(ctx);

    const fraction = f(fractionOfPot * f(1 + f(f(this.rng.nextDouble() - 0.5) * f(0.24))));
    let target = min + Math.trunc(f(f(potBasis) * fraction));

    if (ctx.bigBlind > 0) {
      const rounded = roundHalfEven(target / ctx.bigBlind) * ctx.bigBlind;
      if (rounded > 0) target = rounded;
    }

    if (target < min) target = min;
    if (target > max) target = max;
    return target;
  }
}

/** How often brain 2 bets or raises a hand at or above RaiseAbove: Aggression at the threshold, 1 at the nuts. */
function valueRate(p: BotProfile, h: number): number {
  return p.aggression + (1 - p.aggression) * clamp01((h - p.raiseAbove) / Math.max(0.05, 1 - p.raiseAbove));
}

/** 0 preflop, 1 flop, 2 turn, 3 river. */
function streetOf(ctx: BotContext): number {
  const n = ctx.community?.length ?? 0;
  return n === 0 ? 0 : n <= 3 ? 1 : n === 4 ? 2 : 3;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const EQUITY_QUANTILES: readonly (readonly number[])[] = [
  [0.326, 0.349, 0.374, 0.392, 0.408, 0.420, 0.434, 0.453, 0.469, 0.481, 0.500, 0.511, 0.523, 0.536, 0.551, 0.571, 0.579, 0.600, 0.620, 0.653, 0.854],
  [0.197, 0.221, 0.233, 0.247, 0.258, 0.266, 0.283, 0.288, 0.300, 0.309, 0.320, 0.334, 0.342, 0.359, 0.369, 0.383, 0.400, 0.413, 0.442, 0.472, 0.732],
  [0.142, 0.154, 0.169, 0.179, 0.188, 0.196, 0.206, 0.212, 0.218, 0.230, 0.236, 0.249, 0.255, 0.265, 0.276, 0.291, 0.306, 0.323, 0.342, 0.373, 0.637],
  [0.103, 0.119, 0.129, 0.137, 0.148, 0.154, 0.162, 0.167, 0.172, 0.181, 0.187, 0.198, 0.203, 0.211, 0.219, 0.227, 0.247, 0.262, 0.280, 0.309, 0.561],
  [0.088, 0.096, 0.105, 0.113, 0.120, 0.126, 0.130, 0.138, 0.145, 0.151, 0.154, 0.166, 0.168, 0.174, 0.185, 0.191, 0.207, 0.220, 0.234, 0.268, 0.490],
  [0.071, 0.077, 0.088, 0.095, 0.101, 0.107, 0.112, 0.118, 0.122, 0.126, 0.133, 0.141, 0.145, 0.149, 0.160, 0.165, 0.183, 0.191, 0.204, 0.233, 0.445],
  [0.061, 0.068, 0.076, 0.083, 0.087, 0.090, 0.097, 0.100, 0.107, 0.111, 0.117, 0.123, 0.126, 0.133, 0.139, 0.145, 0.161, 0.169, 0.178, 0.211, 0.388],
];
