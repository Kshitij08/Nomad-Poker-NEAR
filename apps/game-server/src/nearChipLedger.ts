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
 * Checkpoints stay in memory. If the server dies mid-session the escrow still holds the seat; the player can rejoin
 * (and sits with the locked amount) or, after the operator has been silent long enough, reclaim it on chain.
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
  ) {}

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
      const s = await this.operator.view<Seat | null>(this.escrow, 'get_seat', { table_id: this.table, player: account });
      if (!s) return LedgerResult.fail('Buy in from your NEAR wallet first.');
      const locked = Number(BigInt(s.locked) / CHIP_YOCTO);
      if (chips !== locked) return locked < chips ? LedgerResult.insufficientFunds(locked) : LedgerResult.fail(`Your seat holds ${locked} chips; join with exactly that.`);
      this.stacks.set(playerId, chips);
      this.log('info', `[NearLedger] ${account} sat at seat ${seat} with ${chips} chips (escrow ${this.table}).`);
      return LedgerResult.ok(locked);
    } catch (e) {
      this.log('error', `[NearLedger] buy-in check failed: ${(e as Error).message}`);
      return LedgerResult.fail("Couldn't reach NEAR.");
    }
  }

  async checkpointAsync(playerId: string, _tableId: string, _seat: number, stack: number): Promise<LedgerResult> {
    this.stacks.set(playerId, stack);
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
      this.log('info', `[NearLedger] cashed out ${chips} chips to ${account} (escrow ${this.table}${paid === false ? ', already paid' : ''}).`);
      return LedgerResult.ok();
    } catch (e) {
      const msg = (e as Error).message;
      this.log('error', `[NearLedger] cash-out of ${chips} for ${playerId} failed: ${msg}`);
      // Not seated any more: an earlier try already paid it.
      if (/not seated/i.test(msg)) return LedgerResult.ok();
      return LedgerResult.fail("Couldn't pay out on NEAR.");
    }
  }

  async reconcileAsync(): Promise<LedgerResult> {
    return LedgerResult.ok();
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
