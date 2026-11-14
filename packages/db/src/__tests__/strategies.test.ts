import { beforeEach, describe, expect, it } from 'vitest';
import { newAgentHandRecord } from '@nomad/engine/agents';
import { createPlayer, findPlayer } from '../accounts';
import { completeAgent, markSeated, recordAgentHand, startAgent } from '../agents';
import { balances, post } from '../ledger';
import {
  coachReport, creatorDashboard, getStrategy, listStrategies, publishStrategy, recordDecisions, recordStyleHands, strategyForAgent, twin,
  unlistStrategy, type DecisionRow, type ListingRules,
} from '../strategies';
import { D1Shim } from '../testing/d1Shim';
import type { PlayerRow } from '../types';

const T0 = Date.UTC(2026, 10, 1, 12);
const DAY = 86_400_000;
const RULES: ListingRules = { minHands: 20, minDays: 7, houseBb100: 0, houseMinHands: 2000 };
const SHARK = { foldBelow: 0.2, raiseAbove: 0.55, aggression: 0.8, bluffChance: 0.1, raiseFractionOfPot: 0.9 };
let db: D1Database;
let ann: PlayerRow;
let bob: PlayerRow;

beforeEach(async () => {
  db = await D1Shim.migrated();
  ann = (await findPlayer(db, (await createPlayer(db, { displayName: 'Ann' }, T0)).id))!;
  bob = (await findPlayer(db, (await createPlayer(db, { displayName: 'Bob' }, T0)).id))!;
  for (const p of [ann, bob]) await post(db, [{ playerId: p.id, currency: 'coins', delta: 1_000_000, reason: 'test', idempotencyKey: 'seed' }]);
});

/** One finished session of `hands` hands for `strategyId`, winning `perHand` (± a little) each hand at stake 1000 (bb 50). */
async function session(owner: string, id: string, strategyId: string, hands: number, perHand: number, at: number) {
  // 10,000 Coins: the bankroll puts it at the 1,000 table (big blind 50), the scale these numbers assume.
  await startAgent(db, owner, { session: id, bankroll: 10_000, strategyId }, { now: at });
  await markSeated(db, id, 'poker-free', at);
  let stack = 10_000;
  for (let n = 1; n <= hands; n++) {
    const net = perHand + (n % 2 ? 10 : -10);
    stack += net;
    await recordAgentHand(db, id, 'poker-free', {
      record: newAgentHandRecord({ DeploymentId: id, HandNumber: n, NetPnl: net, EndingStack: stack }), replayJson: null, handsPlayed: n, stack,
      runtimeSeconds: n, wins: 0, losses: 0, showdowns: 0,
    }, at);
  }
  await completeAgent(db, id, { stopReason: 'max_hands', endingStack: stack, room: 'poker-free' }, at);
}

describe('strategies market', () => {
  it('publishes versions, earns a track record, and only qualifies with enough hands, days and edge', async () => {
    const s1 = await publishStrategy(db, bob, { name: 'Shark', profile: SHARK }, RULES, T0);
    expect(s1).toMatchObject({ name: 'Shark', version: 1, creatorName: 'Bob', listed: true, qualified: false, record: { hands: 0 } });
    await expect(strategyForAgent(db, s1.strategyId, ann.id, RULES, T0)).rejects.toMatchObject({ status: 403 });
    // The creator may always run it: that builds the record.
    expect(await strategyForAgent(db, s1.strategyId, bob.id, RULES, T0)).toMatchObject({ hasCustom: true, foldBelow: 0.2, aggression: 0.8 });

    await session(bob.id, 'BOBRUN1', s1.strategyId, 30, 100, T0 + DAY);
    let s = await getStrategy(db, s1.strategyId, RULES, T0 + 2 * DAY);
    expect(s.record).toMatchObject({ sessions: 1, hands: 30, net: 3000, bb100: 200 });
    expect(s.qualified).toBe(false); // too young
    s = await getStrategy(db, s1.strategyId, RULES, T0 + 8 * DAY);
    expect(s.qualified).toBe(true);
    expect((await listStrategies(db, { sort: 'top' }, RULES, T0 + 8 * DAY)).map((x) => x.name)).toEqual(['Shark']);
    expect(await strategyForAgent(db, s1.strategyId, ann.id, RULES, T0 + 8 * DAY)).toMatchObject({ raiseAbove: 0.55 });

    // A near-copy of a qualified listing by someone else is refused; a new version of your own replaces the old.
    await expect(publishStrategy(db, ann, { name: 'Copycat', profile: SHARK }, RULES, T0 + 8 * DAY)).rejects.toMatchObject({ status: 409 });
    const v2 = await publishStrategy(db, bob, { name: 'Shark', profile: { ...SHARK, bluffChance: 0.02 } }, RULES, T0 + 8 * DAY);
    expect(v2.version).toBe(2);
    expect((await getStrategy(db, s1.strategyId, RULES, T0 + 8 * DAY)).listed).toBe(false);
    await unlistStrategy(db, bob.id, v2.strategyId);
    await expect(unlistStrategy(db, ann.id, v2.strategyId)).rejects.toMatchObject({ status: 404 });
  });

  it("pays the creator from a copier's profit and shows it on their dashboard", async () => {
    const s1 = await publishStrategy(db, bob, { name: 'Shark', profile: SHARK }, RULES, T0);
    await session(bob.id, 'BOBRUN1', s1.strategyId, 30, 100, T0 + DAY);
    await session(ann.id, 'ANNCOPY1', s1.strategyId, 10, 100, T0 + 8 * DAY); // +1000 → 80 to Bob
    const d = await creatorDashboard(db, bob.id, RULES, T0 + 9 * DAY);
    expect(d).toMatchObject({ earned: 80, paid: 80, settlements: 1 });
    expect((await balances(db, bob.id)).coins).toBe(1_010_000 + 3000 + 80);
    expect(d.strategies[0]!.record).toMatchObject({ copiers: 2, sessions: 2, hands: 40 });
  });

  it('fits a twin and a coach report from recorded decisions and hands', async () => {
    const rows: DecisionRow[] = [];
    for (let i = 0; i < 60; i++) {
      const strength = (i % 20) / 20;
      rows.push({
        playerId: ann.id, table: 'poker-free', handNo: i, street: 0, position: i % 6, opponents: 5, strength, pot: 75, toCall: 50,
        minRaiseTo: 100, bigBlind: 50, stack: 1000, action: strength < 0.3 ? 'fold' : strength > 0.7 ? 'raise' : 'call', amount: strength > 0.7 ? 150 : 0,
      });
    }
    rows.push({ ...rows[0]!, action: 'shove' as never }); // skipped
    expect(await recordDecisions(db, rows, T0)).toBe(60);
    expect(await recordStyleHands(db, rows.slice(0, 30).map((r, i) => ({ playerId: r.playerId, table: r.table, handNo: r.handNo, position: r.position, bigBlind: 50, net: i % 3 ? -50 : 120, showdown: i % 4 === 0, won: i % 3 === 0 })), T0)).toBe(30);
    const t = await twin(db, ann.id);
    expect(t.decisions).toBe(60);
    expect(t.confidence).toBeGreaterThan(0);
    const c = await coachReport(db, ann.id, { now: T0 });
    expect(c).toMatchObject({ hands: 30, decisions: 60, note: null });
    await expect(publishStrategy(db, ann, { name: 'My twin', fromTwin: true }, RULES, T0)).rejects.toMatchObject({ status: 400 });
  });
});
