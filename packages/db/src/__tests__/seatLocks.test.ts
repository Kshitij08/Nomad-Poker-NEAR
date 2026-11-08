import { beforeEach, describe, expect, it } from 'vitest';
import { createPlayer } from '../accounts';
import { balances, entries } from '../ledger';
import { auditTable, buyIn, cashOut, checkpoint, openTableSession, recordHand, seatLock } from '../seatLocks';
import { D1Shim } from '../testing/d1Shim';

let db: D1Database;
let alice: string;
let bob: string;

beforeEach(async () => {
  db = await D1Shim.migrated();
  alice = (await createPlayer(db, { displayName: 'Alice' })).id; // 10,000 starter coins each
  bob = (await createPlayer(db, { displayName: 'Bob' })).id;
  await openTableSession(db, { id: 't1', room: 'poker-free', stake: 1000 });
});

describe('seat locks', () => {
  it('buy-in debits and locks in one step; cash-out credits and unlocks', async () => {
    const r = await buyIn(db, { playerId: alice, tableId: 't1', room: 'poker-free', seat: 2, chips: 1000 });
    expect(r).toMatchObject({ ok: true, balance: 9000 });
    expect(await seatLock(db, alice)).toMatchObject({ table_id: 't1', seat: 2, stack: 1000, buy_in: 1000 });

    expect(await checkpoint(db, { playerId: alice, tableId: 't1', seat: 2, stack: 1450, handNumber: 3 })).toBe(true);
    expect((await seatLock(db, alice))?.stack).toBe(1450);

    expect(await cashOut(db, { playerId: alice, tableId: 't1', chips: 1450 })).toEqual({ balance: 10_450, paid: 1450 });
    expect(await seatLock(db, alice)).toBeNull();
    const e = await entries(db, alice, { limit: 10 });
    expect(e.entries.map((x) => [x.reason, x.delta, x.ref])).toEqual([
      ['table:cash_out', 1450, 't1'],
      ['table:buy_in', -1000, 't1'],
      ['starter', 10_000, null],
    ]);
  });

  it('refuses a second seat anywhere, and says where', async () => {
    await buyIn(db, { playerId: alice, tableId: 't1', room: 'poker-free', seat: 0, chips: 1000 });
    expect(await buyIn(db, { playerId: alice, tableId: 't1', room: 'poker-free', seat: 1, chips: 1000 })).toEqual({ ok: false, reason: 'seated_here' });
    expect(await buyIn(db, { playerId: alice, tableId: 't2', room: 'ABCD', seat: 0, chips: 1000 })).toEqual({ ok: false, reason: 'seated_elsewhere' });
    expect((await balances(db, alice)).coins).toBe(9000);
  });

  it('refuses a buy-in above the balance without leaving a lock', async () => {
    expect(await buyIn(db, { playerId: alice, tableId: 't1', room: 'poker-free', seat: 0, chips: 10_001 })).toEqual({ ok: false, reason: 'insufficient', balance: 10_000 });
    expect(await seatLock(db, alice)).toBeNull();
  });

  it('pays a cash-out once: a replay or another table finds no lock', async () => {
    await buyIn(db, { playerId: alice, tableId: 't1', room: 'poker-free', seat: 0, chips: 1000 });
    expect(await cashOut(db, { playerId: alice, tableId: 't2', chips: 5000 })).toBeNull();
    expect(await cashOut(db, { playerId: alice, tableId: 't1', chips: 800 })).toMatchObject({ balance: 9800 });
    expect(await cashOut(db, { playerId: alice, tableId: 't1', chips: 800 })).toBeNull();
    expect((await balances(db, alice)).coins).toBe(9800);
  });

  it('allows a rebuy at the same table after cashing out (distinct ledger keys)', async () => {
    await buyIn(db, { playerId: alice, tableId: 't1', room: 'poker-free', seat: 0, chips: 1000 });
    await cashOut(db, { playerId: alice, tableId: 't1', chips: 0 });
    const again = await buyIn(db, { playerId: alice, tableId: 't1', room: 'poker-free', seat: 3, chips: 2000 });
    expect(again).toMatchObject({ ok: true, balance: 7000 });
    expect(await cashOut(db, { playerId: alice, tableId: 't1', chips: 2500 })).toMatchObject({ balance: 9500 });
  });

  it('refuses negative checkpoints and checkpoints for another table', async () => {
    await buyIn(db, { playerId: alice, tableId: 't1', room: 'poker-free', seat: 0, chips: 1000 });
    expect(await checkpoint(db, { playerId: alice, tableId: 't1', seat: 0, stack: -1, handNumber: 1 })).toBe(false);
    expect(await checkpoint(db, { playerId: alice, tableId: 't9', seat: 0, stack: 5, handNumber: 1 })).toBe(false);
  });
});

describe('table audit', () => {
  it('accounts for every chip: humans + house net to zero', async () => {
    await buyIn(db, { playerId: alice, tableId: 't1', room: 'poker-free', seat: 0, chips: 1000 });
    await buyIn(db, { playerId: bob, tableId: 't1', room: 'poker-free', seat: 1, chips: 2000 });
    // Hand 1: bots win 300 from the humans. Hand 2: bots lose 100.
    await recordHand(db, 't1', 300);
    await recordHand(db, 't1', -100);
    await checkpoint(db, { playerId: bob, tableId: 't1', seat: 1, stack: 2200, handNumber: 2 });
    await cashOut(db, { playerId: alice, tableId: 't1', chips: 600 }); // alice −400, bob +200, bots +200
    const mid = await auditTable(db, 't1');
    expect(mid).toMatchObject({ hands: 2, buyIns: 3000, cashOuts: 600, seatedStacks: 2200, botNet: 200, drift: 0 });
    await cashOut(db, { playerId: bob, tableId: 't1', chips: 2200 });
    expect(await auditTable(db, 't1')).toMatchObject({ seatedPlayers: 0, drift: 0 });
  });

  it('shows drift when chips appear from nowhere', async () => {
    await buyIn(db, { playerId: alice, tableId: 't1', room: 'poker-free', seat: 0, chips: 1000 });
    await cashOut(db, { playerId: alice, tableId: 't1', chips: 1200 }); // no hand recorded the bots losing 200
    expect((await auditTable(db, 't1'))?.drift).toBe(200);
  });
});
