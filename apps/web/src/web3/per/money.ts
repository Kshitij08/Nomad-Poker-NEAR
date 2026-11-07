/**
 * How private-table money is shown and picked. Ports of PerUi.Sol / SolExact, PerHost's stake constants and
 * Per/Unity/PerPlatform.cs PerBuyIn. The game shows SOL in "$" at $1 = 0.0001 SOL (devnet play money).
 */
import { PlayerPrefs } from '../../app/services';
import { formatN0 } from './format';

export const LAMPORTS_PER_DOLLAR = 100_000n;
/** The program's buy-in cap (config max_buy_in: 1 SOL). */
export const BUY_IN_CAP = 1_000_000_000n;
/** The game's floor for a buy-in (PerSettings.MinBuyIn). */
export const PER_MIN_BUY_IN = 2_000_000n;

/** PerHost.Stakes: Micro $1/$2 … Elite $100/$250 (lamports). */
export const STAKES: readonly { label: string; small: bigint; big: bigint }[] = [
  { label: 'Micro $1 / $2', small: 1n * LAMPORTS_PER_DOLLAR, big: 2n * LAMPORTS_PER_DOLLAR },
  { label: 'Low $2 / $5', small: 2n * LAMPORTS_PER_DOLLAR, big: 5n * LAMPORTS_PER_DOLLAR },
  { label: 'Mid $10 / $25', small: 10n * LAMPORTS_PER_DOLLAR, big: 25n * LAMPORTS_PER_DOLLAR },
  { label: 'High $25 / $50', small: 25n * LAMPORTS_PER_DOLLAR, big: 50n * LAMPORTS_PER_DOLLAR },
  { label: 'Elite $100 / $250', small: 100n * LAMPORTS_PER_DOLLAR, big: 250n * LAMPORTS_PER_DOLLAR },
];
const MIN_BUY_IN_DOLLARS = [50n, 100n, 500n, 1000n, 5000n];
const maxB = (a: bigint, b: bigint) => (a > b ? a : b);
const minB = (a: bigint, b: bigint) => (a < b ? a : b);
export const stakeMinBuyIn = (level: number): bigint => maxB(10n * STAKES[level]!.big, MIN_BUY_IN_DOLLARS[level]! * LAMPORTS_PER_DOLLAR);
export const stakeMaxBuyIn = (level: number): bigint => minB(100n * STAKES[level]!.big, BUY_IN_CAP);

/** PerUi.Sol: "$1,250" or "$2.50". */
export function sol(lamports: bigint | number): string {
  const l = typeof lamports === 'bigint' ? lamports : BigInt(Math.max(0, Math.trunc(lamports)));
  const d = Number(l) / Number(LAMPORTS_PER_DOLLAR);
  return '$' + (d >= 100 || d === Math.floor(d) ? formatN0(d) : d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

/** PerUi.SolExact: "0.0125 SOL". */
export function solExact(lamports: bigint | number): string {
  const v = Number(lamports) / 1e9;
  return `${Number(v.toFixed(4))} SOL`;
}

/** PerBuyIn: the buy-in the player picked in the lobby (Min, 25 BB, 50 BB, Max), remembered in this browser. */
export const PerBuyIn = {
  labels: ['Min', '25 BB', '50 BB', 'Max'] as const,
  PREF: 'per.buyin.choice',
  get choice(): number {
    return Math.min(Math.max(PlayerPrefs.getInt(this.PREF, 0), 0), this.labels.length - 1);
  },
  set choice(v: number) {
    PlayerPrefs.setInt(this.PREF, Math.min(Math.max(v, 0), this.labels.length - 1));
  },
  /** The amount for a table with these limits: the choice in big blinds, at least the table's min and the floor. */
  for(minBuyIn: bigint, maxBuyIn: bigint, bigBlind: bigint, choice?: number): bigint {
    const c = choice ?? this.choice;
    const bbs = [0n, 25n, 50n, -1n];
    const floor = maxB(minBuyIn, PER_MIN_BUY_IN);
    const want = c === 0 ? floor : c === this.labels.length - 1 ? maxBuyIn : bigBlind > 0n ? bbs[c]! * bigBlind : maxBuyIn;
    return minB(maxB(want, floor), maxB(maxBuyIn, floor));
  },
};
