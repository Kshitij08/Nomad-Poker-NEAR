import { ArgumentOutOfRangeError } from '../errors';

/** Port of the BlindLevel struct. */
export interface BlindLevel {
  readonly level: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
}

/** BlindLevel.ToString(): "L3 100/200". */
export function blindLevelToString(b: BlindLevel): string {
  return `L${b.level} ${b.smallBlind}/${b.bigBlind}`;
}

const FIXED_SMALL_BLINDS: readonly number[] = [25, 50, 100, 150, 200, 300, 500, 800, 1000, 1500];

/**
 * Tournament blind levels, the same every round: ten fixed steps from 25/50 to 1,500/3,000, then the blinds double
 * each level. No antes. Port of Core/Tournament/BlindSchedule.cs.
 */
export const BlindSchedule = {
  /** Levels stop rising here. Nobody reaches it with 5,000-chip stacks, but it keeps the doubling far from overflow. */
  MaxLevel: 40,

  forLevel(level: number): BlindLevel {
    if (level < 1) throw new ArgumentOutOfRangeError(`level: ${level}. Levels start at 1.`);
    if (level > BlindSchedule.MaxLevel) level = BlindSchedule.MaxLevel;
    const fixedCount = FIXED_SMALL_BLINDS.length;
    // C# `1500L << n`: a long shift. 1500 * 2^30 is exact in a double, so multiply (JS << is 32-bit).
    const small = level <= fixedCount ? FIXED_SMALL_BLINDS[level - 1]! : FIXED_SMALL_BLINDS[fixedCount - 1]! * 2 ** (level - fixedCount);
    return Object.freeze({ level, smallBlind: small, bigBlind: small * 2 });
  },
} as const;
