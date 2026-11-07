/**
 * The table's chip economy: a port of Net/Economy/ChipTableSession.cs over the economy module's offline ledger
 * (src/economy/server/chipLedger.ts — PlayFabChipLedger's rules over an emulated title), plus the local stand-in for
 * PlayFab session tickets.
 *
 * Unity verifies a PlayFab session ticket at hello and debits the buy-in from the PlayFab balance. Locally there is
 * no PlayFab: the browser keeps its own wallet. So a client presents a *local ticket* — `local:<playerId>:<coins>` —
 * and this server keeps a title of its own in memory: the first hello creates the account, and whenever the player
 * holds no seat anywhere the server adopts the coins the client says it has (it is the browser's wallet that persists
 * between sessions). Every chip that then moves at a table goes through the real ledger protocol (seat lock, buy-in
 * debit, checkpoints, cash-out credit, reconcile) and the new balance is pushed back to the client, exactly as the
 * dedicated server pushes the PlayFab balance. Local only — never expose this server.
 */
import { LedgerResult, TitleChipLedger, type ChipLedger } from '../../src/economy/server/chipLedger';
import { createPlayer, memoryTitle, type TitleStateHandle } from '../../src/economy/server/titleState';
import type { ServerClock } from './clock';

export { LedgerResult, type ChipLedger };

/** PlayFabConfig.StakeTier (id, display name, buy-in, blinds). */
export interface ChipStakeTier {
  id: string;
  displayName: string;
  buyInChips: number;
  smallBlind: number;
  bigBlind: number;
}

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/** The server-side title and the local ticket authority every table on this server shares. */
export class LocalEconomy {
  readonly title: TitleStateHandle = memoryTitle();
  readonly ledger: ChipLedger;
  /** The balance each player's browser was last told (walletBalance push / hello). */
  private readonly lastSynced = new Map<string, number>();

  /** Record that the client was just told `balance` (the server's sendWalletBalance). */
  noteSynced(playFabId: string, balance: number): void {
    if (playFabId && balance >= 0) this.lastSynced.set(playFabId, balance);
  }

  constructor(log: LogFn) {
    this.ledger = new TitleChipLedger(this.title, { log });
  }

  /**
   * Turns a client's local ticket into a session ticket the ledger can authenticate. Null when malformed.
   * `local:<playerId>:<coins>` — playerId is the client's PlayFab id / guest id; coins its wallet balance.
   */
  adoptTicket(ticket: string): string | null {
    const m = /^local:([A-Za-z0-9_\-.]{1,64}):(-?\d{1,15})$/.exec(ticket ?? '');
    if (!m) return null;
    const id = m[1]!;
    const coins = Math.max(0, Number(m[2]));
    const state = this.title.state;
    let p = state.players[id];
    if (!p) {
      p = createPlayer(state, { id, chips: coins, objects: { ChipGrants: { keys: [], welcomed: true } } });
      this.lastSynced.set(id, coins);
    } else if (!p.objects['SeatLock']) {
      // Not seated anywhere: apply what the browser's wallet did since we last told it its balance (offline grants,
      // spends) — but keep anything this server credited that the browser never heard about (a cash-out after the
      // tab closed). The browser adopts the result at its next buy-in push.
      const last = this.lastSynced.get(id) ?? coins;
      p.chips = Math.max(0, (p.chips ?? 0) + (coins - last));
      this.lastSynced.set(id, p.chips);
    }
    const session = `S-${id}`;
    state.sessions[session] = { playFabId: id, expires: Date.now() + 24 * 3600 * 1000 };
    this.title.save();
    return session;
  }
}

/**
 * ChipTableSession: one table's stake, its ledger, and the cash-out queue the hand boundary drains. Coroutines become
 * promises; the retry waits run on the server clock.
 */
export class ChipTableSession {
  private static readonly MaxAttempts = 3;
  private static readonly RetryDelays = [2, 5];

  readonly tableId: string;
  private readonly pendingCashOuts = new Map<string, number>();
  private flushing = false;
  private halted = false;
  private readonly haltedHandlers: (() => void)[] = [];
  /** Every successful cash-out credit (now or from the queue), with the new balance. */
  onPaid: ((playFabId: string, balance: number) => void) | null = null;

  constructor(
    private readonly ledger: ChipLedger,
    readonly stakes: ChipStakeTier,
    private readonly clock: ServerClock,
    private readonly log: LogFn,
    tableId?: string,
  ) {
    // Fresh per session: a seat lock is matched on this, so reusing an id would let one table's stale lock look live.
    this.tableId = tableId || 't-' + crypto.randomUUID().replace(/-/g, '').substring(0, 20);
  }

  get isHalted(): boolean {
    return this.halted;
  }

  onHalted(fn: () => void): void {
    this.haltedHandlers.push(fn);
  }

  // ---- Identity

  async authenticate(sessionTicket: string): Promise<string | null> {
    return this.safe(() => this.ledger.authenticateAsync(sessionTicket), null);
  }

  // ---- Seating

  async reconcile(playFabId: string): Promise<boolean> {
    const r = await this.safe(() => this.ledger.reconcileAsync(playFabId), LedgerResult.fail('faulted'));
    return r.success;
  }

  async buyIn(playFabId: string, seat: number, chips: number): Promise<LedgerResult> {
    const amount = chips > 0 ? chips : this.stakes.buyInChips;
    return this.safe(() => this.ledger.debitBuyInAsync(playFabId, this.tableId, seat, amount), LedgerResult.fail("Couldn't reach the chip service."));
  }

  // ---- During play

  async checkpoint(playFabId: string, seat: number, stack: number, handNumber: number): Promise<void> {
    const r = await this.safe(() => this.ledger.checkpointAsync(playFabId, this.tableId, seat, stack, handNumber), LedgerResult.fail('faulted'));
    if (!r.success) this.log('warn', `[ChipTable] Checkpoint failed for ${playFabId} at hand ${handNumber}. Recovery for this player would be a hand behind.`);
  }

  async grant(playFabId: string, chips: number, reason: string, idempotencyKey: string): Promise<LedgerResult> {
    return this.safe(() => this.ledger.grantAsync(playFabId, chips, reason, idempotencyKey), LedgerResult.fail("Couldn't reach the chip service."));
  }

  // ---- Cash-out queue

  queueCashOut(playFabId: string, chips: number): void {
    if (!playFabId) return;
    this.pendingCashOuts.set(playFabId, chips);
  }

  get hasPendingCashOuts(): boolean {
    return this.pendingCashOuts.size > 0;
  }

  fireAndForgetCashOut(playFabId: string, chips: number): void {
    if (!playFabId) return;
    this.pendingCashOuts.delete(playFabId);
    void this.safe(() => this.ledger.creditCashOutAsync(playFabId, this.tableId, chips), LedgerResult.fail('faulted'));
  }

  async cashOutNow(playFabId: string, chips: number): Promise<LedgerResult> {
    if (!playFabId) return LedgerResult.fail('No playFabId.');
    this.pendingCashOuts.delete(playFabId);
    const r = await this.safe(() => this.ledger.creditCashOutAsync(playFabId, this.tableId, chips), LedgerResult.fail("Couldn't reach the chip service."));
    if (r.success) this.onPaid?.(playFabId, r.balance);
    return r;
  }

  fireAndForgetPendingCashOuts(): void {
    if (this.pendingCashOuts.size === 0) return;
    const batch = [...this.pendingCashOuts];
    this.pendingCashOuts.clear();
    for (const [id, chips] of batch) {
      this.log('info', `[ChipTable] Fire-and-forget cash-out ${chips} → ${id} (teardown).`);
      void this.safe(() => this.ledger.creditCashOutAsync(id, this.tableId, chips), LedgerResult.fail('faulted'));
    }
  }

  /** Pays every queued cash-out, retrying each a few times; failures stay queued for the next boundary. */
  async flushCashOuts(): Promise<void> {
    if (this.flushing || this.pendingCashOuts.size === 0) return;
    this.flushing = true;
    const batch = [...this.pendingCashOuts];
    this.pendingCashOuts.clear();
    for (const [id, chips] of batch) {
      let paid = false;
      for (let attempt = 0; attempt < ChipTableSession.MaxAttempts && !paid; attempt++) {
        const r = await this.safe(() => this.ledger.creditCashOutAsync(id, this.tableId, chips), LedgerResult.fail('faulted'));
        if (r.success) {
          paid = true;
          this.onPaid?.(id, r.balance);
          break;
        }
        if (attempt < ChipTableSession.RetryDelays.length) await this.clock.wait(ChipTableSession.RetryDelays[attempt]!);
      }
      if (paid) this.log('info', `[ChipTable] Paid out ${chips} to ${id}.`);
      else {
        this.pendingCashOuts.set(id, chips);
        this.log('warn', `[ChipTable] Cash-out for ${id} (${chips} chips) failed; still queued. Their seat lock covers it if this table ends.`);
      }
    }
    this.flushing = false;
  }

  // ---- Halting

  halt(reason: string): void {
    if (this.halted) return;
    this.halted = true;
    this.log('error', `[ChipTable] Table ${this.tableId} HALTED: ${reason}. No more hands will be dealt. Seated players keep their stacks — their seat locks are recovered on next sit-down.`);
    for (const fn of this.haltedHandlers) fn();
  }

  /** The ledger contract says it never throws; reaching the catch is a bug in it, worth an error. */
  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.log('error', `[ChipTable] Ledger call faulted (it should not): ${(e as Error)?.message ?? e}`);
      return fallback;
    }
  }
}
