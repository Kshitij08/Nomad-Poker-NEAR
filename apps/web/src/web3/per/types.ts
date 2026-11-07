/**
 * Decoded poker-per accounts and instruction structs, as IdlCoder returns them. Shapes of the generated C#
 * classes (Per/Core/Generated/PokerPerIdl.cs) with camelCase fields; regenerate the list from the IDL with
 * tools/extract-web3-idl.mjs when the program changes. u64/i64 are bigints, pubkeys/byte arrays Uint8Arrays.
 */
import idl from '../../data/web3-per-idl.json';
import { IdlCoder, type SlimIdl } from '../lib/idl';

export const perIdl = new IdlCoder(idl as unknown as SlimIdl);

export interface AgentSponsor {
  bump: number;
}

export interface Config {
  version: number;
  bump: number;
  admin: Uint8Array;
  pendingAdmin: Uint8Array | null;
  devWallet: Uint8Array;
  rakeBps: number;
  maxBuyIn: bigint;
  paused: boolean;
  escapeIdleSecs: number;
  auditor: Uint8Array;
  agentFeeBps: number;
  creatorFeeBps: number;
  hostWallet: Uint8Array;
  maxHostFee: bigint;
  reserved: Uint8Array;
}

export interface ConfigArgs {
  devWallet: Uint8Array;
  rakeBps: number;
  maxBuyIn: bigint;
  paused: boolean;
  escapeIdleSecs: number;
}

export interface Deck {
  table: Uint8Array;
  handNo: bigint;
  seedMask: number;
  seeds: Uint8Array[];
  seedOwners: Uint8Array[];
  entropy: Uint8Array;
  shuffleSeed: Uint8Array;
  cards: Uint8Array;
  logSecret: Uint8Array;
}

export interface Entrant {
  wallet: Uint8Array;
  reader: Uint8Array;
  state: number;
  table: number;
  seat: number;
  place: number;
  pad: Uint8Array;
}

export interface FeeSettings {
  platformFeeBps: number;
  creatorFeeBps: number;
  hostWallet: Uint8Array;
  maxHostFee: bigint;
}

export interface FeeTerms {
  creator: Uint8Array;
  creatorFeeBps: number;
  platformFeeBps: number;
}

export interface Game {
  seatCount: number;
  smallBlind: bigint;
  bigBlind: bigint;
  seats: GameSeat[];
  button: number;
  sbSeat: number;
  bbSeat: number;
  currentSeat: number;
  toAct: number;
  street: number;
  highBet: bigint;
  minRaise: bigint;
  pot: bigint;
  runout: boolean;
  board: Uint8Array;
  boardLen: number;
}

export interface GameSeat {
  status: number;
  stack: bigint;
  currentBet: bigint;
  total: bigint;
  hasActed: boolean;
}

export interface Hand {
  table: Uint8Array;
  seat: number;
  owner: Uint8Array;
  handNo: bigint;
  cards: Uint8Array;
  reader: Uint8Array;
}

export interface HandLog {
  table: Uint8Array;
  handNo: bigint;
  hash: Uint8Array;
  secret: Uint8Array;
  len: number;
  readersLen: number;
  pad: Uint8Array;
  readers: Uint8Array[];
  auditedBy: Uint8Array;
  entries: LogEntry[];
}

export interface HandRecord {
  table: Uint8Array;
  handNo: bigint;
  button: number;
  dealtMask: number;
  seedMask: number;
  seeds: Uint8Array[];
  entropy: Uint8Array;
  shuffleSeed: Uint8Array;
  cards: Uint8Array;
  boardLen: number;
  logHash: Uint8Array;
  logLen: number;
}

export interface Invites {
  table: Uint8Array;
  count: number;
  hashes: Uint8Array[];
}

export interface Ledger {
  table: Uint8Array;
  seats: Seat[];
  escrowOwed: bigint;
  rakeAccrued: bigint;
  escrowBalance: bigint;
  totalDeposited: bigint;
  totalPaidOut: bigint;
  totalRakeCollected: bigint;
  salt: Uint8Array;
  game: Game;
}

export interface LogEntry {
  committed: bigint;
  street: number;
  seat: number;
  kind: number;
  pad: Uint8Array;
}

export interface Seat {
  player: Uint8Array;
  reader: Uint8Array;
  stack: bigint;
  deposited: bigint;
  sittingOut: boolean;
}

export interface Table {
  version: number;
  bump: number;
  status: number;
  maxSeats: number;
  seatMask: number;
  inviteOnly: boolean;
  tableId: bigint;
  creator: Uint8Array;
  mint: Uint8Array;
  smallBlind: bigint;
  bigBlind: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  rakeBps: number;
  lastActivityTs: bigint;
  ledgerHash: Uint8Array;
  ledgerSeq: bigint;
  handNo: bigint;
  handState: number;
  button: number;
  dealtMask: number;
  vrfRequestedTs: bigint;
  vrfNonce: bigint;
  shuffleStartedTs: bigint;
  turnDeadline: bigint;
  idleSince: bigint;
  lastCommitTs: bigint;
  lastRecord: HandRecord;
  committedLedgerSeq: bigint;
  committedHandNo: bigint;
  startRequestedFor: bigint;
  kind: number;
  needsSync: number;
  agentMask: number;
  reserved: Uint8Array;
}

export interface TableParams {
  smallBlind: bigint;
  bigBlind: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  maxSeats: number;
  inviteOnly: boolean;
}

export interface Tournament {
  tourneyId: bigint;
  entryFee: bigint;
  hostPrize: bigint;
  startTs: bigint;
  runningSince: bigint;
  roundStartsTs: bigint;
  vrfNonce: bigint;
  vrfRequestedTs: bigint;
  owed: bigint;
  host: Uint8Array;
  mint: Uint8Array;
  champion: Uint8Array;
  runnerUp: Uint8Array;
  tables: Uint8Array[];
  name: Uint8Array;
  codeHash: Uint8Array;
  entrants: Entrant[];
  version: number;
  bump: number;
  status: number;
  speed: number;
  maxPlayers: number;
  count: number;
  round: number;
  roundTables: number;
  doneMask: number;
  linked: number;
  seatedMask: number;
  closedMask: number;
  pad: Uint8Array;
  lastProgressTs: bigint;
  syncedHand: bigint[];
  reserved: Uint8Array;
}

export interface TourneyParams {
  name: Uint8Array;
  speed: number;
  maxPlayers: number;
  entryFee: bigint;
  startTs: bigint;
  codeHash: Uint8Array;
}

export interface WalletState {
  wallet: Uint8Array;
  keySet: number;
  vaultSeed: Uint8Array;
}

/** Account decoders (null when absent, another type, or an older shorter layout). */
export const decode = {
  agentSponsor: (d: Uint8Array | null | undefined) => perIdl.decodeAccount<AgentSponsor>('AgentSponsor', d),
  config: (d: Uint8Array | null | undefined) => perIdl.decodeAccount<Config>('Config', d),
  deck: (d: Uint8Array | null | undefined) => perIdl.decodeAccount<Deck>('Deck', d),
  hand: (d: Uint8Array | null | undefined) => perIdl.decodeAccount<Hand>('Hand', d),
  handLog: (d: Uint8Array | null | undefined) => perIdl.decodeAccount<HandLog>('HandLog', d),
  handRecord: (d: Uint8Array | null | undefined) => perIdl.decodeAccount<HandRecord>('HandRecord', d),
  invites: (d: Uint8Array | null | undefined) => perIdl.decodeAccount<Invites>('Invites', d),
  ledger: (d: Uint8Array | null | undefined) => perIdl.decodeAccount<Ledger>('Ledger', d),
  table: (d: Uint8Array | null | undefined) => perIdl.decodeAccount<Table>('Table', d),
  tournament: (d: Uint8Array | null | undefined) => perIdl.decodeAccount<Tournament>('Tournament', d),
  walletState: (d: Uint8Array | null | undefined) => perIdl.decodeAccount<WalletState>('WalletState', d),
};
