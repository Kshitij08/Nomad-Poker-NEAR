import { sessionPlayer } from '@nomad/db/accounts';
import { balances, post } from '@nomad/db/ledger';
import { recordTableJoined } from '@nomad/db/progress';
import { buyIn, cashOut, checkpoint, seatLock, type SeatLockRow } from '@nomad/db/seatLocks';
import { LedgerResult, type ChipLedger } from '@nomad/table-server/ledger';
import type { TableEconomy } from '@nomad/table-server/chipTableSession';

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/**
 * Waits between tries, real time. D1 refuses work for seconds at a time ("D1 DB is overloaded … within a 10 second
 * window", an export, a restart): on the 9 Nov load test at 20× speed, 95 cash-outs and over 1,000 checkpoints failed
 * on their only try, leaving seat locks with stale stacks. A cash-out (and recovering a lock) tries for about 15 s; a
 * checkpoint for about 4 s, since the next hand's checkpoint supersedes it. Jitter keeps many tables from retrying
 * in step. Buy-ins are not retried: the player sees the refusal and can try again.
 */
const CASH_OUT_WAITS_MS = [250, 500, 1000, 2000, 4000, 8000];
const CHECKPOINT_WAITS_MS = [250, 500, 1000, 2000];
const realWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The ChipLedger contract over the Nomad ledger in D1. A player's hello ticket is their API session token; the
 * "PlayFab id" the table keys on is the Nomad player id. Buy-in and cash-out are single atomic D1 batches (seat lock
 * + ledger entry), so nothing here can half-happen.
 */
export class D1ChipLedger implements ChipLedger {
  constructor(
    private readonly db: D1Database,
    private readonly room: string,
    /** Whether a live table still holds this lock's seat (asked before paying a stranded stack back). */
    private readonly stillSeated: (lock: SeatLockRow) => Promise<boolean>,
    private readonly log: LogFn,
    private readonly wait: (ms: number) => Promise<void> = realWait,
  ) {}

  /** Runs `fn` until it succeeds or the waits run out (then throws the last error, logged as GAVE UP). */
  private async retrying<T>(label: string, waits: number[], fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fn();
        if (attempt > 0) this.log('warn', `[D1Ledger] ${label} written after ${attempt + 1} tries.`);
        return r;
      } catch (e) {
        if (attempt >= waits.length) {
          this.log('error', `[D1Ledger] ${label} GAVE UP after ${attempt + 1} tries: ${(e as Error).message}`);
          throw e;
        }
        await this.wait(Math.round(waits[attempt]! * (1 + Math.random() * 0.25)));
      }
    }
  }

  async authenticateAsync(sessionTicket: string): Promise<string | null> {
    try {
      return (await sessionPlayer(this.db, sessionTicket))?.player.id ?? null;
    } catch (e) {
      this.log('error', `[D1Ledger] session lookup failed: ${(e as Error).message}`);
      return null;
    }
  }

  async debitBuyInAsync(playerId: string, tableId: string, seat: number, chips: number): Promise<LedgerResult> {
    try {
      const r = await buyIn(this.db, { playerId, tableId, room: this.room, seat, chips });
      if (r.ok) {
        this.log('info', `[D1Ledger] ${playerId} bought in for ${chips} at ${tableId} seat ${seat} (balance ${r.balance}).`);
        // "Play 2 tables": this room counts once today. Best effort: a miss only delays a mission.
        await recordTableJoined(this.db, playerId, this.room).catch((e) => this.log('warn', `[D1Ledger] table mission not recorded: ${(e as Error).message}`));
        return LedgerResult.ok(r.balance);
      }
      switch (r.reason) {
        case 'insufficient':
          return LedgerResult.insufficientFunds(r.balance ?? 0);
        case 'seated_here':
          return LedgerResult.fail('Already seated at this table.');
        case 'seated_elsewhere':
          return LedgerResult.fail("You're already sitting at another table.");
        default:
          return LedgerResult.fail('Buy-in must be positive.');
      }
    } catch (e) {
      this.log('error', `[D1Ledger] buy-in failed: ${(e as Error).message}`);
      return LedgerResult.fail("Couldn't reach the chip service.");
    }
  }

  async checkpointAsync(playerId: string, tableId: string, seat: number, stack: number, handNumber: number): Promise<LedgerResult> {
    try {
      // A set, not a delta: writing it twice is harmless.
      const ok = await this.retrying(`checkpoint ${playerId} hand ${handNumber}`, CHECKPOINT_WAITS_MS, () => checkpoint(this.db, { playerId, tableId, seat, stack, handNumber }));
      return ok ? LedgerResult.ok() : LedgerResult.fail("Couldn't checkpoint the stack.");
    } catch (e) {
      this.log('error', `[D1Ledger] checkpoint failed: ${(e as Error).message}`);
      return LedgerResult.fail("Couldn't checkpoint the stack.");
    }
  }

  async creditCashOutAsync(playerId: string, tableId: string, chips: number): Promise<LedgerResult> {
    if (chips < 0) return LedgerResult.fail('Cash-out cannot be negative.');
    try {
      // A try that was written but whose answer was lost leaves no lock: the retry then finds nothing to pay, and that
      // means paid (the credit is keyed to the lock, so it can't be written twice either).
      let triedBefore = false;
      const r = await this.retrying(`cash-out ${chips} for ${playerId} at ${tableId}`, CASH_OUT_WAITS_MS, async () => {
        try {
          return await cashOut(this.db, { playerId, tableId, chips });
        } catch (e) {
          triedBefore = true;
          throw e;
        }
      });
      if (!r && triedBefore) {
        this.log('warn', `[D1Ledger] ${playerId}'s cash-out from ${tableId} was written by an earlier try.`);
        return LedgerResult.ok(await this.getBalanceAsync(playerId));
      }
      if (!r) {
        this.log('warn', `[D1Ledger] Cash-out refused for ${playerId} at ${tableId}: no matching seat lock.`);
        return LedgerResult.fail('No seat to cash out.');
      }
      this.log('info', `[D1Ledger] ${playerId} cashed out ${chips} from ${tableId} (balance ${r.balance}).`);
      return LedgerResult.ok(r.balance);
    } catch (e) {
      this.log('error', `[D1Ledger] cash-out failed: ${(e as Error).message}`);
      return LedgerResult.fail("Couldn't reach the chip service.");
    }
  }

  /**
   * A lock left by a table that is gone (redeploy, eviction, crash) pays its last checkpoint back. A lock a live table
   * still holds is left alone: the buy-in that follows is refused as "already sitting at another table".
   */
  async reconcileAsync(playerId: string): Promise<LedgerResult> {
    try {
      const lock = await this.retrying(`seat lock read for ${playerId}`, CHECKPOINT_WAITS_MS, () => seatLock(this.db, playerId));
      if (!lock) return LedgerResult.ok();
      if (await this.stillSeated(lock)) return LedgerResult.fail('Still seated at another table.');
      // Null after a lost answer is the same as someone else settling it: the lock is paid once either way.
      const r = await this.retrying(`recovery of ${playerId}'s seat at ${lock.table_id}`, CASH_OUT_WAITS_MS, () =>
        cashOut(this.db, { playerId, tableId: lock.table_id, chips: lock.stack, reason: 'table:recovered' }),
      );
      if (!r) return LedgerResult.ok(); // someone else just settled it
      this.log('info', `[D1Ledger] Recovered ${lock.stack} for ${playerId} from table ${lock.table_id} (${lock.room}, hand ${lock.hand_number}). Balance ${r.balance}.`);
      return LedgerResult.ok(r.balance);
    } catch (e) {
      this.log('error', `[D1Ledger] reconcile failed: ${(e as Error).message}`);
      return LedgerResult.fail("Couldn't reach the chip service.");
    }
  }

  async grantAsync(playerId: string, chips: number, reason: string, idempotencyKey: string): Promise<LedgerResult> {
    if (chips <= 0) return LedgerResult.fail('Grant must be positive.');
    try {
      await post(this.db, [{ playerId, currency: 'coins', delta: chips, reason, idempotencyKey: `table-grant:${idempotencyKey}` }]);
      return LedgerResult.ok((await balances(this.db, playerId)).coins);
    } catch (e) {
      this.log('error', `[D1Ledger] grant failed: ${(e as Error).message}`);
      return LedgerResult.fail("Couldn't add the chips.");
    }
  }

  async getBalanceAsync(playerId: string): Promise<number> {
    try {
      return (await balances(this.db, playerId)).coins;
    } catch {
      return -1;
    }
  }
}

/** The table's economy: tickets are Nomad API session tokens, checked by the ledger itself. */
export function d1TableEconomy(ledger: ChipLedger): TableEconomy {
  return {
    ledger,
    adoptTicket: (ticket) => (typeof ticket === 'string' && ticket.startsWith('np_') && ticket.length <= 100 ? ticket : null),
  };
}
