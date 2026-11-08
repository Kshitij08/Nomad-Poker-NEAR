import { ArgumentOutOfRangeError } from '../errors';
import { OverflowError } from './errors';
import { TournamentRules } from './tournamentRules';

/** Port of the TournamentPayout struct. */
export interface TournamentPayout {
  readonly pool: number;
  readonly fee: number;
  readonly first: number;
  readonly second: number;
  /** PlayFab Economy v2 amounts are 32-bit: every move must fit. */
  readonly fitsInt32: boolean;
}

const LONG_MAX = (1n << 63n) - 1n;
const INT_MAX = 2147483647n;

/**
 * Prize maths. The pool is the host prize plus every paid entry. A platform fee, if one is ever set, comes off the
 * entries only, never the host's prize. 2nd gets 40% rounded down and 1st gets the rest, so the two prizes always add
 * up to exactly what is paid out. Port of Core/Tournament/PayoutCalculator.cs: the C# `checked` long arithmetic runs
 * in BigInt here, so overflow throws at the same 2^63 bound; amounts may be passed as bigint to reach it.
 */
export const PayoutCalculator = {
  compute(hostPrize: number | bigint, entryFee: number | bigint, paidEntrants: number, feeBps = 0): TournamentPayout {
    const prize = BigInt(hostPrize);
    const fee = BigInt(entryFee);
    if (prize < 0n) throw new ArgumentOutOfRangeError(`hostPrize: ${prize}`);
    if (fee < 0n) throw new ArgumentOutOfRangeError(`entryFee: ${fee}`);
    if (paidEntrants < 0) throw new ArgumentOutOfRangeError(`paidEntrants: ${paidEntrants}`);
    if (feeBps < 0 || feeBps > 10_000) throw new ArgumentOutOfRangeError(`feeBps: ${feeBps} (0..10000)`);

    const checkedLong = (v: bigint): bigint => {
      if (v > LONG_MAX || v < -LONG_MAX - 1n) throw new OverflowError();
      return v;
    };
    const entries = checkedLong(fee * BigInt(paidEntrants));
    const pool = checkedLong(prize + entries);
    const platformFee = checkedLong(entries * BigInt(feeBps)) / 10_000n;
    const net = pool - platformFee;
    const second = checkedLong(net * BigInt(10_000 - TournamentRules.FirstPlaceBps)) / 10_000n;
    const first = net - second;
    return Object.freeze({
      pool: Number(pool),
      fee: Number(platformFee),
      first: Number(first),
      second: Number(second),
      fitsInt32: pool <= INT_MAX,
    });
  },
} as const;
