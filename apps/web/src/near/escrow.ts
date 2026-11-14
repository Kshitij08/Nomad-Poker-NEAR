/**
 * The NEAR escrow for human money tables (near/escrow, README › Escrow). Players keep a game balance there
 * (`deposit` / `withdraw`) and buy in to a house table from it and their wallet (`buy_in`): 5% rake, the rest is the
 * seat's `locked` NEAR, which the game server seats as chips (0.001 NEAR each) and cashes out when they leave.
 *
 * Reads go straight to a NEAR RPC node (rpc.ts); writes go through the player's wallet (wallet.ts). Amounts are
 * yoctoNEAR: `U128` strings from the contract, bigint here.
 */
import { StakeCatalog } from '@nomad/engine/stakes/stakes';
import { viewContract } from './rpc';
import { nearCall } from './wallet';

export const ESCROW_CONTRACT = (import.meta.env?.VITE_NEAR_ESCROW as string | undefined) ?? 'nomad-escrow.testnet';
/** One chip is 0.001 NEAR (the contract's `chip_yocto`). */
export const CHIP_YOCTO = 10n ** 21n;
/** The contract's default rake, 5%, until `get_config` says otherwise. */
export const DEFAULT_RAKE_BPS = 500;

export type EscrowTableConfig = { small_blind: number; big_blind: number; min_buy_in: number; max_buy_in: number; seats: number };
export type EscrowTable = {
  table_id: string;
  host: string | null;
  config: EscrowTableConfig;
  invite_only: boolean;
  closed: boolean;
  finalized: boolean;
  seated: number;
  bought_in: string;
  rake: string;
  locked: string;
  paid: string;
  outstanding: string;
  remainder: string;
  buy_ins: number;
  cash_outs: number;
  created_at: string;
};
export type EscrowSeat = { bought_in: string; locked: string };
export type EscrowConfig = { owner: string; operator: string; rake_bps: number; tournament_fee_bps: number; chip_yocto: string };

/** A house table: its escrow table id is also the game server room's name. */
export type HouseTable = { id: string; name: string; config: EscrowTableConfig };

/** The three house tables (Micro, Low, Mid stakes), 6 seats. The contract's `get_table` is the authority. */
export const HOUSE_TABLES: readonly HouseTable[] = [50, 100, 500].map((min) => {
  const t = StakeCatalog.get(min);
  return { id: `poker-money-st${min}`, name: `${t.displayName} stakes`, config: { small_blind: t.smallBlind, big_blind: t.bigBlind, min_buy_in: t.minBuyIn, max_buy_in: t.startingStack, seats: 6 } };
});

/** A game server room that is a NEAR money table (the verify panel shows there). */
export const isNearMoneyRoom = (session: string | null | undefined): boolean => !!session && session.startsWith('poker-money-');

// ------------------------------------------------------------------ views

const view = <T>(method: string, args: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<T> => viewContract<T>(ESCROW_CONTRACT, method, args, fetchImpl);

/** Idle game balance (what `withdraw` can take, and what `buy_in` may draw from), yoctoNEAR. */
export const getBalance = async (account: string, fetchImpl?: typeof fetch): Promise<bigint> => BigInt(await view<string>('get_balance', { account }, fetchImpl));
export const getTable = (tableId: string, fetchImpl?: typeof fetch) => view<EscrowTable | null>('get_table', { table_id: tableId }, fetchImpl);
export const getSeat = (tableId: string, player: string, fetchImpl?: typeof fetch) => view<EscrowSeat | null>('get_seat', { table_id: tableId, player }, fetchImpl);
export const getConfig = (fetchImpl?: typeof fetch) => view<EscrowConfig>('get_config', {}, fetchImpl);

// ------------------------------------------------------------------ wallet calls

/** Adds `yocto` from the wallet to the game balance. */
export const deposit = (yocto: bigint) => nearCall(ESCROW_CONTRACT, 'deposit', {}, yocto, 30n);
/** Sends `yocto` of idle game balance back to the wallet. */
export const withdraw = (yocto: bigint) => nearCall(ESCROW_CONTRACT, 'withdraw', { amount: yocto.toString() }, 0n, 50n);
/** Buys in for `plan.amount`, attaching what the game balance doesn't cover. */
export const buyIn = (tableId: string, plan: Pick<BuyInPlan, 'amount' | 'attach'>) =>
  nearCall(ESCROW_CONTRACT, 'buy_in', { table_id: tableId, amount: plan.amount.toString() }, plan.attach, 30n);

// ------------------------------------------------------------------ amounts

export const chipsToYocto = (chips: number, chipYocto = CHIP_YOCTO): bigint => BigInt(chips) * chipYocto;
/** Whole chips in a yoctoNEAR amount (rounded down): what a seat with `locked` plays with. */
export const yoctoToChips = (yocto: string | bigint, chipYocto = CHIP_YOCTO): number => Number(BigInt(yocto) / chipYocto);

export type BuyInPlan = {
  chips: number;
  /** The buy-in, yoctoNEAR. */
  amount: bigint;
  /** Taken from the game balance. */
  fromBalance: bigint;
  /** Attached from the wallet. */
  attach: bigint;
  rake: bigint;
  /** Added to the seat after rake. */
  locked: bigint;
};

/** How a buy-in of `chips` is paid: game balance first, the rest from the wallet; the contract's rake (floor). */
export function buyInPlan(chips: number, balance: bigint, rakeBps = DEFAULT_RAKE_BPS, chipYocto = CHIP_YOCTO): BuyInPlan {
  const amount = chipsToYocto(chips, chipYocto);
  const fromBalance = balance < amount ? (balance > 0n ? balance : 0n) : amount;
  const rake = (amount * BigInt(rakeBps)) / 10_000n;
  return { chips, amount, fromBalance, attach: amount - fromBalance, rake, locked: amount - rake };
}

/**
 * What's wrong with buying in for `text` chips at `table` (null: fine). `seat` is the player's seat there, if any:
 * a top-up has no minimum, but every buy-in since sitting down counts toward the maximum.
 */
export function buyInError(text: string, config: EscrowTableConfig, table: Pick<EscrowTable, 'closed' | 'seated'> | null, seat: EscrowSeat | null, chipYocto = CHIP_YOCTO): string | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return 'Enter a whole number of chips.';
  const chips = Number(t);
  if (!table) return "This table isn't open on NEAR yet.";
  if (table.closed) return 'This table is closed.';
  const already = seat ? yoctoToChips(seat.bought_in, chipYocto) : 0;
  if (!seat) {
    if (table.seated >= config.seats) return 'The table is full.';
    if (chips < config.min_buy_in) return `The minimum buy-in is ${config.min_buy_in} chips.`;
  } else if (chips <= 0) return 'Enter more than 0 chips.';
  if (already + chips > config.max_buy_in) return `The maximum buy-in is ${config.max_buy_in} chips${already ? ` (you already bought in ${already})` : ''}.`;
  return null;
}
