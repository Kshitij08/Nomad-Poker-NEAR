/**
 * M11: on-chain tournaments, the client side: addresses, the program's instructions, and the rules the game shows
 * (blinds, prizes). Port of Per/Core/PerTourney.cs (shared by the game and the headless harness).
 */
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { concat, isZero, u64le, utf8 } from '../lib/bytes';
import { ataOf, findPda, perConfigAddress, permissionOf, PerIds, PerTableAddresses } from './addresses';
import { PerHost } from './host';
import { buildPerIx, PerIx } from './ix';
import { decode, type Ledger, type Tournament, type TourneyParams } from './types';
import { vaultOf, vaultTokenOf, walletStateOf, type PlayKey } from './vault';

const dlp = (tag: string, account: PublicKey) => findPda(PerIds.delegationProgram, utf8(tag), account.toBytes());
const bufferOf = (account: PublicKey, ownerProgram: PublicKey) => findPda(ownerProgram, utf8('buffer'), account.toBytes());

const SEATS = 8;
const ENTRANT_PLAYING = 1;
const TURBO = 0;
const SLOW = 2;
const BLIND_LEVELS = [25n, 50n, 100n, 150n, 200n, 300n, 500n, 800n, 1_000n, 1_500n];

const address = (host: PublicKey, id: bigint): PublicKey => findPda(PerIds.program, utf8('tourney'), host.toBytes(), u64le(id));
const escrow = (tourney: PublicKey): PublicKey => ataOf(tourney);
/** The tournament's table `index`: a table whose creator is the tournament and whose id is the index. */
const tableAddress = (tourney: PublicKey, index: number): PublicKey => PerHost.tableAddress(tourney, BigInt(index));
const escapePayer = (account: PublicKey): PublicKey => PerHost.escapePayer(account);

/** The play-key money accounts tourney_fund/register/leave/cancel share. */
const money = (tourney: PublicKey, k: PlayKey): Record<string, PublicKey> => ({
  play_key: k.key.publicKey, wallet: k.wallet, vault: vaultOf(k.wallet), wallet_state: walletStateOf(k.wallet),
  vault_token: vaultTokenOf(k.wallet), config: perConfigAddress(), tourney, escrow: escrow(tourney),
});

const tableNamed = (tourney: PublicKey, t: PerTableAddresses): Record<string, PublicKey> => ({
  tourney, table: t.table, ledger: t.ledger, ledger_permission: t.ledgerPermission,
});

function levelSeconds(speed: number): bigint {
  return speed === TURBO ? 300n : speed === SLOW ? 720n : 480n;
}

export const PerTourney = {
  MAX_ENTRANTS: 30,
  SEATS,
  MAX_TABLES: 5,
  START_STACK: 5_000n,
  REGISTERING: 0, DRAWING: 1, RUNNING: 2, FINISHED: 3, PAID: 4, CANCELLED: 5,
  ENTRANT_REGISTERED: 0, ENTRANT_PLAYING, ENTRANT_OUT: 2, ENTRANT_REFUNDED: 3,
  TURBO, REGULAR: 1, SLOW,
  NO_TABLE: 255,
  /** The game asks for at least 10 minutes' notice (the GDD); the program allows 2. */
  MIN_LEAD_SECONDS: 600,
  SPEED_LABELS: ['Turbo (5 min levels)', 'Regular (8 min)', 'Slow (12 min)'] as readonly string[],

  address,
  escrow,
  tableAddress,
  escapePayer,

  decode: (data: Uint8Array | null | undefined): Tournament | null => decode.tournament(data),

  nameOf(t: Tournament): string {
    const n = t.name.indexOf(0);
    return new TextDecoder().decode(t.name.subarray(0, n < 0 ? t.name.length : n));
  },

  nameBytes(name: string | null | undefined): Uint8Array {
    const b = new Uint8Array(40);
    b.set(utf8(name ?? '').subarray(0, 40));
    return b;
  },

  /** sha256(tournament, code): what the program checks a private tournament's code against. */
  codeHash: (tourney: PublicKey, code: Uint8Array): Uint8Array => sha256(concat(tourney.toBytes(), code)),

  // ---------------------------------------------------------------------------- rules (as the program)

  smallBlind(level: number): bigint {
    if (level < BLIND_LEVELS.length) return BLIND_LEVELS[Math.max(level, 0)]!;
    const extra = Math.min(level - BLIND_LEVELS.length + 1, 40);
    return BigInt.asUintN(64, 1_500n << BigInt(extra));
  },

  levelSeconds,

  levelAt(t: Tournament, now: bigint | number): number {
    if (t.runningSince === 0n) return 0;
    const d = (BigInt(now) - t.runningSince) / levelSeconds(t.speed);
    return d > 0n ? Number(d) : 0;
  },

  /** (first, second, platform fee) as `tourney_payout` pays them. */
  payouts(entryFee: bigint, entrants: number, hostPrize: bigint): { first: bigint; second: bigint; fee: bigint } {
    const u = (v: bigint) => BigInt.asUintN(64, v); // C# ulong arithmetic wraps
    const fees = u(entryFee * BigInt(entrants));
    const fee = u(fees * 500n) / 10_000n;
    const pool = u(fees + hostPrize - fee);
    const second = u(pool * 40n) / 100n;
    return { first: pool - second, second, fee };
  },

  tablesFor: (n: number): number => (n <= SEATS ? 1 : Math.floor((n + SEATS - 1) / SEATS)),

  // ---------------------------------------------------------------------------- instructions

  /** L1, one transaction signed by the host: create the tournament (and its escrow) and hand it to the rollup. */
  createAndDelegate(host: PublicKey, id: bigint, p: TourneyParams): TransactionInstruction[] {
    const t = address(host, id);
    const eata = findPda(PerIds.esplProgram, t.toBytes(), PerIds.nativeMint.toBytes());
    const perm = permissionOf(eata);
    const create = buildPerIx('create_tournament', { tourneyId: id, params: p }, {
      host, config: perConfigAddress(), tourney: t, escrow: escrow(t), escrow_eata: eata,
      escrow_buffer: bufferOf(eata, PerIds.esplProgram), escrow_delegation_record: dlp('delegation', eata), escrow_delegation_metadata: dlp('delegation-metadata', eata),
      escrow_permission: perm, escrow_permission_buffer: bufferOf(perm, PerIds.permissionProgram),
      escrow_permission_delegation_record: dlp('delegation', perm), escrow_permission_delegation_metadata: dlp('delegation-metadata', perm),
    });
    const handOver = buildPerIx('delegate_tournament', { tourneyId: id, host: host.toBytes() }, {
      payer: host, buffer_tourney: bufferOf(t, PerIds.program), delegation_record_tourney: dlp('delegation', t),
      delegation_metadata_tourney: dlp('delegation-metadata', t), tourney: t, escape_payer: escapePayer(t),
    });
    return [PerIx.computeLimit(400_000), create, handOver];
  },

  /** L1, signed by `payer` (the keeper): create the tournament's table `index` and hand it to the rollup. Then
   * `open` (PerHost) and `link` in the rollup. */
  createTable(payer: PublicKey, host: PublicKey, id: bigint, index: number): TransactionInstruction[] {
    const t = address(host, id);
    const table = tableAddress(t, index);
    const create = buildPerIx('create_tourney_table', { tourneyId: id, host: host.toBytes(), index: BigInt(index) }, { payer, tourney: t, table });
    const handOver = buildPerIx('delegate_table', { tableId: BigInt(index), creator: t.toBytes() }, {
      payer, buffer_table: bufferOf(table, PerIds.program), delegation_record_table: dlp('delegation', table),
      delegation_metadata_table: dlp('delegation-metadata', table), table, escape_payer: escapePayer(table),
    });
    return [create, handOver];
  },

  /** Rollup, the host's play key (its check first): put prize money in from the game balance. */
  fund: (tourney: PublicKey, host: PlayKey, amount: bigint): TransactionInstruction[] =>
    [host.check(), buildPerIx('tourney_fund', { expires: host.expires, amount }, money(tourney, host))],

  /** Rollup, the player's play key: register (the entry fee from the game balance). `reader` is the player's table
   * key for this tournament; `code` only for a private one. */
  register: (tourney: PublicKey, k: PlayKey, reader: PublicKey, code: Uint8Array | null = null): TransactionInstruction[] =>
    [k.check(), buildPerIx('tourney_register', { expires: k.expires, reader: reader.toBytes(), code }, money(tourney, k))],

  leave: (tourney: PublicKey, k: PlayKey): TransactionInstruction[] =>
    [k.check(), buildPerIx('tourney_leave', { expires: k.expires }, money(tourney, k))],

  cancel: (tourney: PublicKey, host: PlayKey): TransactionInstruction[] =>
    [host.check(), buildPerIx('tourney_cancel', { expires: host.expires }, money(tourney, host))],

  /** Rollup, anyone: after a cancellation, pay `wallet` back. */
  refund: (tourney: PublicKey, wallet: PublicKey): TransactionInstruction =>
    buildPerIx('tourney_refund', {}, {
      tourney, escrow: escrow(tourney), wallet, vault: vaultOf(wallet), wallet_state: walletStateOf(wallet), vault_token: vaultTokenOf(wallet),
    }),

  /** Rollup, anyone: pay the champion, the runner-up and the platform fee. */
  payout: (tourney: PublicKey, champion: PublicKey, runnerUp: PublicKey, devWallet: PublicKey): TransactionInstruction =>
    buildPerIx('tourney_payout', {}, {
      config: perConfigAddress(), tourney, escrow: escrow(tourney),
      champion, champion_vault: vaultOf(champion), champion_state: walletStateOf(champion), champion_token: vaultTokenOf(champion),
      runner_up: runnerUp, runner_up_vault: vaultOf(runnerUp), runner_up_state: walletStateOf(runnerUp), runner_up_token: vaultTokenOf(runnerUp),
      dev_token: ataOf(devWallet),
    }),

  link(tourney: PublicKey, index: number): TransactionInstruction {
    const t = new PerTableAddresses(tableAddress(tourney, index));
    return buildPerIx('tourney_link_table', {}, { tourney, table: t.table, ledger: t.ledger });
  },

  start: (tourney: PublicKey, payer: PublicKey): TransactionInstruction =>
    buildPerIx('tourney_start', {}, { payer, tourney, program_identity: findPda(PerIds.program, utf8('identity')) }),

  /** Rollup, anyone: seat this round's players at table `index` (`seats`: the seats being taken). */
  seatTable(tourney: PublicKey, index: number, seats: Iterable<number>): TransactionInstruction {
    const t = new PerTableAddresses(tableAddress(tourney, index));
    const ix = buildPerIx('tourney_seat_table', {}, tableNamed(tourney, t));
    for (const s of [...seats].sort((a, b) => a - b)) {
      ix.keys.push({ pubkey: t.hand(s), isSigner: false, isWritable: true });
      ix.keys.push({ pubkey: t.handPermission(s), isSigner: false, isWritable: true });
    }
    return ix;
  },

  /**
   * Rollup, the player's play key: replace the player's table key for this tournament (a browser that lost it). Pass
   * `tableIndex` and `seat` when they're seated this round (the table must be between hands); -1 otherwise.
   */
  setReader(tourney: PublicKey, k: PlayKey, reader: PublicKey, tableIndex: number, seat: number): TransactionInstruction {
    const none = PerIds.program; // Anchor's "no account" for an optional one
    const named: Record<string, PublicKey> = {
      play_key: k.key.publicKey, wallet: k.wallet, wallet_state: walletStateOf(k.wallet), tourney,
      table: none, ledger: none, ledger_permission: none, hand: none, hand_permission: none,
    };
    if (tableIndex >= 0 && seat >= 0) {
      const t = new PerTableAddresses(tableAddress(tourney, tableIndex));
      named.table = t.table; named.ledger = t.ledger; named.ledger_permission = t.ledgerPermission;
      named.hand = t.hand(seat); named.hand_permission = t.handPermission(seat);
    }
    return buildPerIx('tourney_set_reader', { expires: k.expires, reader: reader.toBytes() }, named);
  },

  /** Rollup, anyone, between hands: blinds, eliminations, the end of the table's round. */
  sync: (tourney: PublicKey, index: number): TransactionInstruction =>
    buildPerIx('tourney_sync', {}, tableNamed(tourney, new PerTableAddresses(tableAddress(tourney, index)))),

  /**
   * The seats waiting to be taken at table `index` this round, from the tournament (the ledger says which are already
   * taken; a seat is listed only if the caller's ledger shows it empty).
   */
  seatsToTake(t: Tournament, index: number, ledger: Ledger | null): number[] {
    const seats: number[] = [];
    for (let e = 0; e < t.count; e++) {
      const en = t.entrants[e]!;
      if (en.state !== ENTRANT_PLAYING || en.table !== index || en.seat >= SEATS) continue;
      const p = ledger?.seats[en.seat]?.player;
      if (ledger && p && !isZero(p)) continue;
      seats.push(en.seat);
    }
    return seats;
  },
};
