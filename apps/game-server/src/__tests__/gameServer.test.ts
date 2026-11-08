/**
 * The game server end to end, in Node: a stand-in for the Worker (HTTP + WebSocket routes) in front of the real
 * TableSlot / TableHost per session, the real PokerServerGame, chips on the real ledger SQL (node:sqlite D1 stand-in),
 * hand batches to an in-memory R2, and the real web client (ClientGame + NetConnection in game-server mode).
 * Time runs SPEED× faster on both sides.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { PlayerAction } from '@nomad/engine/actions/actions';
import { createPlayer, createSession } from '@nomad/db/accounts';
import { balances, entries } from '@nomad/db/ledger';
import { snapshot } from '@nomad/db/progress';
import { auditTable, buyIn, seatLock } from '@nomad/db/seatLocks';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { realClock } from '@nomad/table-server/clock';
import { StakeSessionNames } from '@nomad/table-server/sessions';
import { connectTable } from '../../../web/src/net/matchmaking';
import { headlessClient, until, type Headless } from '../../../web/server/__tests__/headlessClient';
import { gunzip, HandRecorder, type RecordedHand } from '../handRecorder';
import { canonicalSession } from '../roomSpec';
import { TableHost, type HostSocket } from '../tableHost';
import { TableSlot } from '../tableSlot';

const SPEED = 25;
const quiet = (level: 'info' | 'warn' | 'error', m: string) => {
  if (level === 'error') console.error(m);
};

let db: D1Database;
let http: Server;
let base: string;
const slots = new Map<string, TableSlot>();
const spawned = new Set<string>();
const r2 = new Map<string, Uint8Array>();
const hosts: TableHost[] = [];

function slotFor(session: string): TableSlot {
  let slot = slots.get(session);
  if (!slot) {
    slot = new TableSlot({
      session,
      isSpawned: async () => spawned.has(session),
      qaRooms: true,
      qaSpeed: 1,
      log: quiet,
      createHost: (spec) => {
        const host = new TableHost({
          spec,
          db,
          clock: realClock(SPEED),
          log: quiet,
          recorder: new HandRecorder(session, async (key, body) => void r2.set(key, body), quiet, 10),
          stillSeatedElsewhere: async (lock) => slots.get(lock.room)?.holds(lock.player_id, lock.table_id) ?? false,
        });
        hosts.push(host);
        return host;
      },
    });
    slots.set(session, slot);
  }
  return slot;
}

/** The Worker's routes (src/index.ts), over Node's http + ws. */
beforeAll(async () => {
  db = await D1Shim.migrated();
  http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const body = async () => {
      let s = '';
      for await (const c of req) s += c;
      return JSON.parse(s || '{}');
    };
    if (url.pathname === '/v1/health') return send({ ok: true });
    if (url.pathname === '/v1/tables/spawn') {
      const b = await body();
      spawned.add(String(b.code).toUpperCase());
      return send({ code: String(b.code).toUpperCase() });
    }
    if (url.pathname === '/v1/tables/overflow') {
      const b = await body();
      for (let n = 2; n < 20; n++) {
        const name = StakeSessionNames.overflow(false, Number(b.minBuyIn) || 1000, n);
        if (!slotFor(name).occupancy().full) return send({ session: name });
      }
      return send({ error: 'full' });
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

async function account(name: string): Promise<{ id: string; token: string }> {
  const p = await createPlayer(db, { displayName: name });
  return { id: p.id, token: (await createSession(db, p.id)).token };
}

async function player(name: string, acct: { token: string }, route: Parameters<typeof connectTable>[0] = { kind: 'quick', minBuyIn: 1000 }): Promise<Headless> {
  const r = await connectTable(route, { url: base, coins: 10_000, delay: (ms) => new Promise((res) => setTimeout(res, ms / SPEED)) });
  expect(r.ok, r.message).toBe(true);
  expect(r.conn!.isCloud).toBe(true);
  const h = headlessClient(r.conn!, { name, token: `tok-${name}`, playerId: name, coins: 10_000, speed: SPEED, buyIn: 2000, ticket: () => acct.token });
  // Check or fold: stays seated for the whole run (a busted seat is released).
  h.panel.policy = (legal) => (legal.canCheck ? PlayerAction.check() : PlayerAction.fold());
  h.game.start();
  return h;
}

async function leave(h: Headless, playerId: string): Promise<void> {
  h.game.requestLeaveTable();
  await until(() => h.game.localSeat < 0, 5000, 'seat released');
  for (let i = 0; i < 400 && (await seatLock(db, playerId)); i++) await new Promise((r) => setTimeout(r, 50));
  expect(await seatLock(db, playerId)).toBeNull();
  h.game.stop();
  h.conn.close();
}

describe('game server: Quick Play on the ledger', () => {
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let a: Headless;
  let b: Headless;
  let tableId: string;

  it('seats two signed-in players with bots, debiting each buy-in on the ledger', async () => {
    alice = await account('Alice');
    bob = await account('Bob');
    a = await player('Alice', alice);
    await until(() => a.game.localSeat >= 0, 5000, 'Alice seat');
    b = await player('Bob', bob);
    await until(() => b.game.localSeat >= 0, 5000, 'Bob seat');
    expect(a.conn.session).toBe('poker-free');
    expect(b.conn.session).toBe('poker-free');
    tableId = (slots.get('poker-free')!.live as TableHost).game.tableId!;
    expect(await seatLock(db, alice.id)).toMatchObject({ table_id: tableId, buy_in: 2000, room: 'poker-free' });
    expect((await balances(db, alice.id)).coins).toBe(8000);
    await until(() => a.wallet.coins === 8000, 5000, 'balance pushed to the client');
  });

  it('plays hands with zero ledger drift and records them to R2', async () => {
    await until(() => a.game.handsSeen >= 25 && b.game.handsSeen >= 25, 120_000, '25 hands');
    expect(a.game.sequenceErrors + b.game.sequenceErrors).toBe(0);
    await leave(a, alice.id);
    await leave(b, bob.id);
    await (slots.get('poker-free')!.live as TableHost).settled();
    const audit = (await auditTable(db, tableId))!;
    expect(audit.hands).toBeGreaterThanOrEqual(25);
    expect(audit.seatedPlayers).toBe(0);
    expect(audit.drift).toBe(0);
    // My Twin / the coach: every decision and hand outcome of the signed-in players was recorded (bots' were not).
    const d = await db.prepare('SELECT count(*) AS n, count(DISTINCT player_id) AS p, min(strength) AS lo, max(strength) AS hi FROM style_decisions').first<{ n: number; p: number; lo: number; hi: number }>();
    expect(d!.n).toBeGreaterThan(20);
    expect(d!.p).toBe(2);
    expect(d!.lo).toBeGreaterThanOrEqual(0);
    expect(d!.hi).toBeLessThanOrEqual(1);
    const sh = await db.prepare('SELECT count(*) AS n FROM style_hands WHERE player_id = ?1').bind(alice.id).first<{ n: number }>();
    expect(sh!.n).toBeGreaterThanOrEqual(25);
    // Each player's coins: the starter grant, the table's buy-in and cash-out, and level-up rewards the server paid
    // for XP it counted from the hands (10 per hand dealt in, 25 more per pot won).
    for (const p of [alice, bob]) {
      const e = (await entries(db, p.id, { limit: 200 })).entries;
      const coinsBy = (reason: string) => e.filter((x) => x.currency === 'coins' && x.reason === reason).reduce((sum, x) => sum + x.delta, 0);
      expect(coinsBy('table:buy_in')).toBe(-2000);
      expect((await balances(db, p.id)).coins).toBe(10_000 - 2000 + coinsBy('table:cash_out') + coinsBy('level_up'));
      const xpEntries = e.filter((x) => x.currency === 'xp');
      expect(xpEntries.length).toBeGreaterThanOrEqual(20);
      expect(xpEntries.every((x) => x.delta === 10 || x.delta === 35)).toBe(true);
      const snap = await snapshot(db, p.id);
      expect(snap.balances.xp).toBe(xpEntries.reduce((sum, x) => sum + x.delta, 0));
      expect(snap.missions.slots.find((x) => x.id === 'daily_warmup_10')?.progress).toBe(10);
      expect(snap.missions.slots.find((x) => x.id === 'daily_table_tour_2')?.progress).toBe(1);
      expect(snap.rewardedLevel).toBe(snap.level);
    }
    // Hand batches: gzipped JSON lines, one per settled hand, with the events that were sent.
    await slots.get('poker-free')!.live!.close('test');
    const hands: RecordedHand[] = [];
    for (const [key, body] of r2) if (key.includes(`/poker-free/${tableId}/`)) hands.push(...(await gunzip(body)).trim().split('\n').map((l) => JSON.parse(l) as RecordedHand));
    expect(hands.length).toBe(audit.hands);
    expect(hands.every((h) => h.events.length > 0 && h.stacks.length > 0)).toBe(true);
    expect(hands.reduce((s, h) => s + h.botDelta, 0)).toBe(audit.botNet);
  }, 180_000);

  it('lets a player with a bad ticket only spectate', async () => {
    const r = await connectTable({ kind: 'join', code: 'qa-spectate' }, { url: base });
    expect(r.ok).toBe(true);
    const h = headlessClient(r.conn!, { name: 'Eve', token: 'tok-Eve', playerId: 'Eve', coins: 10_000, speed: SPEED, ticket: () => 'np_not-a-session' });
    h.game.start();
    await new Promise((res) => setTimeout(res, 500));
    expect(h.game.localSeat).toBe(-1);
    h.game.stop();
    h.conn.close();
  });

  it('refuses a second seat while the first table still holds one', async () => {
    const carol = await account('Carol');
    const c1 = await player('Carol', carol, { kind: 'join', code: 'qa-first' });
    await until(() => c1.game.localSeat >= 0, 5000, 'Carol seat');
    const r = await connectTable({ kind: 'join', code: 'qa-second' }, { url: base });
    const c2 = headlessClient(r.conn!, { name: 'Carol', token: 'tok-Carol-2', playerId: 'Carol', coins: 10_000, speed: SPEED, ticket: () => carol.token });
    c2.game.start();
    await new Promise((res) => setTimeout(res, 600));
    expect(c2.game.localSeat).toBe(-1);
    expect((await seatLock(db, carol.id))?.room).toBe('qa-first');
    expect((await balances(db, carol.id)).coins).toBe(8000);
    c2.game.stop();
    c2.conn.close();
    await leave(c1, carol.id);
  }, 30_000);

  it('pays back a stack stranded by a table that is gone, at the next sit-down', async () => {
    const dave = await account('Dave');
    // A table that no longer exists (redeploy, eviction) left Dave's lock behind at its last checkpoint.
    await buyIn(db, { playerId: dave.id, tableId: 't-gone', room: 'poker-free-st50', seat: 3, chips: 1500 });
    await db.prepare('UPDATE seat_locks SET stack = 1750 WHERE player_id = ?1').bind(dave.id).run();
    const d = await player('Dave', dave, { kind: 'join', code: 'qa-recover' });
    await until(() => d.game.localSeat >= 0, 5000, 'Dave seat');
    const e = (await entries(db, dave.id, { limit: 10 })).entries.map((x) => [x.reason, x.delta]);
    expect(e).toEqual([
      ['table:buy_in', -2000],
      ['table:recovered', 1750],
      ['table:buy_in', -1500],
      ['starter', 10_000],
    ]);
    await leave(d, dave.id);
  }, 30_000);

  it('removes a player whose account is suspended while seated, paying their stack back', async () => {
    const carol = await account('Carol');
    const c = await player('Carol', carol, { kind: 'quick', minBuyIn: 100 });
    await until(() => c.game.localSeat >= 0 && c.game.handsSeen >= 1, 20_000, 'Carol seated and playing');
    expect(await seatLock(db, carol.id)).not.toBeNull();
    await db.prepare('UPDATE players SET banned_at = ?2 WHERE id = ?1').bind(carol.id, Date.now()).run();
    await until(() => c.game.localSeat < 0, 20_000, 'Carol removed');
    for (let i = 0; i < 400 && (await seatLock(db, carol.id)); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await seatLock(db, carol.id)).toBeNull();
    const coins = (await balances(db, carol.id)).coins;
    expect(coins).toBeGreaterThan(9000); // the stack came back (minus what the hands cost)
    c.game.stop();
    c.conn.close();
  });

  it('spawns party rooms over HTTP and refuses codes nobody spawned', async () => {
    const created = await connectTable({ kind: 'create' }, { url: base });
    expect(created.ok, created.message).toBe(true);
    expect(created.session).toMatch(/^[A-Z1-9]{8}$/);
    created.conn!.close();
    const missing = await connectTable({ kind: 'join', code: 'ZZZZZZZZ' }, { url: base, delay: async () => {} });
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('was not found');
  });
});
