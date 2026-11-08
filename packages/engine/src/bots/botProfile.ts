import type { DotNetRandom } from '../cards/random';

/** C# `float` arithmetic: round to float32. */
const f = Math.fround;

/**
 * Thresholds that turn a hand-strength estimate (0..1) into an action. Port of Bots/BotProfile.cs.
 * The C# type is a struct (value semantics): every method here returns a new instance and never mutates `this`.
 * Numbers are kept as float32 values (Math.fround) so seeded play matches the Unity build.
 */
export class BotProfile {
  foldBelow = 0; // give up hands weaker than this when facing a bet (vs pot odds)
  raiseAbove = 0; // start raising/betting for value above this
  aggression = 0; // 0..1 chance to bet/raise when ahead
  bluffChance = 0; // small chance to bet a weak hand
  raiseFractionOfPot = 0; // sizing for value bets/raises

  // Agents v2. All optional: at their defaults a profile plays exactly as before.
  positionWeight = 0;
  brain = 0; // 2 = equity brain (HeuristicBot.DecideV2); else classic
  streets: BotProfile[] | null = null; // per-street numbers [preflop, flop, turn, river]
  hasStreet: boolean[] | null = null;

  static readonly BrainClassic = 1;
  static readonly BrainV2 = 2;
  static readonly PositionShiftFold = f(0.08);
  static readonly PositionShiftRaise = f(0.06);
  static readonly PositionShiftBluff = f(0.75);
  static readonly PresetConservative = 'conservative';
  static readonly PresetBalanced = 'balanced';
  static readonly PresetAggressive = 'aggressive';

  static numbers(foldBelow: number, raiseAbove: number, aggression: number, bluffChance: number, raiseFractionOfPot: number): BotProfile {
    const p = new BotProfile();
    p.foldBelow = f(foldBelow);
    p.raiseAbove = f(raiseAbove);
    p.aggression = f(aggression);
    p.bluffChance = f(bluffChance);
    p.raiseFractionOfPot = f(raiseFractionOfPot);
    return p;
  }

  clone(): BotProfile {
    const c = new BotProfile();
    Object.assign(c, this);
    return c;
  }

  /** The baseline everyone is drawn around: a competent recreational player. */
  static get Human(): BotProfile { return BotProfile.numbers(0.30, 0.66, 0.52, 0.07, 0.62); }
  static get Conservative(): BotProfile { return BotProfile.numbers(0.38, 0.74, 0.32, 0.03, 0.50); }
  static get Balanced(): BotProfile { return BotProfile.Human; }
  static get Aggressive(): BotProfile { return BotProfile.numbers(0.22, 0.58, 0.72, 0.12, 0.78); }

  /** Resolves a preset id; unknown ids fall back to Balanced. */
  static fromPreset(presetId: string | null | undefined): BotProfile {
    if (!presetId || !presetId.trim()) return BotProfile.Balanced;
    switch (presetId.trim().toLowerCase()) {
      case BotProfile.PresetConservative:
      case 'tight':
        return BotProfile.Conservative;
      case BotProfile.PresetAggressive:
      case 'loose':
        return BotProfile.Aggressive;
      default:
        return BotProfile.Balanced;
    }
  }

  /** One player's lasting tendencies, drawn around Human. Called once per bot. Draws 5 NextDouble()s in order. */
  static personality(rng: DotNetRandom): BotProfile {
    const p = BotProfile.Human;
    p.foldBelow = clamp(f(p.foldBelow + jitter(rng, f(0.07))), f(0.15), f(0.45));
    p.raiseAbove = clamp(f(p.raiseAbove + jitter(rng, f(0.06))), f(0.55), f(0.80));
    p.aggression = clamp(f(p.aggression + jitter(rng, f(0.15))), f(0.25), f(0.80));
    p.bluffChance = clamp(f(p.bluffChance + jitter(rng, f(0.04))), f(0.01), f(0.14));
    p.raiseFractionOfPot = clamp(f(p.raiseFractionOfPot + jitter(rng, f(0.15))), f(0.40), f(0.95));
    return p;
  }

  /** Clamps each field into the legal AFK-agent range. The v2 fields are kept (clamped). */
  clamped(): BotProfile {
    const c = this.clampedNumbers();
    c.positionWeight = clamp(this.positionWeight, 0, 1);
    c.brain = this.brain === BotProfile.BrainV2 ? BotProfile.BrainV2 : 0;
    if (this.streets && this.hasStreet) {
      c.streets = new Array<BotProfile>(4).fill(new BotProfile());
      c.hasStreet = [false, false, false, false];
      for (let i = 0; i < 4 && i < this.streets.length && i < this.hasStreet.length; i++) {
        if (!this.hasStreet[i]) continue;
        c.streets[i] = this.streets[i]!.clampedNumbers();
        c.hasStreet[i] = true;
      }
    }
    return c;
  }

  private clampedNumbers(): BotProfile {
    const c = new BotProfile();
    c.foldBelow = clamp(this.foldBelow, f(0.10), f(0.55));
    c.raiseAbove = clamp(this.raiseAbove, f(0.45), f(0.90));
    c.aggression = clamp(this.aggression, f(0.10), f(0.95));
    c.bluffChance = clamp(this.bluffChance, 0, f(0.25));
    c.raiseFractionOfPot = clamp(this.raiseFractionOfPot, f(0.30), f(1.20));
    return c;
  }

  /** Sets one street's five numbers (0 preflop .. 3 river). */
  withStreet(street: number, numbers: BotProfile): BotProfile {
    const c = this.clone();
    c.streets = this.streets ? [...this.streets] : new Array<BotProfile>(4).fill(new BotProfile());
    c.hasStreet = this.hasStreet ? [...this.hasStreet] : [false, false, false, false];
    c.streets[street] = numbers;
    c.hasStreet[street] = true;
    return c;
  }

  /**
   * The numbers this profile plays in a spot: the street's own if set, then shifted by position.
   * @param street 0 preflop, 1 flop, 2 turn, 3 river.
   * @param lateness -1 (first to act) .. +1 (button); see {@link BotProfile.lateness}.
   */
  effective(street: number, lateness: number): BotProfile {
    const b = this.clone();
    if (this.streets && this.hasStreet && street >= 0 && street < this.streets.length && street < this.hasStreet.length && this.hasStreet[street]) {
      const o = this.streets[street]!;
      b.foldBelow = o.foldBelow; b.raiseAbove = o.raiseAbove; b.aggression = o.aggression;
      b.bluffChance = o.bluffChance; b.raiseFractionOfPot = o.raiseFractionOfPot;
    }
    const w = f(this.positionWeight * lateness);
    if (w === 0) return b;
    b.foldBelow = clamp(f(b.foldBelow - f(BotProfile.PositionShiftFold * w)), f(0.05), f(0.60));
    b.raiseAbove = clamp(f(b.raiseAbove - f(BotProfile.PositionShiftRaise * w)), f(0.40), f(0.95));
    b.bluffChance = clamp(f(b.bluffChance * f(1 + f(BotProfile.PositionShiftBluff * w))), 0, f(0.40));
    return b;
  }

  /** How late a seat acts, -1 (first) .. +1 (button). Negative position = unknown = middle (0). */
  static lateness(position: number, opponents: number): number {
    if (position < 0) return 0;
    const n = Math.max(1, opponents);
    return f(1 - f(f(2 * Math.min(position, n)) / n));
  }
}

/** Symmetric offset in [-spread, +spread]: (float)(NextDouble()*2-1) * spread. */
function jitter(rng: DotNetRandom, spread: number): number {
  return f(f(rng.nextDouble() * 2.0 - 1.0) * spread);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
