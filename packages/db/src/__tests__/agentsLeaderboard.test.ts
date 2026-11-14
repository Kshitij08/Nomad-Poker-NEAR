import { beforeEach, describe, expect, it } from 'vitest';
import { LeaderboardKind } from '@nomad/engine/leaderboards/freePlayLeaderboardMath';
import { createPlayer } from '../accounts';
import { leaderboard } from '../leaderboards';
import { D1Shim } from '../testing/d1Shim';
import type { PlayerRow } from '../types';

// A Wednesday; the week started Monday 2026-11-09 00:00 UTC.
const NOW = Date.UTC(2026, 10, 11, 12);
const LAST_WEEK = Date.UTC(2026, 10, 6, 12);
let db: D1Database;
let ann: PlayerRow;
let bob: PlayerRow;

async function deployment(id: string, owner: PlayerRow, name: string, phase = 'completed'): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_deployments (id, owner_id, agent_name, profile, strategy_version, strategy, bankroll, stake, max_hands, max_runtime, phase, stack, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'balanced', 'v1', '{}', 5000, 500, 100, 3600, ?4, 5000, ?5, ?5)`,
    )
    .bind(id, owner.id, name, phase, LAST_WEEK)
    .run();
}
async function hand(id: string, n: number, net: number, at: number): Promise<void> {
  await db.prepare(`INSERT INTO agent_hands (deployment_id, hand_number, net, record, created_at) VALUES (?1, ?2, ?3, '{}', ?4)`).bind(id, n, net, at).run();
}

beforeEach(async () => {
  db = await D1Shim.migrated();
  ann = await createPlayer(db, { displayName: 'Ann' }, LAST_WEEK);
  bob = await createPlayer(db, { displayName: 'Bob' }, LAST_WEEK);
});

describe('Agents leaderboard', () => {
  it("ranks each Agent by this week's hands only, with its owner and hand count", async () => {
    await deployment('d1', ann, 'Shark');
    await deployment('d2', bob, 'Rock');
    await deployment('d3', ann, 'Old', 'completed');
    await hand('d1', 1, 300, NOW - 1000);
    await hand('d1', 2, -100, NOW - 500);
    await hand('d1', 3, 9000, LAST_WEEK); // last week: not counted
    await hand('d2', 1, 450, NOW - 200);
    await hand('d3', 1, 9999, LAST_WEEK);

    const page = await leaderboard(db, ann.id, LeaderboardKind.AgentsWeekly, 0, NOW);
    expect(page.rows).toEqual([
      { rank: 1, displayName: 'Rock', score: 450, isLocal: false, ownerName: 'Bob', hands: 1, picture: null },
      { rank: 2, displayName: 'Shark', score: 200, isLocal: true, ownerName: 'Ann', hands: 2, picture: null },
    ]);
    expect(page).toMatchObject({ localScore: 200, localRank: 2, hasMore: false });
  });

  it('gives no rank to a player whose Agents did not play this week', async () => {
    await deployment('d1', bob, 'Rock');
    await hand('d1', 1, 50, NOW - 100);
    expect(await leaderboard(db, ann.id, LeaderboardKind.AgentsWeekly, 0, NOW)).toMatchObject({ localRank: 0, localScore: 0 });
  });
});
