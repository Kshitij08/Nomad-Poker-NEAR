/**
 * The chain seam: everything the On-chain screens need from a blockchain, with no chain's own types. Amounts are whole
 * base units (`bigint`), addresses and account ids are strings. One chain is registered at boot (web3/install.ts today);
 * screens call `chainMoney()` for formatting while they render and `await chain()` for actions, which loads the chain's
 * code on first use.
 */

/** Progress lines while an action runs. */
export type Status = (s: string) => void;

export interface Stake {
  label: string;
  small: bigint;
  big: bigint;
}

/** Formatting, stake levels and the lobby's buy-in choice. Synchronous: screens use it while rendering. */
export interface ChainMoney {
  /** The ticker, e.g. "SOL". */
  symbol: string;
  /** The ui2 icon for the currency. */
  icon: string;
  /** An amount for display, e.g. "0.05". */
  format(units: bigint | number): string;
  /** The private-table stake levels, cheapest first. */
  stakes: readonly Stake[];
  minBuyIn(level: number): bigint;
  maxBuyIn(level: number): bigint;
  /** The lobby's buy-in choice (Min, 25 BB, 50 BB, Max), remembered between visits. */
  buyIn: { readonly labels: readonly string[]; choice: number; for(minBuyIn: bigint, maxBuyIn: bigint, bigBlind: bigint): bigint };
}

// ------------------------------------------------------------------------------------------------ private tables

export interface LobbyTable {
  address: string;
  creator: string;
  smallBlind: bigint;
  bigBlind: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  /** The buy-in for Join, inside the table's limits. */
  buyIn: bigint;
  seated: number;
  maxSeats: number;
  inviteOnly: boolean;
  /** Hosted by this player. */
  mine: boolean;
  /** An invite link for it was opened in this browser. */
  haveLink: boolean;
}

/** One of "Your tables". */
export interface HostedRow {
  id: bigint;
  address: string;
  state: 'old-list' | 'closed' | 'open' | 'unlisted' | 'not-open' | 'pending';
  seated: number;
  maxSeats: number;
  /** Invite links apply. */
  links: boolean;
  /** The table's invite link, when this browser made the current one. */
  link: string | null;
  /** For 'unlisted': the buy-in for Join. */
  buyIn: bigint;
  pending: string;
}

export interface LobbyRead {
  tables: LobbyTable[];
  hosted: HostedRow[];
  /** The table an invite link named, when it isn't open. */
  linkedClosed: string | null;
}

export interface TableLimits {
  smallBlind: bigint;
  bigBlind: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
}

export interface HostTableOptions {
  /** Index into `ChainMoney.stakes`. */
  stake: number;
  seats: number;
  inviteOnly: boolean;
  /** Account ids or addresses allowed to join an invite-only table. */
  invitees: string[];
}

export interface ChainLobby {
  read(): Promise<LobbyRead>;
  /** Buys in and opens the table. False when the player backed out. */
  join(table: string, buyIn: bigint, st: Status, expect?: TableLimits | null): Promise<boolean>;
  host(o: HostTableOptions, st: Status): Promise<void>;
  open(row: HostedRow, st: Status): Promise<void>;
  close(row: HostedRow, st: Status): Promise<void>;
  reclaim(row: HostedRow, st: Status): Promise<void>;
  newInviteLink(row: HostedRow, st: Status): Promise<void>;
  closeOldInvites(id: bigint, st: Status): Promise<void>;
  /** Whether the text is a valid account id or address on this chain. */
  isAccount(text: string): boolean;
  /** Signs this player out of the game on every device (revokes their table keys). */
  revokeSessions(st: Status): Promise<void>;
}

// ------------------------------------------------------------------------------------------------ agents

export interface AgentLimits {
  /** Indexes into `ChainAgent.options`. */
  stake: number;
  buyIn: number;
  hands: number;
  minutes: number;
  loss: number;
  profit: number;
}

export interface AgentSession {
  when: string;
  table: string;
  hands: number;
  buyIn: bigint;
  /** Result so far (cash-out or current stack minus buy-in). */
  net: bigint;
  /** 'playing', or why it ended. */
  result: string;
}

export interface AgentRead {
  /** none: no wallet · setup: not set up on this device yet · ok: read. */
  state: 'none' | 'setup' | 'ok';
  status: string;
  detail: string;
  sessions: AgentSession[];
}

/** A copied marketplace strategy: only its name is read here; the chain passes the rest through. */
export interface CopyTerms {
  name: string;
}

export interface ChainAgent {
  options: {
    STAKES: readonly bigint[];
    BUY_IN_BB: readonly number[];
    HANDS: readonly number[];
    MINUTES: readonly number[];
    LOSS_PCT: readonly number[];
    PROFIT_PCT: readonly number[];
  };
  /** "playing", "leaving", "not started", "stopped". */
  label(status: string): string;
  read(): Promise<AgentRead>;
  deploy(limits: AgentLimits, profile: Record<string, unknown>, copy: CopyTerms | null, st: Status): Promise<void>;
  /** Returns the message to show once it stopped. */
  stop(st: Status): Promise<string>;
  /** The message shown after a deploy. */
  deployedText(stakeText: string, copy: CopyTerms | null): string;
}

// ------------------------------------------------------------------------------------------------ tournaments

export interface Tourney {
  address: string;
  name: string;
  isPrivate: boolean;
  phase: 'registering' | 'drawing' | 'running' | 'cancelled' | 'finished';
  /** "Starts in 12 min", "Round 2 · level 3", … */
  when: string;
  count: number;
  max: number;
  fee: bigint;
  first: bigint;
  second: bigint;
  host: boolean;
  you: 'none' | 'in' | 'out';
  place: number;
  canRegister: boolean;
  /** Your table once your round runs (-1: none). */
  table: number;
  ready: boolean;
}

export interface TourneyOptions {
  name: string;
  /** Index into `choices.SPEED_LABELS`. */
  speed: number;
  players: number;
  fee: number;
  prize: number;
  start: number;
  isPrivate: boolean;
}

export interface ChainTourneys {
  choices: {
    PLAYERS: readonly number[];
    FEES: readonly bigint[];
    PRIZES: readonly bigint[];
    START_MINUTES: readonly number[];
    SPEED_LABELS: readonly string[];
    /** The default speed. */
    TURBO: number;
  };
  read(): Promise<Tourney[]>;
  register(address: string, code: string | null, st: Status): Promise<void>;
  leaveOrCancel(address: string, cancel: boolean, st: Status): Promise<void>;
  findByCode(code: string): Promise<string | null>;
  goToTable(address: string, table: number, st: Status): Promise<void>;
  /** Returns the private code, or null for a public tournament. */
  create(o: TourneyOptions, st: Status): Promise<string | null>;
}

export interface ChainService {
  id: string;
  money: ChainMoney;
  /** Connects the player's wallet when the menu's own connect isn't ready yet. True when connected. */
  connectWallet(): Promise<boolean>;
  lobby: ChainLobby;
  agent: ChainAgent;
  tourneys: ChainTourneys;
}

// ------------------------------------------------------------------------------------------------ registry

let registered: { money: ChainMoney; load: () => Promise<ChainService> } | null = null;
let loading: Promise<ChainService> | null = null;

/** Called once at boot by the chain's module. */
export function registerChain(money: ChainMoney, load: () => Promise<ChainService>): void {
  registered = { money, load };
  loading = null;
}

/** The registered chain's money: safe to call while rendering. */
export function chainMoney(): ChainMoney {
  if (!registered) throw new Error('No chain is registered');
  return registered.money;
}

/** The registered chain's actions, loaded on first use. A failed load is retried on the next call. */
export function chain(): Promise<ChainService> {
  if (!registered) return Promise.reject(new Error('No chain is registered'));
  loading ??= registered.load();
  loading.catch(() => (loading = null));
  return loading;
}

/** "1st", "2nd", "23rd", "11th". */
export const ordinal = (n: number): string => n + ([11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
