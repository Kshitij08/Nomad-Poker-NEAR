/**
 * Prize maths — the backend's copy of Poker.Core.PayoutCalculator (Assets/Scripts/Core/Tournament).
 * The pool is the host prize plus every paid entry; a platform fee, if one is ever set, comes off the
 * entries only. 2nd gets 40% rounded down and 1st gets the rest, so the prizes add up to exactly what
 * is paid out. test/payout.test.ts checks the same numbers as PayoutCalculatorTests.
 */

export const FIRST_PLACE_BPS = 6000;
export const MAX_CHIP_AMOUNT = 2_147_483_647;   // PlayFab Economy v2 amounts are 32-bit

export interface Payout {
  pool: number;
  fee: number;
  first: number;
  second: number;
}

export function computePayout(hostPrize: number, entryFee: number, paidEntrants: number, feeBps = 0): Payout {
  for (const [name, value] of Object.entries({ hostPrize, entryFee, paidEntrants })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new RangeError("feeBps must be 0..10000");

  const entries = entryFee * paidEntrants;
  const pool = hostPrize + entries;
  if (!Number.isSafeInteger(pool)) throw new RangeError("Prize pool overflow");

  const fee = Math.floor((entries * feeBps) / 10_000);
  const net = pool - fee;
  const second = Math.floor((net * (10_000 - FIRST_PLACE_BPS)) / 10_000);
  return { pool, fee, first: net - second, second };
}
