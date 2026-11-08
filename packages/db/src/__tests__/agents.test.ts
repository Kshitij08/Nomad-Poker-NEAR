import { beforeEach, describe, expect, it } from 'vitest';
import { newAgentHandRecord } from '@nomad/engine/agents';
import { createPlayer } from '../accounts';
import {
  activeAgent, agentHands, agentHistory, agentProgress, agentResult, completeAgent, markSeated, recordAgentHand, requestAgentStop,
  staleAgents, startAgent, AGENT_STALE_MS,
} from '../agents';
import { balances, entries } from '../ledger';
import { D1Shim } from '../testing/d1Shim';

const T0 = Date.UTC(2026, 10, 9, 12);
let db: D1Database;
let ann: string;
let bob: string;

beforeEach(async () => {
  db = await D1Shim.migrated();
  ann = (await createPlayer(db, { displayName: 'Ann' }, T0)).id; // 10,000 coins each
  bob = (await createPlayer(db, { displayName: 'Bob' }, T0)).id;
});

const start = (owner: string, session: string, extra: Record<string, unknown> = {}) =>
  startAgent(db, owner, { session, agentName: 'Robo', bankroll: 3000, stake: 1000, maxHands: 50, ...extra }, { now: T0 });

const hand = (n: number, stack: number, prev: number) => ({
  record: newAgentHandRecord({ DeploymentId: 'AGENT1', HandNumber: n, StartingStack: prev, EndingStack: stack, NetPnl: stack - prev, Result: stack > prev ? 'win' : 'loss' }),
  replayJson: n === 2 ? '{"v":1}' : null,
  handsPlayed: n,
  stack,
  runtimeSeconds: n * 20,
  wins: stack > prev ? 1 : 0,
  losses: stack > prev ? 0 : 1,
  showdowns: 0,
});

describe('agent sessions', () => {
  it('takes the bankroll when queued, checkpoints hands, and pays the stack back once', async () => {
    await start(ann, 'AGENT1');
    expect((await balances(db, ann)).coins).toBe(7000);
    expect(await activeAgent(db, ann)).toMatchObject({ id: 'AGENT1', phase: 'queued', stack: 3000 });

    expect(await markSeated(db, 'AGENT1', 'poker-free', T0 + 1000)).toBe(true);
    await recordAgentHand(db, 'AGENT1', 'poker-free', hand(1, 3400, 3000), T0 + 2000);
    await recordAgentHand(db, 'AGENT1', 'poker-free', hand(2, 3250, 3400), T0 + 3000);
    // Another room can't write to it.
    await recordAgentHand(db, 'AGENT1', 'poker-free-2', hand(3, 9999, 3250), T0 + 4000);

    const row = (await activeAgent(db, ann))!;
    const p = await agentProgress(db, row);
    expect(p).toMatchObject({ running: true, phase: 'playing', HandsPlayed: 2, Stack: 3250, NetPnl: 250, AssignedTable: 'poker-free' });
    expect(p.RecentHands!.map((h) => [h.HandNumber, h.HasReplay, h.ReplayJson])).toEqual([[1, false, ''], [2, true, '']]);

    const done = await completeAgent(db, 'AGENT1', { stopReason: 'max_hands', endingStack: 3250, room: 'poker-free', handsPlayed: 2 }, T0 + 5000);
    expect(done).toMatchObject({ phase: 'completed', returned: 3250 });
    await completeAgent(db, 'AGENT1', { stopReason: 'max_hands', endingStack: 3250, room: 'poker-free' }, T0 + 6000);
    expect((await balances(db, ann)).coins).toBe(10_250);
    expect((await entries(db, ann, { limit: 5 })).entries.map((e) => [e.reason, e.delta])).toEqual([
      ['agent:return', 3250],
      ['agent:bankroll', -3000],
      ['starter', 10_000],
    ]);

    expect(agentResult(done!)).toMatchObject({ DeploymentId: 'AGENT1', EndingStack: 3250, NetPnl: 250, StopReason: 'max_hands', ServerSettled: true });
    expect((await agentHistory(db, ann, 20, 0)).Total).toBe(1);
    const hands = await agentHands(db, 'AGENT1', 10, 0);
    expect(hands.Hands!.map((h) => [h.HandNumber, h.ReplayJson])).toEqual([[2, '{"v":1}'], [1, '']]);
  });

  it('allows one Agent per owner, refuses a bankroll the owner does not have', async () => {
    await start(ann, 'AGENT1');
    await expect(start(ann, 'AGENT2')).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await expect(start(bob, 'AGENT1')).rejects.toMatchObject({ status: 409, message: 'That Agent session already exists.' });
    await expect(start(bob, 'AGENT3', { bankroll: 50_000 })).rejects.toMatchObject({ status: 409, code: 'insufficient_funds' });
    expect((await balances(db, bob)).coins).toBe(10_000);
    await expect(start(bob, 'x')).rejects.toMatchObject({ status: 400 });
  });

  it('a stop request shows in progress; a lost table is found as stale', async () => {
    await start(ann, 'AGENT1');
    await markSeated(db, 'AGENT1', 'poker-free', T0);
    await requestAgentStop(db, 'AGENT1', T0 + 1000);
    expect((await agentProgress(db, (await activeAgent(db, ann))!)).phase).toBe('stop_requested');
    expect(await staleAgents(db, T0 + 1000 + AGENT_STALE_MS - 1)).toEqual([]);
    expect((await staleAgents(db, T0 + 1000 + AGENT_STALE_MS + 1)).map((r) => r.id)).toEqual(['AGENT1']);
    await completeAgent(db, 'AGENT1', { stopReason: 'server_lost', endingStack: 3000, phase: 'failed' }, T0 + 200_000);
    expect((await balances(db, ann)).coins).toBe(10_000);
    expect(await activeAgent(db, ann)).toBeNull();
  });

  it("charges a copied strategy's profit share above the high-water mark, never on losses", async () => {
    await db
      .prepare(`INSERT INTO strategies (id, creator_id, creator_name, name, profile, created_at) VALUES ('s1', ?1, 'Bob', 'Shark', '{}', ?2)`)
      .bind(bob, T0)
      .run();
    // Session 1: +1000 → base 1000 → creator 80, platform 20.
    await start(ann, 'COPY1', { strategyId: 's1' });
    await markSeated(db, 'COPY1', 'poker-free', T0);
    const one = await completeAgent(db, 'COPY1', { stopReason: 'max_hands', endingStack: 4000, room: 'poker-free' }, T0 + 1);
    expect(agentResult(one!)?.CopyFee).toEqual({ strategyId: 's1', sessionPnl: 1000, feeBase: 1000, creatorFee: 80, platformFee: 20 });
    expect((await balances(db, ann)).coins).toBe(10_000 - 3000 + 3900);
    expect((await balances(db, bob)).coins).toBe(10_080);

    // Session 2: −500 → no fee. Session 3: +800 → cumulative 1300, peak was 1000 → base 300.
    await start(ann, 'COPY2', { strategyId: 's1' });
    await completeAgent(db, 'COPY2', { stopReason: 'stop_loss', endingStack: 2500 }, T0 + 2);
    await start(ann, 'COPY3', { strategyId: 's1' });
    const three = await completeAgent(db, 'COPY3', { stopReason: 'max_hands', endingStack: 3800 }, T0 + 3);
    expect(agentResult(three!)?.CopyFee).toMatchObject({ feeBase: 300, creatorFee: 24, platformFee: 6 });
    expect((await balances(db, bob)).coins).toBe(10_104);

    // The creator running their own strategy pays nothing.
    await start(bob, 'OWN1', { strategyId: 's1' });
    const own = await completeAgent(db, 'OWN1', { stopReason: 'max_hands', endingStack: 5000 }, T0 + 4);
    expect(agentResult(own!)?.CopyFee).toBeNull();
  });
});
