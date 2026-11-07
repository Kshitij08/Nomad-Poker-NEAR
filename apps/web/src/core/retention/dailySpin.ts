/**
 * Daily Coin Spin: catalog, pure rules, result. Ports of Core/Retention/DailySpinCatalog.cs and DailySpinMath.cs.
 * There is no wager and no purchase: a once-per-day reveal. Weights are parts per 1000 so a roll of 0..999 maps
 * onto exactly one prize.
 */
export interface SpinPrize {
  readonly coins: number;
  readonly weight: number;
  readonly label: string;
}

const prize = (coins: number, weight: number, label: string): SpinPrize => Object.freeze({ coins, weight, label });

/** C# default(SpinPrize): what DailySpinResult.AlreadySpun carries. */
export const EMPTY_PRIZE: SpinPrize = Object.freeze({ coins: 0, weight: 0, label: '' });

export const DailySpinCatalog = {
  WeightTotal: 1000,
  Prizes: Object.freeze([
    prize(250, 280, 'Pocket Change'),
    prize(500, 250, 'Small Stack'),
    prize(1000, 200, 'Daily Stack'),
    prize(2000, 120, 'Hot Streak'),
    prize(5000, 80, 'Big Score'),
    prize(10000, 50, 'High Roller'),
    prize(25000, 20, 'Jackpot'),
  ]) as readonly SpinPrize[],

  prizeAt(index: number): SpinPrize {
    if (!Number.isInteger(index) || index < 0 || index >= DailySpinCatalog.Prizes.length) throw new RangeError('index');
    return DailySpinCatalog.Prizes[index]!;
  },
};

export const DailySpinMath = {
  canSpin: (lastSpinDay: number, todayDay: number): boolean => lastSpinDay !== todayDay,

  /** Maps a roll in [0, 999] onto the catalog. Out-of-range rolls wrap (C# % keeps the sign, then +1000). */
  pickPrize(roll0to999: number): SpinPrize {
    let roll = Math.trunc(roll0to999) % DailySpinCatalog.WeightTotal;
    if (roll < 0) roll += DailySpinCatalog.WeightTotal;
    let cursor = 0;
    const prizes = DailySpinCatalog.Prizes;
    for (const p of prizes) {
      cursor += p.weight;
      if (roll < cursor) return p;
    }
    return prizes[prizes.length - 1]!;
  },

  prizeIndex(coins: number): number {
    const i = DailySpinCatalog.Prizes.findIndex((p) => p.coins === coins);
    return i < 0 ? 0 : i;
  },
};

export interface DailySpinResult {
  readonly awarded: boolean;
  readonly prize: SpinPrize;
  readonly error: string;
}

export const DailySpinResult = {
  alreadySpun: (): DailySpinResult => ({ awarded: false, prize: EMPTY_PRIZE, error: 'Come back tomorrow for another spin.' }),
  won: (p: SpinPrize): DailySpinResult => ({ awarded: true, prize: p, error: '' }),
};

/** Persisted Daily Spin + login-streak counters (Core/Retention/DailyEngagementState.cs). */
export interface DailyEngagementState {
  lastSpinDay: number;
  lastLoginDay: number;
  streakDay: number;
  lastSpinCoins: number;
}
