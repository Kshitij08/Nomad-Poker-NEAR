import { sessionPlayer } from '@nomad/db/accounts';
import { balances, post } from '@nomad/db/ledger';
import { buyIn, cashOut, checkpoint, seatLock, type SeatLockRow } from '@nomad/db/seatLocks';
import { LedgerResult, type ChipLedger } from '@nomad/table-server/ledger';
import type { TableEconomy } from '@nomad/table-server/chipTableSession';

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

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
  ) {}

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
      return (await checkpoint(this.db, { playerId, tableId, seat, stack, handNumber })) ? LedgerResult.ok() : LedgerResult.fail("Couldn't checkpoint the stack.");
    } catch (e) {
      this.log('error', `[D1Ledger] checkpoint failed: ${(e as Error).message}`);
      return LedgerResult.fail("Couldn't checkpoint the stack.");
    }
  }

  async creditCashOutAsync(playerId: string, tableId: string, chips: number): Promise<LedgerResult> {
    if (chips < 0) return LedgerResult.fail('Cash-out cannot be negative.');
    try {
      const r = await cashOut(this.db, { playerId, tableId, chips });
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
      const lock = await seatLock(this.db, playerId);
      if (!lock) return LedgerResult.ok();
      if (await this.stillSeated(lock)) return LedgerResult.fail('Still seated at another table.');
      const r = await cashOut(this.db, { playerId, tableId: lock.table_id, chips: lock.stack, reason: 'table:recovered' });
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
