/**
 * Net/Economy/ChipTableSession.cs: one table's stake, its ledger, and the cash-out queue the hand boundary drains,
 * plus TableEconomy, what a table server needs from its host's economy (the local server's LocalEconomy, or the
 * game server's D1 economy).
 */
import { LedgerResult, type ChipLedger } from './ledger';
import type { ServerClock } from './clock';

/** PlayFabConfig.StakeTier (id, display name, buy-in, blinds). */
export interface ChipStakeTier {
  id: string;
  displayName: string;
  buyInChips: number;
  smallBlind: number;
  bigBlind: number;
}

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/** What a cash table needs from the process hosting it. */
export interface TableEconomy {
  readonly ledger: ChipLedger;
  /** Turns the ticket a client sent in hello into a session ticket `ledger.authenticateAsync` accepts; null when malformed. */
  adoptTicket(ticket: string): string | null;
  /** The client was just told `balance` (walletBalance push). Optional bookkeeping for hosts that need it. */
  noteSynced?(playerId: string, balance: number): void;
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
