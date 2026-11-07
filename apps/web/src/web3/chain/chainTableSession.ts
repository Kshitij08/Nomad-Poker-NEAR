/**
 * The single adapter between an authoritative (player-hosted) table loop and the Solana escrow. Port of
 * Net/Chain/ChainTableSession.cs with the coroutines as async methods. Player-hosted tables authorize with the host's
 * JWT (/host/*); the dedicated-server path (INTERNAL_API_KEY, /internal/*) stays server-side and isn't ported.
 * Retries re-read on-chain table state between attempts: begin_round and settle_round are both idempotently
 * recoverable (round already active / no longer active means a lost response actually landed).
 *
 * The web port has no player-hosted Fusion loop yet (the net module plays against dedicated servers), so this is the
 * piece a future host loop calls; it is unit-tested against a fake ChainService.
 */
import type { TableState, TxResult, SeatState } from './escrow';
import type { ChainService } from './service';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [2, 5, 10];

export interface HandDelta {
  player: string;
  chipDelta: number;
}

/** The parts of ChainService this adapter uses (a fake in tests). */
export type ChainPort = Pick<ChainService, 'getTable' | 'getTableWithRetry' | 'tryGetSeat' | 'host'>;

export class ChainTableSession {
  readonly tableId: string;
  isCreated = false;
  isHalted = false;
  private readonly pendingCashOuts = new Set<string>();
  private flushing = false;
  private readonly haltedListeners = new Set<() => void>();

  private constructor(
    private readonly chain: ChainPort,
    private readonly jwt: string,
    readonly buyInLamports: bigint,
    readonly smallBlindChips: bigint,
    readonly bigBlindChips: bigint,
    existingTableId: string | null,
    private readonly wait: (seconds: number) => Promise<void>,
  ) {
    if (existingTableId) {
      this.tableId = existingTableId;
      this.isCreated = true;
    } else {
      // Fresh per session: the seat PDA init on chain forbids ever reusing a table id.
      this.tableId = 'x2c-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    }
  }

  static forPlayerHost(chain: ChainPort, jwt: string, buyInLamports: bigint, sb: bigint, bb: bigint, wait = realWait): ChainTableSession {
    return new ChainTableSession(chain, jwt, buyInLamports, sb, bb, null, wait);
  }

  /** Takes over a table already on chain after player-host migration. */
  static adopt(chain: ChainPort, jwt: string, tableId: string, buyInLamports: bigint, sb: bigint, bb: bigint, wait = realWait): ChainTableSession {
    return new ChainTableSession(chain, jwt, buyInLamports, sb, bb, tableId, wait);
  }

  onHalted(fn: () => void): () => void {
    this.haltedListeners.add(fn);
    return () => this.haltedListeners.delete(fn);
  }

  async createTable(maxSeats: number): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await safe(() => this.chain.host.createTable(this.jwt, this.tableId, this.buyInLamports, this.smallBlindChips, this.bigBlindChips, maxSeats));
      if (r?.success) {
        this.isCreated = true;
        return true;
      }
      console.warn(`[ChainTable] create_table attempt ${attempt + 1} failed: ${r?.error ?? 'faulted'}`);
      if (attempt < MAX_ATTEMPTS - 1) await this.wait(RETRY_DELAYS[attempt]!);
    }
    return false;
  }

  /** begin_round before dealing. AlreadyActive counts as success. */
  async beginHand(): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await safe(() => this.chain.host.beginHand(this.jwt, this.tableId));
      if (r && (r.success || r.alreadyActive)) return true;
      console.warn(`[ChainTable] begin_round attempt ${attempt + 1} failed: ${r?.error ?? 'faulted'}`);
      const t = await safe(() => this.chain.getTable(this.tableId));
      if (t?.roundActive) return true; // already landed
      if (attempt < MAX_ATTEMPTS - 1) await this.wait(RETRY_DELAYS[attempt]!);
    }
    return false;
  }

  /** settle_round with the hand's chip deltas; a failed attempt re-reads the table (round inactive = landed). */
  async settleHand(deltas: HandDelta[], potChips: number, pendingSeatPdas: string[] = []): Promise<boolean> {
    let lastError: string | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await safe(() => this.chain.host.settleHand(this.jwt, this.tableId, deltas, potChips, pendingSeatPdas));
      if (r?.success) return true;
      lastError = r?.error ?? 'faulted';
      console.warn(`[ChainTable] settle_round attempt ${attempt + 1} failed: ${lastError}`);
      const t = await safe(() => this.chain.getTable(this.tableId));
      if (t && !t.roundActive) return true;
      if (attempt < MAX_ATTEMPTS - 1) await this.wait(RETRY_DELAYS[attempt]!);
    }
    this.halt(`settle_round failed after ${MAX_ATTEMPTS} attempts — last error: ${lastError ?? 'unknown'}`);
    return false;
  }

  halt(reason: string): void {
    if (this.isHalted) return;
    this.isHalted = true;
    console.error(`[ChainTable] Table ${this.tableId} HALTED: ${reason}. No more hands will be dealt; players recover via server-signed cash-out.`);
    for (const fn of this.haltedListeners) fn();
  }

  readTable(): Promise<TableState | null> {
    return safe(() => this.chain.getTableWithRetry(this.tableId));
  }

  /** The player's on-chain seat; null while they have not bought in. */
  verifySeat(pubkey: string): Promise<SeatState | null> {
    return safe(() => this.chain.tryGetSeat(this.tableId, pubkey));
  }

  resolvePubkey(jwt: string): Promise<string | null> {
    return safe(() => this.chain.host.introspect(jwt));
  }

  queueCashOut(pubkey: string): void {
    if (pubkey) this.pendingCashOuts.add(pubkey);
  }

  get hasPendingCashOuts(): boolean {
    return this.pendingCashOuts.size > 0;
  }

  /** Best-effort cash-out when the page is going away. */
  fireAndForgetCashOut(pubkey: string): void {
    if (pubkey) void safe(() => this.chain.host.cashOut(this.jwt, this.tableId, pubkey));
  }

  /** Flushed at hand boundaries; a failed cash-out stays queued unless the seat is already gone. */
  async flushCashOuts(): Promise<void> {
    if (this.flushing || this.pendingCashOuts.size === 0) return;
    this.flushing = true;
    try {
      for (const pubkey of [...this.pendingCashOuts]) {
        const r: TxResult | null = await safe(() => this.chain.host.cashOut(this.jwt, this.tableId, pubkey));
        if (r?.success) {
          this.pendingCashOuts.delete(pubkey);
          continue;
        }
        const seat = await safe(() => this.chain.tryGetSeat(this.tableId, pubkey), undefined);
        if (seat === null) this.pendingCashOuts.delete(pubkey);
        else console.warn(`[ChainTable] Cash-out for ${pubkey} failed, retrying next boundary: ${r?.error ?? 'faulted'}`);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Close the table once no chain seats remain (recovers PDA rent). Best-effort. */
  async closeIfEmpty(): Promise<void> {
    if (!this.isCreated || this.pendingCashOuts.size > 0) return;
    const t = await safe(() => this.chain.getTable(this.tableId));
    if (!t || t.seatedCount > 0 || t.roundActive) return;
    const r = await safe(() => this.chain.host.closeTable(this.jwt, this.tableId));
    if (!r?.success) console.warn(`[ChainTable] close_table failed (backend sweeper will finish it): ${r?.error ?? 'faulted'}`);
  }
}

const realWait = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));

/** Awaits, mapping a fault to `fallback` (Unity's Faulted(task) → null). */
async function safe<T, F = null>(f: () => Promise<T>, fallback: F = null as F): Promise<T | F> {
  try {
    return await f();
  } catch (e) {
    console.warn('[ChainTable] request faulted:', (e as Error).message ?? e);
    return fallback;
  }
}
