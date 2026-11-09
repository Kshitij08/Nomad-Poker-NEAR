import { sessionPlayer } from '@nomad/db/accounts';
import { countEscrowHand, recordEscrowTable, setEscrowTableState, walletOf } from '@nomad/db/escrowTables';
import { LAMPORTS_PER_CHIP } from '@nomad/chain/accounts';
import type { EscrowClient } from '@nomad/chain/escrowClient';
import type { TableEconomy } from '@nomad/table-server/chipTableSession';
import { LedgerResult, type ChipLedger } from '@nomad/table-server/ledger';
import type { HandGate, SettledHand } from '@nomad/table-server/pokerServerGame';
import type { LogFn } from './roomHost';

export interface EscrowTableOptions {
  db: D1Database;
  client: EscrowClient;
  room: string;
  tableId: string;
  /** The table's buy-in in chips (the stake's minimum buy-in): 1 chip = 100,000 lamports on chain. */
  buyInChips: number;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  log: LogFn;
  /** Waits between attempts (tests pass a no-op). */
  wait?: (ms: number) => Promise<void>;
}

const ATTEMPTS = 3;
const RETRY_MS = [2000, 5000];

/**
 * One SOL table on the poker-escrow program, hosted by the game server (docs/phase-6-design.md). It is the table's chip
 * ledger and its hand gate at once:
 *
 * - **Seats are funded on chain.** A player signs `buy_in` with their own wallet; the server only reads the seat and
 *   sits them with its chips. Nothing is debited here.
 * - **Every hand is a round.** `begin_round` before the deal (buy-ins during the hand land as pending, and no seat can
 *   be cashed out until it settles), `settle_round` after it with each player's chip change.
 * - **Cash-outs** are signed by the server at a hand boundary and pay the seat's chips straight to the player's wallet.
 *
 * The escrow is the ledger: nothing about these chips is written to D1 beyond the table's own record.
 * All chain calls run one at a time.
 */
export class EscrowTable implements ChipLedger, HandGate {
  /** The table exists on chain (resolves false when it could not be created). */
  readonly ready: Promise<boolean>;
  private readonly wallets = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();
  /** A round is open on chain: cash-outs wait for it to settle. */
  private handOpen = false;
  private handClosed: (() => void)[] = [];
  private roundNonce: bigint | null = null;
  private closing = false;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly o: EscrowTableOptions) {
    this.wait = o.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ready = this.serial(() => this.create());
  }

  get tableId(): string {
    return this.o.tableId;
  }

  get buyInLamports(): bigint {
    return BigInt(this.o.buyInChips) * LAMPORTS_PER_CHIP;
  }

  economy(): TableEconomy {
    return {
      ledger: this,
      adoptTicket: (ticket) => (typeof ticket === 'string' && ticket.startsWith('np_') && ticket.length <= 100 ? ticket : null),
    };
  }

  private async create(): Promise<boolean> {
    const { db, client, room, tableId, log } = this.o;
    try {
      await recordEscrowTable(db, { tableId, room, authority: client.authority, buyInLamports: Number(this.buyInLamports) });
      await client.createTable(tableId, this.buyInLamports, BigInt(this.o.smallBlind), BigInt(this.o.bigBlind), this.o.maxSeats);
      await setEscrowTableState(db, tableId, 'open');
      log('info', `[Escrow] table ${tableId} open on chain: buy-in ${this.o.buyInChips} chips (${Number(this.buyInLamports) / 1e9} SOL), blinds ${this.o.smallBlind}/${this.o.bigBlind}`);
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      log('error', `[Escrow] could not open table ${tableId} on chain: ${msg}`);
      await setEscrowTableState(db, tableId, 'failed', msg.slice(0, 500)).catch(() => {});
      return false;
    }
  }

  // ---- ChipLedger -------------------------------------------------------------------------------

  async authenticateAsync(sessionTicket: string): Promise<string | null> {
    try {
      const id = (await sessionPlayer(this.o.db, sessionTicket))?.player.id ?? null;
      if (id && !this.wallets.has(id)) {
        const wallet = await walletOf(this.o.db, id);
        if (wallet) this.wallets.set(id, wallet);
      }
      return id;
    } catch (e) {
      this.o.log('error', `[Escrow] session lookup failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Sits the player with the chips their on-chain seat holds (active plus any pending buy-in). */
  async debitBuyInAsync(playerId: string, tableId: string): Promise<LedgerResult> {
    const wallet = this.wallets.get(playerId);
    if (!wallet) return LedgerResult.fail('Sign in with a Solana wallet to sit at a SOL table.');
    if (tableId !== this.o.tableId || !(await this.ready)) return LedgerResult.fail('This SOL table is not open.');
    try {
      const seat = await this.o.client.seat(tableId, wallet);
      if (!seat) return LedgerResult.fail('Buy in with your wallet first.');
      const chips = seat.chips + seat.pendingChips;
      if (chips <= 0n) return LedgerResult.fail('Your seat has no chips left. Buy in again.');
      this.o.log('info', `[Escrow] ${playerId} (${wallet}) sits with ${chips} chips from the chain`);
      return { success: true, error: null, balance: -1, stack: Number(chips) };
    } catch (e) {
      this.o.log('error', `[Escrow] seat read failed for ${wallet}: ${(e as Error).message}`);
      return LedgerResult.fail("Couldn't read your seat from the chain.");
    }
  }

  async checkpointAsync(): Promise<LedgerResult> {
    return LedgerResult.ok(); // the chain records every hand
  }

  /** Pays the player's seat out to their wallet once no round is open. The chain decides the amount. */
  async creditCashOutAsync(playerId: string, tableId: string, chips: number): Promise<LedgerResult> {
    const wallet = this.wallets.get(playerId);
    if (!wallet || tableId !== this.o.tableId) return LedgerResult.fail('No seat to cash out.');
    await this.roundClosed();
    try {
      const paid = await this.serial(() => this.payOut(wallet));
      if (paid && paid.chips !== BigInt(chips)) this.o.log('warn', `[Escrow] ${playerId} left with ${chips} chips at the table but the seat held ${paid.chips}; the chain paid ${paid.chips}`);
      return LedgerResult.ok(-1);
    } catch (e) {
      this.o.log('error', `[Escrow] cash-out for ${playerId} (${wallet}) failed: ${(e as Error).message}`);
      return LedgerResult.fail("Couldn't pay your seat out on chain. It stays yours: you can withdraw it from the table later.");
    }
  }

  async reconcileAsync(): Promise<LedgerResult> {
    return LedgerResult.ok(); // each table's seats are separate on chain: nothing to recover across tables
  }

  async grantAsync(): Promise<LedgerResult> {
    return LedgerResult.fail('SOL tables take no grants.');
  }

  async getBalanceAsync(): Promise<number> {
    return -1;
  }

  // ---- HandGate ---------------------------------------------------------------------------------

  beforeDeal(): Promise<boolean> {
    return this.serial(async () => {
      if (this.closing || !(await this.ready)) return false;
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        try {
          await this.o.client.beginRound(this.o.tableId);
          const t = await this.o.client.table(this.o.tableId);
          if (!t?.roundActive) throw new Error('round not open after begin_round');
          this.roundNonce = t.roundNonce;
          this.handOpen = true;
          return true;
        } catch (e) {
          this.o.log('warn', `[Escrow] begin_round attempt ${attempt + 1} failed: ${(e as Error).message}`);
          if (attempt < ATTEMPTS - 1) await this.wait(RETRY_MS[attempt]!);
        }
      }
      return false;
    });
  }

  afterSettle(hand: SettledHand): Promise<boolean> {
    return this.serial(async () => {
      try {
        const deltas: { player: string; chipDelta: number }[] = [];
        for (const s of hand.stacks) {
          const d = s.stack - s.startStack;
          const wallet = this.wallets.get(s.id);
          if (!wallet) {
            if (d !== 0) {
              this.o.log('error', `[Escrow] ${s.id} has no wallet but moved ${d} chips; refusing to settle hand ${hand.handNumber}`);
              return false;
            }
            continue;
          }
          deltas.push({ player: wallet, chipDelta: d });
        }
        const settled = await this.settle(deltas);
        if (!settled) return false;
        await countEscrowHand(this.o.db, this.o.tableId).catch(() => {});
        return await this.verify(hand);
      } finally {
        this.closeRound();
      }
    });
  }

  /** settle_round with retries; a re-read that finds the round settled counts as done. */
  private async settle(deltas: { player: string; chipDelta: number }[]): Promise<boolean> {
    const expected = this.roundNonce ?? undefined;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        await this.o.client.settleRound(this.o.tableId, deltas, expected);
        return true;
      } catch (e) {
        this.o.log('warn', `[Escrow] settle_round attempt ${attempt + 1} failed: ${(e as Error).message}`);
        const t = await this.o.client.table(this.o.tableId).catch(() => null);
        if (t && expected !== undefined && t.roundNonce > expected && !t.roundActive) return true; // it landed
        if (attempt < ATTEMPTS - 1) await this.wait(RETRY_MS[attempt]!);
      }
    }
    this.o.log('error', `[Escrow] table ${this.o.tableId}: settle_round failed ${ATTEMPTS} times; halting. Seats stay on chain and can be paid out.`);
    return false;
  }

  /** After a settle: every player dealt in must hold, on chain, at least the stack the table shows. */
  private async verify(hand: SettledHand): Promise<boolean> {
    try {
      const seats = new Map((await this.o.client.seatsOf(this.o.tableId)).map((s) => [s.player, s]));
      for (const s of hand.stacks) {
        const wallet = this.wallets.get(s.id);
        if (!wallet || s.seat < 0) continue;
        const onChain = seats.get(wallet);
        const chips = onChain ? Number(onChain.chips + onChain.pendingChips) : 0;
        if (chips < s.stack) {
          this.o.log('error', `[Escrow] hand ${hand.handNumber}: ${s.id} has ${s.stack} at the table but ${chips} on chain; halting`);
          return false;
        }
        if (chips > s.stack) this.o.log('warn', `[Escrow] hand ${hand.handNumber}: ${s.id} has ${chips} on chain, ${s.stack} at the table (a top-up the table hasn't seated)`);
      }
      return true;
    } catch (e) {
      this.o.log('warn', `[Escrow] could not verify hand ${hand.handNumber}: ${(e as Error).message}`);
      return true; // the settle itself landed; a failed read is not a reason to stop
    }
  }

  // ---- Closing ----------------------------------------------------------------------------------

  /**
   * After the room closed (and its cash-outs were queued): ends any round left open by a hand that never finished (a
   * settle with no changes puts every seat back where the last hand left it), pays out every seat still on the table,
   * including players who bought in but never sat, then closes the table and takes its rent back.
   */
  async shutdown(): Promise<void> {
    this.closing = true;
    this.closeRound();
    await this.serial(async () => {
      const { client, tableId, db, log } = this.o;
      if (!(await this.ready)) return;
      try {
        await setEscrowTableState(db, tableId, 'closing');
        await this.abortRoundIfOpen();
        for (const seat of await client.seatsOf(tableId)) await this.payOut(seat.player);
        await client.closeTable(tableId);
        await setEscrowTableState(db, tableId, 'closed');
        log('info', `[Escrow] table ${tableId} closed on chain`);
      } catch (e) {
        const msg = (e as Error).message;
        log('error', `[Escrow] closing table ${tableId} failed (the sweep will retry): ${msg}`);
        await setEscrowTableState(db, tableId, 'closing', msg.slice(0, 500)).catch(() => {});
      }
    });
  }

  private async payOut(wallet: string): Promise<{ chips: bigint } | null> {
    await this.abortRoundIfOpen();
    const r = await this.o.client.cashOut(this.o.tableId, wallet);
    if (r) this.o.log('info', `[Escrow] paid ${r.chips} chips (${Number(r.chips * LAMPORTS_PER_CHIP) / 1e9} SOL) to ${wallet}: ${r.signature}`);
    return r;
  }

  /** A round still open with no hand running (the room closed mid-hand): settle it with no changes. */
  private async abortRoundIfOpen(): Promise<void> {
    if (this.handOpen && !this.closing) return;
    const t = await this.o.client.table(this.o.tableId);
    if (!t?.roundActive) return;
    this.o.log('warn', `[Escrow] table ${this.o.tableId}: round ${t.roundNonce} left open; settling it with no changes`);
    await this.o.client.settleRound(this.o.tableId, [], t.roundNonce);
  }

  private roundClosed(): Promise<void> {
    if (!this.handOpen || this.closing) return Promise.resolve();
    return new Promise((r) => this.handClosed.push(r));
  }

  private closeRound(): void {
    this.handOpen = false;
    this.roundNonce = null;
    const waiters = this.handClosed;
    this.handClosed = [];
    for (const w of waiters) w();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }
}
