// A NEAR table that dies mid-session: its stacks are in D1 (near_seats), and the next instance of the table, or the
// player coming back first, pays them back through the escrow at the last checkpoint. Exactly once.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPlayer } from '@nomad/db/accounts';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { CHIP_YOCTO, NearChipLedger } from '../nearChipLedger';

const ROOM = 'poker-money-st50';
const quiet = () => {};

/** The escrow rules recovery relies on: a seat pays once; an unseated player is refused. */
class Escrow {
  seats = new Map<string, bigint>();
  paid = new Map<string, bigint>();
  keys = new Set<string>();
  async view<T>(_c: string, method: string, a: Record<string, unknown>): Promise<T> {
    if (method === 'get_seat') {
      const l = this.seats.get(String(a.player));
      return (l === undefined ? null : { bought_in: String(l), locked: String(l) }) as T;
    }
    throw new Error(method);
  }
  async call<T>(_c: string, method: string, a: Record<string, unknown>): Promise<T> {
    if (method !== 'cash_out') throw new Error(method);
    if (this.keys.has(String(a.key))) return false as T;
    if (!this.seats.has(String(a.player))) throw new Error('Smart contract panicked: the player is not seated at this table');
    this.seats.delete(String(a.player));
    this.keys.add(String(a.key));
    this.paid.set(String(a.player), BigInt(String(a.amount)));
    return true as T;
  }
}

let db: D1Database;
let escrow: Escrow;
const ledger = () => new NearChipLedger(db, escrow, 'escrow.test', ROOM, quiet);

async function seated(name: string, account: string, chips: number): Promise<{ id: string; l: NearChipLedger }> {
  const p = await createPlayer(db, { displayName: name, identity: { provider: 'near', subject: account, label: account } });
  escrow.seats.set(account, BigInt(chips) * CHIP_YOCTO);
  const l = ledger();
  expect((await l.debitBuyInAsync(p.id, ROOM, 0, chips)).success).toBe(true);
  return { id: p.id, l };
}

const rows = async () => (await db.prepare('SELECT account, stack, hand_number FROM near_seats WHERE room = ?1').bind(ROOM).all()).results;

describe('NEAR table crash recovery', () => {
  beforeEach(async () => {
    db = await D1Shim.migrated();
    escrow = new Escrow();
  });

  it('keeps each stack in D1 and drops it at cash-out', async () => {
    const { id, l } = await seated('Ann', 'ann.testnet', 57);
    await l.checkpointAsync(id, ROOM, 0, 63, 4);
    expect(await rows()).toEqual([{ account: 'ann.testnet', stack: 63, hand_number: 4 }]);
    expect((await l.creditCashOutAsync(id, ROOM, 63)).success).toBe(true);
    expect(await rows()).toEqual([]);
    expect(escrow.paid.get('ann.testnet')).toBe(63n * CHIP_YOCTO);
  });

  it('pays a dead instance\'s seats back at their last checkpoint when the table opens again', async () => {
    const a = await seated('Ann', 'ann.testnet', 57);
    const b = await seated('Ben', 'ben.testnet', 57);
    await a.l.checkpointAsync(a.id, ROOM, 0, 80, 6);
    await b.l.checkpointAsync(b.id, ROOM, 1, 34, 6);
    // The instance dies here: no cash-out. The next one recovers both.
    const fresh = ledger();
    expect(await fresh.recoverLeftovers(Date.now() + 1)).toBe(2);
    expect(escrow.paid.get('ann.testnet')).toBe(80n * CHIP_YOCTO);
    expect(escrow.paid.get('ben.testnet')).toBe(34n * CHIP_YOCTO);
    expect(await rows()).toEqual([]);
    // A second sweep finds nothing; the escrow would refuse a repeat anyway.
    expect(await ledger().recoverLeftovers(Date.now() + 1)).toBe(0);
  });

  it('settles a returning player before they buy in again, and leaves seats of the live instance alone', async () => {
    const a = await seated('Ann', 'ann.testnet', 57);
    await a.l.checkpointAsync(a.id, ROOM, 0, 71, 2);
    const fresh = ledger();
    expect((await fresh.reconcileAsync(a.id)).success).toBe(true);
    expect(escrow.paid.get('ann.testnet')).toBe(71n * CHIP_YOCTO);
    expect(await rows()).toEqual([]);
    // Seated at the live instance: reconcile changes nothing.
    const b = await seated('Ben', 'ben.testnet', 57);
    expect((await b.l.reconcileAsync(b.id)).success).toBe(true);
    expect(escrow.paid.has('ben.testnet')).toBe(false);
    // Rows written after this instance opened are its own: not swept.
    expect(await ledger().recoverLeftovers(0)).toBe(0);
  });

  it('treats a seat already settled on chain (reclaimed) as done', async () => {
    const a = await seated('Ann', 'ann.testnet', 57);
    await a.l.checkpointAsync(a.id, ROOM, 0, 50, 1);
    escrow.seats.delete('ann.testnet'); // reclaimed by the player on chain
    expect(await ledger().recoverLeftovers(Date.now() + 1)).toBe(1);
    expect(await rows()).toEqual([]);
  });
});
