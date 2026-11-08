import { beforeEach, describe, expect, it } from 'vitest';
import { createPlayer } from '../accounts';
import { completeAgent, markSeated, startAgent } from '../agents';
import { reconcile } from '../reconcile';
import { buyIn, cashOut, openTableSession, recordHand } from '../seatLocks';
import { D1Shim } from '../testing/d1Shim';

let db: D1Database;
let ann: string;

beforeEach(async () => {
  db = await D1Shim.migrated();
  ann = (await createPlayer(db, { displayName: 'Ann' })).id;
});

const failing = async () => (await reconcile(db)).checks.filter((c) => !c.ok).map((c) => c.name);

describe('reconciliation', () => {
  it('is clean after normal play: a table, an Agent', async () => {
    await openTableSession(db, { id: 't1', room: 'poker-free', stake: 1000 });
    await buyIn(db, { playerId: ann, tableId: 't1', room: 'poker-free', seat: 0, chips: 1000 });
    await recordHand(db, 't1', 200); // the bots won 200 from Ann
    await cashOut(db, { playerId: ann, tableId: 't1', chips: 800 });
    await startAgent(db, ann, { session: 'AGENT1', bankroll: 2000, stake: 1000 });
    await markSeated(db, 'AGENT1', 'poker-free');
    await completeAgent(db, 'AGENT1', { stopReason: 'max_hands', endingStack: 2300, room: 'poker-free' });
    const r = await reconcile(db);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'tables have zero drift')!.checked).toBe(1);
  });

  it('flags drift, a broken balance and a short Agent payment', async () => {
    await openTableSession(db, { id: 't1', room: 'poker-free', stake: 1000 });
    await buyIn(db, { playerId: ann, tableId: 't1', room: 'poker-free', seat: 0, chips: 1000 });
    await cashOut(db, { playerId: ann, tableId: 't1', chips: 900 }); // 100 vanished: no hand recorded it
    await db.prepare(`UPDATE balances SET amount = amount + 5 WHERE player_id = ?1 AND currency = 'coins'`).bind(ann).run();
    await startAgent(db, ann, { session: 'AGENT1', bankroll: 2000, stake: 1000 });
    await completeAgent(db, 'AGENT1', { stopReason: 'owner_stop', endingStack: 2000 });
    await db.prepare(`UPDATE agent_deployments SET returned = 1999 WHERE id = 'AGENT1'`).run();
    expect(await failing()).toEqual(['balances match the ledger', 'tables have zero drift', 'Agents paid exactly']);
  });
});
