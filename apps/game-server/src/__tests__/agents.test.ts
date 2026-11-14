/**
 * Agents inside the game server: a queued deployment seated straight at a Quick Play table (no farm, no claims), playing
 * filler bots with nobody connected, checkpointing every hand, ending on its own limits or the owner's Stop, and paying
 * its stack back through the ledger. Real TableSlot / TableHost / PokerServerGame on the node:sqlite D1 stand-in.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlayer, createSession } from '@nomad/db/accounts';
import { PokerEventCodec, isHiddenCard } from '@nomad/engine/events/pokerEventCodec';
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

/** A D1 that refuses every write and read for `ms` from `start()` (like an export in progress), then recovers. */
function flaky(db: D1Database): { db: D1Database; start(ms: number): void; refused: () => number } {
  let until = 0;
  let refused = 0;
  const down = () => {
    if (Date.now() < until) {
      refused++;
      throw new Error('D1_ERROR: Currently processing a long-running export.');
    }
  };
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'batch') return async (stmts: D1PreparedStatement[]) => (down(), target.batch(stmts));
      if (key === 'prepare')
        return (sql: string) => {
          const st = target.prepare(sql);
          for (const m of ['run', 'all', 'first'] as const) {
            const orig = (st as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!.bind(st);
            (st as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => (down(), orig(...a));
          }
          const bind = st.bind.bind(st);
          st.bind = (...a: unknown[]) => {
            const b = bind(...a);
            for (const m of ['run', 'all', 'first'] as const) {
              const orig = (b as unknown as Record<string, (...x: unknown[]) => unknown>)[m]!.bind(b);
              (b as unknown as Record<string, unknown>)[m] = async (...x: unknown[]) => (down(), orig(...x));
            }
            return b;
          };
          return st;
        };
      return Reflect.get(target, key);
    },
  });
  return { db: wrapped, start: (ms) => void (until = Date.now() + ms), refused: () => refused };
}

describe('Agents in the game server', () => {
  it('rides out a D1 outage longer than a few seconds without dropping a hand (zero drift)', async () => {
    const owner = (await createPlayer(db, { displayName: 'Owner' })).id;
    const row = await startAgent(db, owner, { session: 'AGENTF1', bankroll: 2000, stake: 100, maxHands: 6 });
    const f = flaky(db);
    const s = new TableSlot({
      session: 'poker-free-st100-9', isSpawned: async () => false, qaRooms: true, qaSpeed: 1, log: quiet,
      createHost: (spec) => {
        const host = new TableHost({ spec, db: f.db, clock: realClock(SPEED), log: quiet, stillSeatedElsewhere: async () => false });
        hosts.push(host);
        return host;
      },
    });
    expect(await s.seatAgent(row)).toEqual({ seated: true });
    await until(async () => (await agentRow(db, 'AGENTF1'))!.hands_played >= 1, 30_000);
    f.start(8000); // well past the old ~3 s of retries
    await until(async () => (await agentRow(db, 'AGENTF1'))!.phase === 'completed', 60_000);
    expect(f.refused()).toBeGreaterThan(0);
    const t = await db.prepare(`SELECT id FROM table_sessions WHERE room = 'poker-free-st100-9'`).first<{ id: string }>();
    await (hosts[hosts.length - 1] as TableHost).settled();
    const audit = (await auditTable(db, t!.id))!;
    expect(audit.hands).toBe(6);
    expect(audit.drift).toBe(0);
  }, 90_000);

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

  it("shows an Agent's hole cards to its owner watching the table, and to no other watcher", async () => {
    const owner = (await createPlayer(db, { displayName: 'Owner' })).id;
    const ownerTicket = (await createSession(db, owner)).token;
    const strangerTicket = (await createSession(db, (await createPlayer(db, { displayName: 'Stranger' })).id)).token;
    const row = await startAgent(db, owner, { session: 'AGENTW1', bankroll: 3000, stake: 100, maxHands: 500 });
    const s = slot('poker-free-st100-3');
    expect(await s.seatAgent(row)).toEqual({ seated: true });

    // Each watcher: the agent seat's dealt cards it was sent (real or hidden).
    const watch = (ticket: string) => {
      const dealt: { seat: number; hidden: boolean }[] = [];
      const sock = {
        send: (d: string | Uint8Array) => {
          if (typeof d === 'string') return;
          const e = PokerEventCodec.decode(d).event;
          if (e?.type === 'HoleCardsDealt') dealt.push({ seat: e.seat, hidden: isHiddenCard(e.card0) });
        },
        close: () => undefined,
      };
      return { sock, dealt, start: async () => {
        await s.message(sock, JSON.stringify({ t: 'join', session: 'poker-free-st100-3', appVersion: '', watch: true }));
        await s.message(sock, JSON.stringify({ t: 'hello', name: 'W', token: 't', ticket, buyIn: 0 }));
      } };
    };
    const mine = watch(ownerTicket);
    const theirs = watch(strangerTicket);
    await mine.start();
    await theirs.start();
    await until(() => mine.dealt.some((d) => !d.hidden) && theirs.dealt.length >= 4, 30_000);
    const agentSeats = new Set(mine.dealt.filter((d) => !d.hidden).map((d) => d.seat));
    expect(agentSeats.size).toBe(1); // only the Agent's seat, never a bot's
    expect(theirs.dealt.every((d) => d.hidden)).toBe(true);
    s.disconnect(mine.sock);
    s.disconnect(theirs.sock);
    s.stopAgent('AGENTW1');
  }, 60_000);

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
