/**
 * How private-table money is shown and picked. Ports of PerUi.Sol / SolExact, PerHost's stake constants and
 * Per/Unity/PerPlatform.cs PerBuyIn. Amounts are shown in SOL itself ("0.0125 SOL", "◎0.0125" on the table): Unity's
 * "$" at $1 = 0.0001 SOL read as real dollars (0.5 SOL showed as $5,000), and no SOL price is looked up. The stake
 * ladder is unchanged in lamports: LAMPORTS_PER_DOLLAR stays as its unit (0.0001 SOL).
 */
import { PlayerPrefs } from '../../app/services';

export const LAMPORTS_PER_DOLLAR = 100_000n;
/** The program's buy-in cap (config max_buy_in: 1 SOL). */
export const BUY_IN_CAP = 1_000_000_000n;
/** The game's floor for a buy-in (PerSettings.MinBuyIn). */
export const PER_MIN_BUY_IN = 2_000_000n;

/** PerHost.Stakes: Micro 0.0001/0.0002 SOL … Elite 0.01/0.025 SOL blinds (lamports). */
export const STAKES: readonly { label: string; small: bigint; big: bigint }[] = [
  { label: 'Micro 0.0001 / 0.0002 SOL', small: 1n * LAMPORTS_PER_DOLLAR, big: 2n * LAMPORTS_PER_DOLLAR },
  { label: 'Low 0.0002 / 0.0005 SOL', small: 2n * LAMPORTS_PER_DOLLAR, big: 5n * LAMPORTS_PER_DOLLAR },
  { label: 'Mid 0.001 / 0.0025 SOL', small: 10n * LAMPORTS_PER_DOLLAR, big: 25n * LAMPORTS_PER_DOLLAR },
  { label: 'High 0.0025 / 0.005 SOL', small: 25n * LAMPORTS_PER_DOLLAR, big: 50n * LAMPORTS_PER_DOLLAR },
  { label: 'Elite 0.01 / 0.025 SOL', small: 100n * LAMPORTS_PER_DOLLAR, big: 250n * LAMPORTS_PER_DOLLAR },
];
const MIN_BUY_IN_DOLLARS = [50n, 100n, 500n, 1000n, 5000n];
const maxB = (a: bigint, b: bigint) => (a > b ? a : b);
const minB = (a: bigint, b: bigint) => (a < b ? a : b);
export const stakeMinBuyIn = (level: number): bigint => maxB(10n * STAKES[level]!.big, MIN_BUY_IN_DOLLARS[level]! * LAMPORTS_PER_DOLLAR);
export const stakeMaxBuyIn = (level: number): bigint => minB(100n * STAKES[level]!.big, BUY_IN_CAP);

/** A SOL amount as a plain number: up to 4 decimals (5 below 0.001 SOL), trailing zeros dropped ("0.0125", "1.5"). */
export function solNumber(lamports: bigint | number): string {
  const l = typeof lamports === 'bigint' ? lamports : BigInt(Math.max(0, Math.trunc(lamports)));
  const v = Number(l) / 1e9;
  const digits = v !== 0 && v < 0.001 ? 5 : 4;
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** PerUi.Sol, in SOL: "0.0125 SOL". */
export function sol(lamports: bigint | number): string {
  return `${solNumber(lamports)} SOL`;
}

/** The table's compact form (seat stacks, bets, the pot): "◎0.0125". */
export function solTable(lamports: bigint | number): string {
  return `◎${solNumber(lamports)}`;
}

/** A typed SOL amount ("0.025", "0,025 SOL") as lamports, or null when it isn't a number. */
export function parseSol(text: string): bigint | null {
  const v = Number.parseFloat((text ?? '').replace(/sol|◎|\$|\s/gi, '').replace(',', '.'));
  return Number.isFinite(v) && v >= 0 ? BigInt(Math.round(v * 1e9)) : null;
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
