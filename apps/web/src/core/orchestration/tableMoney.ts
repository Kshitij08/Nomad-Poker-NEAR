import { formatN0 } from '../util/dotnetMath';

/**
 * How the table writes amounts (stacks, bets, the pot, "Call 200"). Port of Game/Views/TableMoney.cs.
 * Coins tables count chips ("1,250"); a private SOL table sets `custom` to show lamports as dollars.
 */
export const TableMoney = {
  /** Set by a SOL table (lamports to "$1.25"); null = chip counts. */
  custom: null as ((v: number) => string) | null,

  chips(v: number): string {
    return TableMoney.custom ? TableMoney.custom(v) : formatN0(v);
  },

  /** The pot and the bet slider. Same as chips() (no "$" on a Coins table). */
  pot(v: number): string {
    return TableMoney.custom ? TableMoney.custom(v) : formatN0(v);
  },
};

/** Lamports per dollar is a PER-host setting; this is PerUi.Sol's format: "$" + N0 if >= 100 or whole, else N2. */
export function formatSolDollars(lamports: number, lamportsPerDollar: number): string {
  const d = Math.max(0, lamports) / lamportsPerDollar;
  const s = d >= 100 || d === Math.floor(d)
    ? formatN0(d)
    : d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '$' + s;
}
