import { formatN0 } from '../util/dotnetMath';

/**
 * One free-play stake. Port of Core/Stakes/StakeTier.cs.
 * NOTE: the offline single-player table (PokerGameController) does NOT use stakes — it always plays TableSettings
 * (25/50 blinds, 5,000 stacks). Stakes drive the networked Quick Play buy-in flow; ported for when that lands.
 */
export class StakeTier {
  constructor(
    /** Minimum Coins required to sit. Also the session-name / matchmaking key. */
    readonly minBuyIn: number,
    readonly smallBlind: number,
    readonly bigBlind: number,
    /** Free-play stack granted on sit (100 big blinds). */
    readonly startingStack: number,
    readonly displayName: string,
  ) {}

  /** "25 / 50" */
  get blindsLabel(): string {
    return `${formatN0(this.smallBlind)} / ${formatN0(this.bigBlind)}`;
  }

  /** "1,000" */
  get buyInLabel(): string {
    return formatN0(this.minBuyIn);
  }
}

/** Free-play stake ladder. Port of Core/Stakes/StakeCatalog.cs. */
export const StakeCatalog = {
  DefaultMinBuyIn: 1000,

  Tiers: Object.freeze([
    new StakeTier(50, 1, 2, 200, 'Micro'),
    new StakeTier(100, 2, 5, 500, 'Low'),
    new StakeTier(500, 10, 25, 2500, 'Mid'),
    new StakeTier(1000, 25, 50, 5000, 'High'),
    new StakeTier(5000, 100, 250, 25000, 'Elite'),
    new StakeTier(10000, 250, 500, 50000, 'High Roller'),
  ]) as readonly StakeTier[],

  get Lowest(): StakeTier {
    return StakeCatalog.Tiers[0]!;
  },

  get Default(): StakeTier {
    return StakeCatalog.get(StakeCatalog.DefaultMinBuyIn);
  },

  get(minBuyIn: number): StakeTier {
    return StakeCatalog.tryGet(minBuyIn) ?? StakeCatalog.Default;
  },

  /** C# TryGet: the tier or undefined. */
  tryGet(minBuyIn: number): StakeTier | undefined {
    return StakeCatalog.Tiers.find((t) => t.minBuyIn === minBuyIn);
  },

  isKnown(minBuyIn: number): boolean {
    return StakeCatalog.tryGet(minBuyIn) !== undefined;
  },

  /**
   * The table an Agent with this bankroll plays: the highest tier whose minimum buy-in is at most a tenth of it
   * (1,000 → the 100 table, blinds 2 / 5), so one bad hand can't take the whole bankroll; never below Micro.
   */
  forAgentBankroll(bankroll: number): StakeTier {
    let best = StakeCatalog.Lowest;
    for (const t of StakeCatalog.Tiers) if (t.minBuyIn * 10 <= bankroll) best = t;
    return best;
  },

  /** Highest tier the player can currently sit at, or null if they cannot afford Micro. */
  highestAffordable(coins: number): StakeTier | null {
    let best: StakeTier | null = null;
    for (const t of StakeCatalog.Tiers) if (coins >= t.minBuyIn) best = t;
    return best;
  },

  resolve(selectedMinBuyIn: number, coins: number): StakeTier {
    if (selectedMinBuyIn > 0) {
      const chosen = StakeCatalog.tryGet(selectedMinBuyIn);
      if (chosen && coins >= chosen.minBuyIn) return chosen;
    }
    return StakeCatalog.highestAffordable(coins) ?? StakeCatalog.Lowest;
  },
};

/** StakeSelection.MaxBuyInChips: cap at the tier's full stack or what the player can afford, whichever is smaller. */
export function maxBuyInChips(tier: StakeTier, coins: number): number {
  const cap = tier.startingStack > 0 ? tier.startingStack : tier.minBuyIn;
  if (coins < tier.minBuyIn) return tier.minBuyIn;
  return Math.min(cap, coins);
}

/** StakeSelection.ClampBuyIn for a given tier/wallet. */
export function clampBuyIn(amount: number, tier: StakeTier, coins: number): number {
  const min = tier.minBuyIn;
  let max = maxBuyInChips(tier, coins);
  if (max < min) max = min;
  return amount < min ? min : amount > max ? max : amount;
}
