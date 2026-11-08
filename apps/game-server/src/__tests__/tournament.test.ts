/**
 * A hosted tournament end to end in Node: the records on the real ledger SQL (node:sqlite D1 stand-in), the game
 * server's tournament room (TableSlot → TournamentHost → TournamentServerGame) behind a stand-in Worker socket route,
 * and eight real web clients (ClientGame + NetConnection in game-server mode) signed in with Nomad session tokens.
 * Entry fees and the host prize go in; 1st and 2nd are paid out of the ledger.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { PlayerAction, type LegalActions } from '@nomad/engine/actions/actions';
import { createPlayer, createSession } from '@nomad/db/accounts';
import { balances } from '@nomad/db/ledger';
import { createTournament, register, tournamentTick, tournamentView } from '@nomad/db/tournaments';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { realClock } from '@nomad/table-server/clock';
import { connectTable } from '../../../web/src/net/matchmaking';
import { headlessClient, type Headless } from '../../../web/server/__tests__/headlessClient';
import type { HostSocket, RoomHost } from '../roomHost';
import { canonicalSession } from '../roomSpec';
import { TableSlot } from '../tableSlot';
import { TournamentHost } from '../tournamentHost';
import { tournamentBySession } from '@nomad/db/tournaments';

const SPEED = 40;
const quiet = (level: 'info' | 'warn' | 'error', m: string) => {
  if (level !== 'info') console.error(m);
};

let db: D1Database;
let http: Server;
let base: string;
const slots = new Map<string, TableSlot>();
const hosts: RoomHost[] = [];

function slotFor(session: string): TableSlot {
  let slot = slots.get(session);
  if (!slot) {
    slot = new TableSlot({
      session,
      isSpawned: async () => false,
      qaRooms: true,
      qaSpeed: 1,
      log: quiet,
      createHost: async (spec) => {
        const t = await tournamentBySession(db, spec.name);
        if (!t) throw new Error('no such tournament');
        const host = new TournamentHost({ spec, db, tournamentId: t.id, clock: realClock(SPEED), log: quiet });
        hosts.push(host);
        return host;
      },
    });
    slots.set(session, slot);
  }
  return slot;
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  db = await D1Shim.migrated();
  http = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/v1/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const session = canonicalSession(url.searchParams.get('session'));
    if (url.pathname !== '/v1/tables/ws' || !session) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const slot = slotFor(session);
      const sock: HostSocket = { send: (d) => ws.readyState === ws.OPEN && ws.send(d), close: () => ws.close() };
      ws.on('message', (data, isBinary) => {
        if (!isBinary) void slot.message(sock, data.toString());
      });
      ws.on('close', () => slot.disconnect(sock));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const h of hosts) await h.close('test over');
  await new Promise<void>((r) => http.close(() => r()));
});

/** Shoves often, so eight players finish quickly. */
function gambler(legal: LegalActions): PlayerAction {
  if (legal.canAllIn && Math.random() < 0.4) return PlayerAction.allIn();
  if (legal.canCheck) return PlayerAction.check();
  if (legal.canCall) return PlayerAction.call();
  return PlayerAction.fold();
}

describe('game server: a hosted tournament', () => {
  it('plays 8 signed-in players to a champion and pays 1st and 2nd through the ledger', async () => {
    const host = await createPlayer(db, { displayName: 'Host' });
    const players: { id: string; name: string; token: string }[] = [];
    for (let i = 1; i <= 8; i++) {
      const p = await createPlayer(db, { displayName: `Player${i}` });
      players.push({ id: p.id, name: `Player${i}`, token: (await createSession(db, p.id)).token });
    }
    const startsAt = Date.now() + 6000;
    const t = (
      await createTournament(db, host.id, { name: 'Node Cup', entryFee: 500, hostPrize: 2000, maxPlayers: 8, speed: 'turbo', startsAtUnix: Math.ceil(startsAt / 1000) }, { minLeadMs: 0, maxLeadMs: 86_400_000, maxActivePerHost: 2 })
    ).tournament;
    for (const p of players) await register(db, { id: p.id, display_name: p.name }, t.id);
    for (const p of players) expect((await balances(db, p.id)).coins).toBe(9500);

    // The cron names the room to open (within 3 minutes of the start) and players learn where it is.
    const tick = await tournamentTick(db);
    expect(tick.open).toHaveLength(1);
    const session = tick.open[0]!;
    expect((await tournamentView(db, t.id, players[0]!.id)).tournament).toMatchObject({ serverReady: true, sessionName: session });
    expect(await slotFor(session).ensureOpen()).toEqual({ ok: true });

    const clients: Headless[] = [];
    for (const p of players) {
      const r = await connectTable({ kind: 'join', code: session }, { url: base, delay: (ms) => new Promise((res) => setTimeout(res, ms / SPEED)) });
      expect(r.ok, r.message).toBe(true);
      const h = headlessClient(r.conn!, { name: p.name, token: `tok-${p.name}`, playerId: p.name, coins: 10_000, speed: SPEED, ticket: () => p.token });
      h.panel.policy = gambler;
      h.game.start();
      clients.push(h);
    }

    await until(async () => (await tournamentView(db, t.id, null)).tournament.status === 'finished', 240_000, 'the tournament to finish');
    const done = (await tournamentView(db, t.id, null)).tournament;
    expect(done.status).toBe('finished');
    for (const h of clients) {
      h.game.stop();
      h.conn.close();
    }

    // Pool 2000 + 8 × 500 = 6000: 3600 to 1st, 2400 to 2nd, nothing to the rest; the host's 2000 is spent.
    const places = await db
      .prepare('SELECT player_id, place, prize FROM tournament_entries WHERE tournament_id = ?1 ORDER BY place')
      .bind(t.id)
      .all<{ player_id: string; place: number; prize: number }>();
    expect(places.results.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(places.results.map((r) => r.prize)).toEqual([3600, 2400, 0, 0, 0, 0, 0, 0]);
    expect((await balances(db, places.results[0]!.player_id)).coins).toBe(9500 + 3600);
    expect((await balances(db, places.results[1]!.player_id)).coins).toBe(9500 + 2400);
    expect((await balances(db, host.id)).coins).toBe(8000);
    const net = await db.prepare('SELECT sum(delta) AS s FROM ledger_entries WHERE ref = ?1').bind(t.id).first<{ s: number }>();
    expect(net?.s).toBe(0);
  }, 300_000);
});
