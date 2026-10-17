// The Agent's strategy: the five numbers HeuristicBot (Assets/Scripts/Bots) and agentBot.ts play by, plus the
// optional v2 fields (docs/AGENTS_V2.md phase 2). A profile without the optional fields plays exactly as before.

export type Numbers = {
  foldBelow: number;
  raiseAbove: number;
  aggression: number;
  bluffChance: number;
  raiseFractionOfPot: number;
};
export const STREETS = ["preflop", "flop", "turn", "river"] as const;
export type Street = (typeof STREETS)[number];

export type Profile = Numbers & {
  /** 0..1: looser and more aggressive on the button, tighter early. Absent = position is ignored. */
  positionWeight?: number;
  /** 2 = equity against pot odds and stack-to-pot ratio (HeuristicBot.DecideV2). Absent = the classic rule. */
  brain?: number;
  /** Per-street numbers, each complete. Absent street = the profile's own five numbers. */
  streets?: Partial<Record<Street, Numbers>>;
};

/** The game's presets (BotProfile.cs / NomadStrategyPanel): Guardian, Tactician, Daredevil. */
export const PRESETS: Record<string, Profile> = {
  guardian: { foldBelow: 0.38, raiseAbove: 0.74, aggression: 0.32, bluffChance: 0.03, raiseFractionOfPot: 0.5 },
  tactician: { foldBelow: 0.3, raiseAbove: 0.66, aggression: 0.52, bluffChance: 0.07, raiseFractionOfPot: 0.62 },
  daredevil: { foldBelow: 0.22, raiseAbove: 0.58, aggression: 0.72, bluffChance: 0.12, raiseFractionOfPot: 0.78 },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const KEYS: (keyof Numbers)[] = ["foldBelow", "raiseAbove", "aggression", "bluffChance", "raiseFractionOfPot"];

function clampNumbers(p: Partial<Numbers>, fallback?: Numbers): Numbers {
  const n = (k: keyof Numbers) => {
    const v = p[k] === undefined && fallback ? fallback[k] : Number(p[k]);
    if (!Number.isFinite(v)) throw Object.assign(new Error(`${k} must be a number`), { status: 400 });
    return v;
  };
  return {
    foldBelow: clamp(n("foldBelow"), 0.1, 0.55),
    raiseAbove: clamp(n("raiseAbove"), 0.45, 0.9),
    aggression: clamp(n("aggression"), 0.1, 0.95),
    bluffChance: clamp(n("bluffChance"), 0, 0.25),
    raiseFractionOfPot: clamp(n("raiseFractionOfPot"), 0.3, 1.2),
  };
}

/**
 * The bot's own limits (BotProfile.Clamped). Throws on values that aren't finite numbers. The optional fields are
 * kept only when given: positionWeight 0..1, brain 2, and street overrides (completed from the profile's numbers).
 */
export function clampProfile(p: Partial<Profile>): Profile {
  const out: Profile = clampNumbers(p);
  if (p.positionWeight !== undefined && p.positionWeight !== null) {
    const w = Number(p.positionWeight);
    if (!Number.isFinite(w)) throw Object.assign(new Error("positionWeight must be a number"), { status: 400 });
    if (w > 0) out.positionWeight = clamp(w, 0, 1);
  }
  if (Number(p.brain) === 2) out.brain = 2;
  if (p.streets && typeof p.streets === "object") {
    const streets: Partial<Record<Street, Numbers>> = {};
    for (const st of STREETS) {
      const o = (p.streets as any)[st];
      if (o && typeof o === "object") streets[st] = clampNumbers(o, out);
    }
    if (Object.keys(streets).length) out.streets = streets;
  }
  return out;
}

/** Weighted mix of two profiles (w = weight of `a`). Position mixes too (absent = 0); street overrides come from `a`. */
export function blend(a: Profile, b: Profile, w: number): Profile {
  const m = (k: keyof Numbers) => a[k] * w + b[k] * (1 - w);
  const out = clampProfile({ foldBelow: m("foldBelow"), raiseAbove: m("raiseAbove"), aggression: m("aggression"), bluffChance: m("bluffChance"), raiseFractionOfPot: m("raiseFractionOfPot") });
  const pw = (a.positionWeight ?? 0) * w + (b.positionWeight ?? 0) * (1 - w);
  if (pw > 0) out.positionWeight = clamp(pw, 0, 1);
  if (a.streets) out.streets = a.streets;
  return out;
}

// ---- the thresholds a profile plays in a spot (agentBot.ts / HeuristicBot.cs: keep the three in step)

/** How far positionWeight 1 moves the thresholds between the first seat and the button (half each way). */
export const POSITION_SHIFT = { foldBelow: 0.08, raiseAbove: 0.06, bluff: 0.75 };

/**
 * How late a seat acts, -1 (first) .. +1 (button), from the records' position (seats before the button, 0 = button)
 * capped by the number of opponents: with n opponents, n or more seats before the button is as early as it gets.
 */
export function lateness(position: number, opponents: number): number {
  if (!Number.isFinite(position) || position < 0) return 0;
  const n = Math.max(1, opponents);
  return 1 - (2 * Math.min(position, n)) / n;
}

/** The street's numbers, shifted by position. Without positionWeight and street overrides: the profile's own. */
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

/** Style tags for the marketplace cards. */
export function tags(p: Profile): string[] {
  const out: string[] = [];
  out.push(p.foldBelow >= 0.34 ? "Tight" : p.foldBelow <= 0.25 ? "Loose" : "Balanced");
  out.push(p.aggression >= 0.6 ? "Aggressive" : p.aggression <= 0.38 ? "Passive" : "Steady");
  if (p.bluffChance >= 0.1) out.push("Bluffer");
  if (p.raiseFractionOfPot >= 0.85) out.push("Big bets");
  if ((p.positionWeight ?? 0) >= 0.5) out.push("Positional");
  if (p.brain === 2) out.push("Pot odds");
  return out;
}
