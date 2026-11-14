/**
 * Races found by the Phase 7 security review, replayed deterministically: each step a concurrent request would take
 * runs in the losing order. Money must never move for a state change that didn't happen.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPlayer, findPlayer } from '../accounts';
import { agentRow, completeAgent, markSeated, startAgent } from '../agents';
import { balances } from '../ledger';
import { createTournament, editTournament, register, markStarted, postResult, roster } from '../tournaments';
import { D1Shim } from '../testing/d1Shim';

const T0 = Date.UTC(2026, 10, 9, 12);
let db: D1Database;

beforeEach(async () => {
  db = await D1Shim.migrated();
});

describe('race: stopping a queued Agent while a table seats it', () => {
  it('pays nothing back when the Agent was seated between the stop read and the stop write', async () => {
    const owner = (await createPlayer(db, { displayName: 'Owner' }, T0)).id;
    await startAgent(db, owner, { session: 'RACE01', bankroll: 5000, stake: 1000 }, { now: T0 });
    const seen = (await agentRow(db, 'RACE01'))!; // the stop route reads: queued
    expect(seen.phase).toBe('queued');
    expect(await markSeated(db, 'RACE01', 'poker-free', T0 + 1)).toBe(true); // a table takes it meanwhile
    // The stop route completes "the queued Agent" with its bankroll.
    await completeAgent(db, 'RACE01', { stopReason: 'owner_stop', endingStack: seen.bankroll, from: 'queued' }, T0 + 2);
    expect((await agentRow(db, 'RACE01'))!.phase).toBe('playing'); // still the table's
    expect((await balances(db, owner)).coins).toBe(5000); // the bankroll stays at the table
  });
});

describe('race: changing the entry fee while players register', () => {
  it('never counts a fee nobody paid', async () => {
    const host = (await createPlayer(db, { displayName: 'Host' }, T0)).id;
    const alts = [];
    for (let i = 0; i < 3; i++) alts.push((await findPlayer(db, (await createPlayer(db, { displayName: `Alt${i}` }, T0)).id))!);
    const rules = { minLeadMs: 0, maxLeadMs: 86_400_000, maxActivePerHost: 2 };
    const t = (await createTournament(db, host, { name: 'Cheap', entryFee: 1, maxPlayers: 8, startsAtUnix: (T0 + 3_600_000) / 1000 }, rules, T0)).tournament;
    // Two registrations read fee 1; the host's edit lands between their read and their write.
    const regA = register(db, alts[0]!, t.id, T0 + 1);
    const regB = register(db, alts[1]!, t.id, T0 + 1);
    const edit = editTournament(db, host, t.id, { entryFee: 1_000_000 }, rules, T0 + 1).catch((e) => e);
    await Promise.all([regA.catch((e) => e), regB.catch((e) => e), edit]);
    const fee = (await db.prepare('SELECT entry_fee FROM tournaments WHERE id = ?1').bind(t.id).first<{ entry_fee: number }>())!.entry_fee;
    const paid = await db.prepare('SELECT sum(paid_amount) AS s, count(*) AS n FROM tournament_entries WHERE tournament_id = ?1').bind(t.id).first<{ s: number; n: number }>();
    // Either the fee changed and nobody registered at the old price, or the fee stayed: never both.
    if (fee !== 1) expect(paid!.n).toBe(0);
    // And the prizes come from what was actually paid in.
    if (paid!.n >= 2) {
      await roster(db, t.id, T0 + 3_600_000);
      await markStarted(db, t.id, T0 + 3_600_001);
      const codes = (await roster(db, t.id, T0 + 3_600_002)).entrants.map((e) => e.playFabId);
      await postResult(db, t.id, { championId: codes[0], standings: codes.map((c, i) => ({ playFabId: c, place: i + 1, roundReached: 1 })) }, T0 + 3_700_000);
      const net = await db.prepare('SELECT sum(delta) AS s FROM ledger_entries WHERE ref = ?1').bind(t.id).first<{ s: number }>();
      expect(net!.s).toBe(0);
    }
  });

  it('pays prizes from the fees actually paid, even if the fee field says otherwise', async () => {
    const host = (await createPlayer(db, { displayName: 'Host' }, T0)).id;
    const a = (await findPlayer(db, (await createPlayer(db, { displayName: 'A' }, T0)).id))!;
    const b = (await findPlayer(db, (await createPlayer(db, { displayName: 'B' }, T0)).id))!;
    const rules = { minLeadMs: 0, maxLeadMs: 86_400_000, maxActivePerHost: 2 };
    const t = (await createTournament(db, host, { name: 'Cheap', entryFee: 1, maxPlayers: 8, startsAtUnix: (T0 + 3_600_000) / 1000 }, rules, T0)).tournament;
    await register(db, a, t.id, T0 + 1);
    await register(db, b, t.id, T0 + 1);
    // The interleaving the race produces: entries paid 1 each, the fee field now 1,000,000.
    await db.prepare('UPDATE tournaments SET entry_fee = 1000000 WHERE id = ?1').bind(t.id).run();
    await roster(db, t.id, T0 + 3_600_000);
    await markStarted(db, t.id, T0 + 3_600_001);
    const codes = (await roster(db, t.id, T0 + 3_600_002)).entrants.map((e) => e.playFabId);
    await postResult(db, t.id, { championId: codes[0], standings: codes.map((c, i) => ({ playFabId: c, place: i + 1, roundReached: 1 })) }, T0 + 3_700_000);
    const net = await db.prepare('SELECT sum(delta) AS s FROM ledger_entries WHERE ref = ?1').bind(t.id).first<{ s: number }>();
    expect(net!.s).toBe(0);
  });
});

describe('smaller review findings', () => {
  it('ignores a made-up stake (the bankroll picks the table), hides internal ids in the market, and keeps support from banning admins', async () => {
    const { listStrategies, publishStrategy } = await import('../strategies');
    const { setBan } = await import('../admin');
    const owner = (await findPlayer(db, (await createPlayer(db, { displayName: 'Owner' }, T0)).id))!;
    expect((await startAgent(db, owner.id, { session: 'STAKE60', bankroll: 2000, stake: 60 }, { now: T0 })).stake).toBe(100);
    await db.prepare("UPDATE agent_deployments SET phase = 'completed' WHERE id = 'STAKE60'").run(); // one active Agent per owner

    const rules = { minHands: 0, minDays: 0, houseBb100: -1e9, houseMinHands: 1e9 };
    const s = await publishStrategy(db, owner, { name: 'Open', profile: { foldBelow: 0.3, raiseAbove: 0.6, aggression: 0.5, bluffChance: 0.05, raiseFractionOfPot: 0.6 } }, rules, T0);
    expect(s.creatorId).toBe(owner.friend_code);
    const listed = await listStrategies(db, { sort: 'new' }, rules, T0, false);
    expect(JSON.stringify(listed)).not.toContain(owner.id);

    const boss = (await createPlayer(db, { displayName: 'Boss' }, T0)).id;
    const help = (await createPlayer(db, { displayName: 'Help' }, T0)).id;
    await db.batch([
      db.prepare(`INSERT INTO admin_users (player_id, role, added_at) VALUES (?1, 'admin', 0)`).bind(boss),
      db.prepare(`INSERT INTO admin_users (player_id, role, added_at) VALUES (?1, 'support', 0)`).bind(help),
    ]);
    await expect(setBan(db, { player_id: help, role: 'support' }, boss, true, 'coup attempt', T0)).rejects.toMatchObject({ status: 403 });
  });
});
