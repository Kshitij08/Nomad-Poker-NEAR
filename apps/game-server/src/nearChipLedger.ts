import { nearAccountOf, sessionPlayer } from '@nomad/db/accounts';
import { LedgerResult, type ChipLedger } from '@nomad/table-server/ledger';
import type { NearOperator } from './nearOperator';

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/** One chip is 0.001 NEAR. */
export const CHIP_YOCTO = 10n ** 21n;

type Seat = { bought_in: string; locked: string };

/**
 * The ChipLedger of a NEAR money table: the escrow contract holds the money, the table only seats and pays out.
 *
 * - A player buys in from their own wallet (`buy_in` on the escrow, 5% rake), then joins asking for exactly the chips
 *   their seat locked; anything else is refused, so nothing is stranded in the table.
 * - Cash-out is the operator's `cash_out(table, player, amount, key)`; the escrow refuses a player not seated there
 *   and any payout above what the table locked, so a retry can never pay twice.
 * - Players are NEAR accounts: a Nomad player id maps to the NEAR account they signed in with.
 *
 * Every seat's stack is kept in D1 (`near_seats`): written at buy-in and after each hand, deleted at cash-out. A table
 * whose previous instance died (redeploy, eviction, crash) pays those stacks back through the escrow when it next opens
 * (`recoverLeftovers`), and a player who comes back first is settled the same way before buying in again. The escrow
 * refuses a player who is no longer seated and any payout above what the table locked, so recovery can't pay twice.
 */
export class NearChipLedger implements ChipLedger {
  private readonly accounts = new Map<string, string>();
  private readonly stacks = new Map<string, number>();

  constructor(
    private readonly db: D1Database,
    private readonly operator: Pick<NearOperator, 'view' | 'call'>,
    private readonly escrow: string,
    /** The escrow's table id: the room name. */
    private readonly table: string,
    private readonly log: LogFn,
    /**
     * A hosted table's blinds as this room deals them: the escrow table (made by its host) must exist with the same
     * blinds before anyone sits. House tables, opened by the operator, skip the check.
     */
    private readonly hostedBlinds: { small: number; big: number } | null = null,
  ) {}

  private tableChecked = false;

  /** Writes a seat's stack (best effort: a failed write leaves the previous checkpoint, which recovery would pay). */
  private async saveStack(playerId: string, account: string, stack: number, hand: number): Promise<void> {
    try {
      await this.db
        .prepare(
          'INSERT INTO near_seats (room, account, player_id, stack, hand_number, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
            'ON CONFLICT (room, account) DO UPDATE SET player_id = ?3, stack = ?4, hand_number = ?5, updated_at = ?6',
        )
        .bind(this.table, account, playerId, stack, hand, Date.now())
        .run();
    } catch (e) {
      this.log('warn', `[NearLedger] stack of ${account} not saved: ${(e as Error).message}`);
    }
  }

  private async dropStack(account: string): Promise<void> {
    try {
      await this.db.prepare('DELETE FROM near_seats WHERE room = ?1 AND account = ?2').bind(this.table, account).run();
    } catch (e) {
      this.log('warn', `[NearLedger] seat row of ${account} not removed: ${(e as Error).message}`);
    }
  }

  /** Pays a seat left by a previous instance of this table back at its last checkpoint. True when settled. */
  private async recover(row: { account: string; stack: number; hand_number: number }): Promise<boolean> {
    const amount = (BigInt(row.stack) * CHIP_YOCTO).toString();
    try {
      const paid = await this.operator.call<boolean>(this.escrow, 'cash_out', { table_id: this.table, player: row.account, amount, key: `recover:${row.account}:${row.hand_number}` }, { tgas: 30n });
      this.log('info', `[NearLedger] recovered ${row.stack} chips for ${row.account} (hand ${row.hand_number}${paid === false ? ', already paid' : ''}).`);
    } catch (e) {
      const msg = (e as Error).message;
      // Not seated any more: it was settled already (cashed out, or reclaimed on chain).
      if (!/not seated/i.test(msg)) {
        this.log('error', `[NearLedger] recovery of ${row.account} failed: ${msg}`);
        return false;
      }
    }
    await this.dropStack(row.account);
    return true;
  }

  /**
   * At open: seats a previous instance of this table left behind (rows older than `openedAt`) are paid back at their
   * last checkpoint. Returns how many were settled.
   */
  async recoverLeftovers(openedAt: number): Promise<number> {
    const rows = await this.db
      .prepare('SELECT account, stack, hand_number FROM near_seats WHERE room = ?1 AND updated_at < ?2')
      .bind(this.table, openedAt)
      .all<{ account: string; stack: number; hand_number: number }>();
    let n = 0;
    for (const r of rows.results) if (await this.recover(r)) n++;
    return n;
  }

  /** Null when the table is fine to sit at, else why not. */
  private async tableProblem(): Promise<string | null> {
    if (!this.hostedBlinds || this.tableChecked) return null;
    const t = await this.operator.view<{ config: { small_blind: number; big_blind: number }; closed: boolean } | null>(this.escrow, 'get_table', { table_id: this.table });
    if (!t) return 'This table was not created on NEAR.';
    if (t.closed) return 'The host closed this table.';
    if (t.config.small_blind !== this.hostedBlinds.small || t.config.big_blind !== this.hostedBlinds.big)
      return `This table's blinds on NEAR (${t.config.small_blind}/${t.config.big_blind}) don't match its stake.`;
    this.tableChecked = true;
    return null;
  }

  private async accountOf(playerId: string): Promise<string | null> {
    const known = this.accounts.get(playerId);
    if (known) return known;
    const a = await nearAccountOf(this.db, playerId);
    if (a) this.accounts.set(playerId, a);
    return a;
  }

  async authenticateAsync(sessionTicket: string): Promise<string | null> {
    try {
      return (await sessionPlayer(this.db, sessionTicket))?.player.id ?? null;
    } catch (e) {
      this.log('error', `[NearLedger] session lookup failed: ${(e as Error).message}`);
      return null;
    }
  }

  async debitBuyInAsync(playerId: string, _tableId: string, seat: number, chips: number): Promise<LedgerResult> {
    try {
      const account = await this.accountOf(playerId);
      if (!account) return LedgerResult.fail('Sign in with NEAR to play NEAR tables.');
      const problem = await this.tableProblem();
      if (problem) return LedgerResult.fail(problem);
      const s = await this.operator.view<Seat | null>(this.escrow, 'get_seat', { table_id: this.table, player: account });
      if (!s) return LedgerResult.fail('Buy in from your NEAR wallet first.');
      const locked = Number(BigInt(s.locked) / CHIP_YOCTO);
      if (chips !== locked) return locked < chips ? LedgerResult.insufficientFunds(locked) : LedgerResult.fail(`Your seat holds ${locked} chips; join with exactly that.`);
      this.stacks.set(playerId, chips);
      await this.saveStack(playerId, account, chips, 0);
      this.log('info', `[NearLedger] ${account} sat at seat ${seat} with ${chips} chips (escrow ${this.table}).`);
      return LedgerResult.ok(locked);
    } catch (e) {
      this.log('error', `[NearLedger] buy-in check failed: ${(e as Error).message}`);
      return LedgerResult.fail("Couldn't reach NEAR.");
    }
  }

  async checkpointAsync(playerId: string, _tableId: string, _seat: number, stack: number, handNumber: number): Promise<LedgerResult> {
    this.stacks.set(playerId, stack);
    const account = this.accounts.get(playerId);
    if (account) await this.saveStack(playerId, account, stack, handNumber);
    return LedgerResult.ok();
  }

  async creditCashOutAsync(playerId: string, _tableId: string, chips: number): Promise<LedgerResult> {
    if (chips < 0) return LedgerResult.fail('Cash-out cannot be negative.');
    try {
      const account = await this.accountOf(playerId);
      if (!account) return LedgerResult.fail('No NEAR account for this player.');
      const amount = (BigInt(Math.floor(chips)) * CHIP_YOCTO).toString();
      const key = `${account}:${Date.now()}`;
      const paid = await this.operator.call<boolean>(this.escrow, 'cash_out', { table_id: this.table, player: account, amount, key }, { tgas: 30n });
      this.stacks.delete(playerId);
      await this.dropStack(account);
      this.log('info', `[NearLedger] cashed out ${chips} chips to ${account} (escrow ${this.table}${paid === false ? ', already paid' : ''}).`);
      return LedgerResult.ok();
    } catch (e) {
      const msg = (e as Error).message;
      this.log('error', `[NearLedger] cash-out of ${chips} for ${playerId} failed: ${msg}`);
      // Not seated any more: an earlier try already paid it.
      if (/not seated/i.test(msg)) {
        const account = this.accounts.get(playerId);
        if (account) await this.dropStack(account);
        return LedgerResult.ok();
      }
      return LedgerResult.fail("Couldn't pay out on NEAR.");
    }
  }

  /** Before a buy-in: a seat this player left at a dead instance of this table is paid back first. */
  async reconcileAsync(playerId: string): Promise<LedgerResult> {
    if (this.stacks.has(playerId)) return LedgerResult.ok(); // seated at this instance: nothing left behind
    try {
      const account = await this.accountOf(playerId);
      if (!account) return LedgerResult.ok();
      const row = await this.db
        .prepare('SELECT account, stack, hand_number FROM near_seats WHERE room = ?1 AND account = ?2')
        .bind(this.table, account)
        .first<{ account: string; stack: number; hand_number: number }>();
      if (row && !(await this.recover(row))) return LedgerResult.fail("Couldn't settle your previous seat on NEAR.");
      return LedgerResult.ok();
    } catch (e) {
      this.log('error', `[NearLedger] reconcile failed: ${(e as Error).message}`);
      return LedgerResult.fail("Couldn't reach NEAR.");
    }
  }

  async grantAsync(): Promise<LedgerResult> {
    return LedgerResult.fail('NEAR tables take no grants.');
  }

  /** The player's idle escrow balance in chips, or -1. */
  async getBalanceAsync(playerId: string): Promise<number> {
    try {
      const account = await this.accountOf(playerId);
      if (!account) return -1;
      const b = await this.operator.view<string>(this.escrow, 'get_balance', { account });
      return Number(BigInt(b) / CHIP_YOCTO);
    } catch {
      return -1;
    }
  }
}
