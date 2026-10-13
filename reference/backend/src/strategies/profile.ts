// The Agent's strategy: the five numbers HeuristicBot (Assets/Scripts/Bots) and agentBot.ts play by.

export type Profile = {
  foldBelow: number;
  raiseAbove: number;
  aggression: number;
  bluffChance: number;
  raiseFractionOfPot: number;
};

/** The game's presets (BotProfile.cs / NomadStrategyPanel): Guardian, Tactician, Daredevil. */
export const PRESETS: Record<string, Profile> = {
  guardian: { foldBelow: 0.38, raiseAbove: 0.74, aggression: 0.32, bluffChance: 0.03, raiseFractionOfPot: 0.5 },
  tactician: { foldBelow: 0.3, raiseAbove: 0.66, aggression: 0.52, bluffChance: 0.07, raiseFractionOfPot: 0.62 },
  daredevil: { foldBelow: 0.22, raiseAbove: 0.58, aggression: 0.72, bluffChance: 0.12, raiseFractionOfPot: 0.78 },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The bot's own limits (BotProfile.Clamped). Throws on values that aren't finite numbers. */
export function clampProfile(p: Partial<Profile>): Profile {
  const n = (k: keyof Profile) => {
    const v = Number(p[k]);
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

/** Weighted mix of two profiles (w = weight of `a`). */
export function blend(a: Profile, b: Profile, w: number): Profile {
  const m = (k: keyof Profile) => a[k] * w + b[k] * (1 - w);
  return clampProfile({ foldBelow: m("foldBelow"), raiseAbove: m("raiseAbove"), aggression: m("aggression"), bluffChance: m("bluffChance"), raiseFractionOfPot: m("raiseFractionOfPot") });
}

/** Style tags for the marketplace cards. */
export function tags(p: Profile): string[] {
  const out: string[] = [];
  out.push(p.foldBelow >= 0.34 ? "Tight" : p.foldBelow <= 0.25 ? "Loose" : "Balanced");
  out.push(p.aggression >= 0.6 ? "Aggressive" : p.aggression <= 0.38 ? "Passive" : "Steady");
  if (p.bluffChance >= 0.1) out.push("Bluffer");
  if (p.raiseFractionOfPot >= 0.85) out.push("Big bets");
  return out;
}
