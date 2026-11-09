import { decodeSeat, decodeTable, EscrowError, programErrorCode, SEAT_ACCOUNT_SIZE, systemTransfer, type SeatAccount, type TableAccount } from './accounts';
import { EscrowAuthority, ESCROW_PROGRAM_ID, MAX_DELTAS, type ChipDelta } from './escrow';
import { address, toBase58, type Address } from './pubkey';
import type { SolanaRpc } from './rpc';
import { compileMessage, signTransaction, type Instruction, type Signer } from './transaction';

/** A transaction the program (or the cluster) refused; `code` is the program's error code when it gave one. */
export class EscrowTxError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
  }
}

export interface EscrowClientOptions {
  programId?: string;
  /** Between confirmation polls (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * The game server's side of the poker-escrow program: reads table and seat accounts, and signs the settlement
 * authority's instructions with the server's own key (docs/phase-6-design.md). Every send waits for confirmation.
 */
export class EscrowClient {
  readonly program: EscrowAuthority;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: NonNullable<EscrowClientOptions['log']>;

  constructor(readonly rpc: SolanaRpc, readonly signer: Signer, opts: EscrowClientOptions = {}) {
    this.program = new EscrowAuthority(opts.programId ?? ESCROW_PROGRAM_ID, signer.publicKey);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
  }

  get authority(): string {
    return toBase58(this.signer.publicKey);
  }
  get programId(): string {
    return toBase58(this.program.programId);
  }

  // ---- reads

  async table(tableId: string): Promise<TableAccount | null> {
    const d = await this.rpc.accountData(toBase58(this.program.table(tableId)));
    return d ? decodeTable(d) : null;
  }

  async seat(tableId: string, player: string): Promise<SeatAccount | null> {
    const d = await this.rpc.accountData(toBase58(this.program.seat(tableId, address(player))));
    return d ? decodeSeat(d) : null;
  }

  /** These wallets' seats at the table (one getMultipleAccounts call); wallets without a seat are left out. */
  async seatsFor(tableId: string, wallets: string[]): Promise<SeatAccount[]> {
    const unique = [...new Set(wallets)];
    if (unique.length === 0) return [];
    const accts = await this.rpc.accounts(unique.map((w) => toBase58(this.program.seat(tableId, address(w)))));
    return accts.flatMap((a) => (a ? [decodeSeat(a.data)] : []));
  }

  /**
   * Every seat at the table. Starts from the wallets the caller knows (the players it seated). When those don't account
   * for every seat and pending chip the table records (someone bought in without sitting), it looks further:
   * getProgramAccounts where the RPC allows it (free tiers often don't), else the fee payers of the table's own
   * transactions, which is where every buy-in shows up.
   */
  async seatsOf(tableId: string, known: string[] = []): Promise<SeatAccount[]> {
    const table = await this.table(tableId);
    if (!table) return [];
    const complete = (seats: SeatAccount[]) => seats.length >= table.seatedCount && seats.reduce((s, x) => s + x.pendingChips, 0n) >= table.pendingChipsInPlay;
    let seats = await this.seatsFor(tableId, known);
    if (complete(seats)) return seats;
    try {
      const rows = await this.rpc.programAccounts(this.programId, SEAT_ACCOUNT_SIZE, 8, toBase58(this.program.table(tableId)));
      return rows.map((r) => decodeSeat(r.data));
    } catch (e) {
      this.log('info', `[Escrow] ${tableId}: getProgramAccounts unavailable (${(e as Error).message.slice(0, 80)}); reading the table's history`);
    }
    const tablePda = toBase58(this.program.table(tableId));
    const tried = new Set([...known, this.authority]);
    let before: string | undefined;
    for (let page = 0; page < 20 && !complete(seats); page++) {
      const sigs = await this.rpc.signatures(tablePda, 100, before);
      if (sigs.length === 0) break;
      before = sigs[sigs.length - 1]!.signature;
      const payers: string[] = [];
      for (let i = 0; i < sigs.length; i += 10) {
        const batch = sigs.slice(i, i + 10).filter((s) => !s.err);
        for (const p of await Promise.all(batch.map((s) => this.rpc.feePayer(s.signature).catch(() => null)))) if (p && !tried.has(p)) payers.push(p);
      }
      for (const p of payers) tried.add(p);
      if (payers.length) seats = [...seats, ...(await this.seatsFor(tableId, payers))];
    }
    return seats;
  }

  async vaultLamports(tableId: string): Promise<number> {
    return (await this.rpc.account(toBase58(this.program.vault(tableId))))?.lamports ?? 0;
  }

  // ---- the settlement authority's instructions

  /** Opens a table with this key as its settlement authority (and rent payer). */
  createTable(tableId: string, buyInLamports: bigint, smallBlindChips: bigint, bigBlindChips: bigint, maxSeats: number): Promise<string> {
    return this.send([this.program.createTable(tableId, this.signer.publicKey, buyInLamports, smallBlindChips, bigBlindChips, maxSeats)], `create_table ${tableId}`);
  }

  /** Opens a round before the deal: buy-ins land as pending and seats can't be cashed out until it settles. */
  async beginRound(tableId: string): Promise<'begun' | 'already'> {
    try {
      await this.send([this.program.beginRound(tableId)], `begin_round ${tableId}`);
      return 'begun';
    } catch (e) {
      if (e instanceof EscrowTxError && e.code === EscrowError.RoundInProgress) return 'already';
      throw e;
    }
  }

  /**
   * Settles the open round with each player's chip change. Seats holding a mid-hand buy-in ride along, so their
   * pending chips move into play. Returns the nonce settled, or null when the round was already settled (a resend
   * after a lost response: the table's nonce moved on and no round is open).
   */
  async settleRound(tableId: string, deltas: { player: string; chipDelta: number }[], expectedNonce?: bigint, knownWallets: string[] = []): Promise<bigint | null> {
    const table = await this.table(tableId);
    if (!table) throw new EscrowTxError(`table ${tableId} is not on chain`, null);
    if (expectedNonce !== undefined && table.roundNonce !== expectedNonce) {
      if (table.roundNonce > expectedNonce && !table.roundActive) return null;
      throw new EscrowTxError(`table ${tableId} is at round ${table.roundNonce}, expected ${expectedNonce}`, EscrowError.StaleSettlement);
    }
    const moved = deltas.filter((d) => d.chipDelta !== 0);
    if (moved.length > MAX_DELTAS) throw new EscrowTxError(`${moved.length} chip changes; the program takes at most ${MAX_DELTAS}`, null);
    const sum = moved.reduce((s, d) => s + d.chipDelta, 0);
    if (sum !== 0) throw new EscrowTxError(`chip changes sum to ${sum}, not zero`, EscrowError.SettlementNotZeroSum);
    let pendingOnly: Address[] = [];
    if (table.pendingChipsInPlay > 0n) {
      const inDeltas = new Set(moved.map((d) => d.player));
      pendingOnly = (await this.seatsOf(tableId, [...knownWallets, ...moved.map((d) => d.player)])).filter((s) => s.pendingChips > 0n && !inDeltas.has(s.player)).map((s) => address(s.player));
      if (moved.length + pendingOnly.length > 30) this.log('warn', `[Escrow] ${tableId}: ${pendingOnly.length} pending seats ride the settlement`);
    }
    const chips: ChipDelta[] = moved.map((d) => ({ player: address(d.player), chipDelta: BigInt(d.chipDelta) }));
    await this.send([this.program.settleRound(tableId, table.roundNonce, chips, pendingOnly)], `settle_round ${tableId} #${table.roundNonce}`);
    return table.roundNonce;
  }

  /**
   * Pays a seat out to the player's wallet. The program closes the seat to the payer (this key), so the seat's rent,
   * which the player paid at buy-in, is sent back to them in the same transaction.
   */
  async cashOut(tableId: string, player: string): Promise<{ signature: string; chips: bigint } | null> {
    const seatAddress = toBase58(this.program.seat(tableId, address(player)));
    const acct = await this.rpc.account(seatAddress);
    if (!acct) return null; // already paid out (or never bought in)
    const seat = decodeSeat(acct.data);
    const wallet = address(player);
    const signature = await this.send([this.program.cashOut(tableId, wallet), systemTransfer(this.signer.publicKey, wallet, BigInt(acct.lamports))], `cash_out ${tableId} ${player}`);
    return { signature, chips: seat.chips + seat.pendingChips };
  }

  /** Returns the table and vault rent to this key; the program refuses while any seat is left. */
  closeTable(tableId: string): Promise<string> {
    return this.send([this.program.closeTable(tableId)], `close_table ${tableId}`);
  }

  // ---- sending

  /** Signs, sends and confirms; a blockhash that expires before confirmation is retried once with a fresh one. */
  async send(ixs: Instruction[], label: string): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const bh = await this.rpc.latestBlockhash();
      const wire = await signTransaction(compileMessage(this.signer.publicKey, bh.blockhash, ixs), [this.signer]);
      let signature: string;
      try {
        signature = await this.rpc.sendTransaction(wire);
      } catch (e) {
        const msg = (e as Error).message;
        throw new EscrowTxError(`${label}: ${msg}`, programErrorCode(msg));
      }
      try {
        await this.rpc.confirm(signature, bh.lastValidBlockHeight, this.sleep);
        this.log('info', `[Escrow] ${label} confirmed ${signature}`);
        return signature;
      } catch (e) {
        const msg = (e as Error).message;
        if (/blockhash expired/.test(msg) && attempt < 2) {
          this.log('warn', `[Escrow] ${label}: blockhash expired before ${signature} confirmed; resending`);
          continue;
        }
        throw new EscrowTxError(`${label}: ${msg}`, programErrorCode(msg));
      }
    }
  }
}
