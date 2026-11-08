// Copy-strategy profit share: 8% of a copier's new profit to the strategy's creator, 2% to Nomad, never on losses.
// High-water mark per (copier, strategy): a copier who lost 100 and then won 100 back pays nothing.

export const CREATOR_FEE_BPS = 800;
export const PLATFORM_FEE_BPS = 200;

export type Position = { cumulativePnl: number; highWater: number };
export type Settlement = {
  sessionPnl: number;
  feeBase: number;      // the profit fees are charged on
  creatorFee: number;
  platformFee: number;
  copierKeeps: number;  // session result after fees
  next: Position;
};

/** Settles one finished copied session. Amounts are whole Coins (integers). */
export function settleCopy(prev: Position, sessionPnl: number): Settlement {
  if (!Number.isSafeInteger(sessionPnl) || !Number.isSafeInteger(prev.cumulativePnl) || !Number.isSafeInteger(prev.highWater))
    throw new Error("amounts must be whole numbers");
  const cumulative = prev.cumulativePnl + sessionPnl;
  // The peak never drops; a new peak above the old one is new profit. It can't exceed this session's profit, because
  // the previous cumulative result was at or below the previous peak.
  const feeBase = Math.max(0, cumulative - prev.highWater);
  const creatorFee = Math.floor((feeBase * CREATOR_FEE_BPS) / 10_000);
  const platformFee = Math.floor((feeBase * PLATFORM_FEE_BPS) / 10_000);
  return {
    sessionPnl,
    feeBase,
    creatorFee,
    platformFee,
    copierKeeps: sessionPnl - creatorFee - platformFee,
    next: { cumulativePnl: cumulative, highWater: Math.max(prev.highWater, cumulative) },
  };
}
