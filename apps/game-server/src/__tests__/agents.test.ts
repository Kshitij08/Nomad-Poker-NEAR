/**
 * Agents inside the game server: a queued deployment seated straight at a Quick Play table (no farm, no claims), playing
 * filler bots with nobody connected, checkpointing every hand, ending on its own limits or the owner's Stop, and paying
 * its stack back through the ledger. Real TableSlot / TableHost / PokerServerGame on the node:sqlite D1 stand-in.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlayer } from '@nomad/db/accounts';
import { agentHands, agentRow, startAgent } from '@nomad/db/agents';
import { balances, entries } from '@nomad/db/ledger';
import { auditTable } from '@nomad/db/seatLocks';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { realClock } from '@nomad/table-server/clock';
import { TableHost } from '../tableHost';
import { TableSlot } from '../tableSlot';

const SPEED = 50;
const quiet = (level: 'info' | 'warn' | 'error', m: string) => {
  if (level === 'error') console.error(m);
};

let db: D1Database;

async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const hosts: TableHost[] = [];

function slot(session: string): TableSlot {
  return new TableSlot({
    session,
    isSpawned: async () => false,
    qaRooms: true,
    qaSpeed: 1,
    log: quiet,
    createHost: (spec) => {
      const host = new TableHost({ spec, db, clock: realClock(SPEED), log: quiet, stillSeatedElsewhere: async () => false });
      hosts.push(host);
      return host;
    },
  });
}

beforeEach(async () => {
  db = await D1Shim.migrated();
});

afterAll(async () => {
  for (const h of hosts) await h.close('test over');
});

describe('Agents in the game server', () => {
  it('plays to its hand limit at an empty Quick Play table and pays the stack back', async () => {
    const owner = (await createPlayer(db, { displayName: 'Owner' })).id;
    const row = await startAgent(db, owner, { session: 'AGENTA1', agentName: 'Robo', bankroll: 2000, stake: 100, maxHands: 4, profile: 'daredevil' });
    expect((await balances(db, owner)).coins).toBe(8000);

    const s = slot('poker-free-st100');
    expect(await s.seatAgent(row)).toEqual({ seated: true });
    expect(s.busy).toBe(true);
    expect((await agentRow(db, 'AGENTA1'))!.phase).toBe('playing');

    await until(async () => (await agentRow(db, 'AGENTA1'))!.phase === 'completed', 60_000);
    const done = (await agentRow(db, 'AGENTA1'))!;
    expect(done).toMatchObject({ stop_reason: 'max_hands', hands_played: 4, room: 'poker-free-st100' });
    expect(done.returned).toBe(done.stack);
    expect((await balances(db, owner)).coins).toBe(8000 + done.stack);
    expect((await entries(db, owner, { limit: 3 })).entries.map((e) => e.reason)).toEqual(['agent:return', 'agent:bankroll', 'starter']);
    // The table's books balance with the Agent's result counted beside the bots' (no humans, so it is all theirs).
    const t = await db.prepare(`SELECT id, bot_net, agent_net FROM table_sessions WHERE room = 'poker-free-st100'`).first<{ id: string; bot_net: number; agent_net: number }>();
    await hosts[0]!.settled();
    expect((await auditTable(db, t!.id))!.drift).toBe(0);
    expect((await db.prepare('SELECT agent_net FROM table_sessions WHERE id = ?1').bind(t!.id).first<{ agent_net: number }>())!.agent_net).toBe(done.stack - 2000);

    const hands = await agentHands(db, 'AGENTA1', 10, 0);
    expect(hands.Total).toBe(4);
    expect(hands.Hands!.every((h) => h.DeploymentId === 'AGENTA1' && h.AssignedTable === 'poker-free-st100')).toBe(true);
    expect(hands.Hands!.some((h) => h.HasReplay && h.ReplayJson!.startsWith('{'))).toBe(true);
    // The table empties once the Agent has left; the slot may close it.
    await until(async () => !s.busy, 10_000);
  }, 90_000);

  it("leaves at the hand boundary when its owner presses Stop, and is never seated twice", async () => {
    const owner = (await createPlayer(db, { displayName: 'Owner' })).id;
    const row = await startAgent(db, owner, { session: 'AGENTB1', bankroll: 3000, stake: 100, maxHands: 500 });
    const s = slot('poker-free-st100-2');
    expect(await s.seatAgent(row)).toEqual({ seated: true });
    expect(await s.seatAgent(row)).toEqual({ seated: false });
    await until(async () => (await agentRow(db, 'AGENTB1'))!.hands_played >= 1, 30_000);
    expect(s.holdsAgent('AGENTB1')).toBe(true);
    expect(s.stopAgent('AGENTB1')).toBe(true);
    await until(async () => (await agentRow(db, 'AGENTB1'))!.phase === 'completed', 30_000);
    const done = (await agentRow(db, 'AGENTB1'))!;
    expect(done.stop_reason).toBe('owner_stop');
    expect(done.hands_played).toBeLessThan(500);
    expect((await balances(db, owner)).coins).toBe(7000 + done.stack);
    expect(s.holdsAgent('AGENTB1')).toBe(false);
  }, 60_000);
});
