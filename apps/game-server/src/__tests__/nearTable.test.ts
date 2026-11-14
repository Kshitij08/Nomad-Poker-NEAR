/**
 * A NEAR money table end to end, in Node: the real TableSlot / TableHost / PokerServerGame and web client, the
 * NearChipLedger against an in-memory stand-in for the escrow contract (its get_seat / get_balance / cash_out rules),
 * players who signed in with NEAR in the D1 stand-in. Time runs SPEED× faster.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { PlayerAction } from '@nomad/engine/actions/actions';
import { verifyDeck, type DeckReveal } from '@nomad/engine/cards/deckCommitment';
import { createPlayer, createSession } from '@nomad/db/accounts';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { realClock } from '@nomad/table-server/clock';
import { connectTable } from '../../../web/src/net/matchmaking';
import { headlessClient, until, type Headless } from '../../../web/server/__tests__/headlessClient';
import { CHIP_YOCTO } from '../nearChipLedger';
import { canonicalSession } from '../roomSpec';
import { TableHost, type HostSocket } from '../tableHost';
import { TableSlot } from '../tableSlot';

const SPEED = 25;
const ROOM = 'poker-money-st50';
const quiet = (level: 'info' | 'warn' | 'error', m: string) => {
  if (level === 'error') console.error(m);
};

/** The escrow's table rules this server relies on (near/escrow/src/tables.rs). */
class FakeEscrow {
  seats = new Map<string, bigint>();
  balances = new Map<string, bigint>();
  lockedTotal = 0n;
  paidTotal = 0n;
  keys = new Set<string>();
  calls: string[] = [];
  tables = new Map<string, { config: { small_blind: number; big_blind: number }; closed: boolean }>();
  buyIn(player: string, chips: number) {
    const locked = BigInt(chips) * CHIP_YOCTO;
    this.seats.set(player, (this.seats.get(player) ?? 0n) + locked);
    this.lockedTotal += locked;
  }
  async view<T>(_c: string, method: string, a: Record<string, unknown>): Promise<T> {
    if (method === 'get_seat') {
      const l = this.seats.get(String(a.player));
      return (l === undefined ? null : { bought_in: String(l), locked: String(l) }) as T;
    }
    if (method === 'get_balance') return String(this.balances.get(String(a.account)) ?? 0n) as T;
    if (method === 'get_table') return (this.tables.get(String(a.table_id)) ?? null) as T;
    throw new Error('unknown view ' + method);
  }
  async call<T>(_c: string, method: string, a: Record<string, unknown>): Promise<T> {
    this.calls.push(`${method} ${a.player} ${a.amount}`);
    if (method !== 'cash_out') throw new Error('unknown call ' + method);
    const key = String(a.key);
    if (this.keys.has(key)) return false as T;
    const player = String(a.player);
    if (!this.seats.has(player)) throw new Error('Smart contract panicked: the player is not seated at this table');
    const amount = BigInt(String(a.amount));
    if (this.paidTotal + amount > this.lockedTotal) throw new Error('Smart contract panicked: the table would pay out more than it locked');
    this.seats.delete(player);
    this.paidTotal += amount;
    this.keys.add(key);
    this.balances.set(player, (this.balances.get(player) ?? 0n) + amount);
    return true as T;
  }
}

let db: D1Database;
let http: Server;
let base: string;
const escrow = new FakeEscrow();
const slots = new Map<string, TableSlot>();
const hosts: TableHost[] = [];

function slotFor(session: string): TableSlot {
  let slot = slots.get(session);
  if (!slot) {
    slot = new TableSlot({
      session,
      isSpawned: async () => false,
      qaRooms: false,
      nearTables: true,
      qaSpeed: 1,
      log: quiet,
      createHost: (spec) => {
        const host = new TableHost({ spec, db, clock: realClock(SPEED), log: quiet, stillSeatedElsewhere: async () => false, near: { operator: escrow, escrow: 'escrow.test' } });
        hosts.push(host);
        return host;
      },
    });
    slots.set(session, slot);
  }
  return slot;
}

beforeAll(async () => {
  db = await D1Shim.migrated();
  http = createServer((req, res) => {
    if (req.url?.startsWith('/v1/health')) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
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

async function nearAccount(name: string, near: string | null): Promise<{ id: string; token: string }> {
  const p = await createPlayer(db, { displayName: name, identity: near ? { provider: 'near', subject: near, label: near } : undefined });
  return { id: p.id, token: (await createSession(db, p.id)).token };
}

async function sit(name: string, acct: { token: string }, buyIn: number, room = ROOM): Promise<Headless> {
  const r = await connectTable({ kind: 'join', code: room }, { url: base, delay: (ms) => new Promise((res) => setTimeout(res, ms / SPEED)) });
  expect(r.ok, r.message).toBe(true);
  const h = headlessClient(r.conn!, { name, token: `tok-${name}`, playerId: name, coins: 0, speed: SPEED, buyIn, ticket: () => acct.token });
  h.panel.policy = (legal) => (legal.canCheck ? PlayerAction.check() : legal.canCall ? PlayerAction.call() : PlayerAction.fold());
  h.game.start();
  return h;
}

describe('game server: a NEAR money table', () => {
  let a: Headless;
  let b: Headless;

  it('refuses a player without a NEAR sign-in, or one asking for other chips than they locked', async () => {
    const guest = await nearAccount('Guest', null);
    const g = await sit('Guest', guest, 57);
    await new Promise((r) => setTimeout(r, 600));
    expect(g.game.localSeat).toBe(-1);
    g.game.stop();
    g.conn.close();

    const carol = await nearAccount('Carol', 'carol.testnet');
    escrow.buyIn('carol.testnet', 57);
    const c = await sit('Carol', carol, 120);
    await new Promise((r) => setTimeout(r, 600));
    expect(c.game.localSeat).toBe(-1);
    c.game.stop();
    c.conn.close();
    escrow.seats.delete('carol.testnet');
    escrow.lockedTotal -= 57n * CHIP_YOCTO;
  }, 20_000);

  it('seats two NEAR players with exactly their locked chips, no bots, and plays committed hands', async () => {
    const alice = await nearAccount('Alice', 'alice.testnet');
    const bob = await nearAccount('Bob', 'bob.testnet');
    escrow.buyIn('alice.testnet', 57);
    escrow.buyIn('bob.testnet', 190);
    a = await sit('Alice', alice, 57);
    b = await sit('Bob', bob, 190);
    await until(() => a.game.localSeat >= 0 && b.game.localSeat >= 0, 5000, 'both seated');
    const host = slots.get(ROOM)!.live as TableHost;
    expect(host.money).toBe(true);
    expect(host.game.tableId).toBe(ROOM);
    await until(() => a.game.handsSeen >= 8, 60_000, '8 hands');
    const seats = host.game.pokerEngine!.table!.seats.filter((s) => s.isOccupied);
    expect(seats.length).toBe(2);
    expect(seats.some((s) => s.isBot)).toBe(false);

    // Every settled hand's reveal checks out against its commitment.
    let checked = 0;
    for (let n = 1; n <= 8; n++) {
      const reveal = host.deckReveal(n) as DeckReveal | null;
      if (!reveal) continue;
      expect(reveal.tableId).toBe(ROOM);
      expect(verifyDeck(reveal).ok).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  }, 90_000);

  it('cashes both out through the escrow, paying back exactly what the table locked', async () => {
    for (const h of [a, b]) {
      h.game.requestLeaveTable();
      await until(() => h.game.localSeat < 0, 8000, 'left');
    }
    await until(() => escrow.seats.size === 0, 8000, 'cash-outs');
    expect(escrow.calls.filter((c) => c.startsWith('cash_out')).length).toBe(2);
    expect(escrow.paidTotal).toBe(escrow.lockedTotal);
    const alice = escrow.balances.get('alice.testnet')!;
    const bob = escrow.balances.get('bob.testnet')!;
    expect((alice + bob) / CHIP_YOCTO).toBe(247n);
    for (const h of [a, b]) {
      h.game.stop();
      h.conn.close();
    }
  }, 30_000);

  it("opens a hosted table only once the escrow has it with the stake's blinds", async () => {
    const HOSTED = 'poker-money-st100-habcd1234';
    const dan = await nearAccount('Dan', 'dan.testnet');
    escrow.buyIn('dan.testnet', 100);
    const tryIt = async (stay = false) => {
      const d = await sit('Dan', dan, 100, HOSTED);
      await new Promise((r) => setTimeout(r, 600));
      const seat = d.game.localSeat;
      if (!stay) {
        d.game.stop();
        d.conn.close();
      }
      return { seat, d };
    };
    expect((await tryIt()).seat).toBe(-1); // not on the escrow
    escrow.tables.set(HOSTED, { config: { small_blind: 1, big_blind: 2 }, closed: false });
    expect((await tryIt()).seat).toBe(-1); // wrong blinds for st100 (2/5)
    escrow.tables.set(HOSTED, { config: { small_blind: 2, big_blind: 5 }, closed: false });
    const ok = await tryIt(true);
    expect(ok.seat).toBeGreaterThanOrEqual(0);
    ok.d.game.requestLeaveTable();
    await until(() => !escrow.seats.has('dan.testnet'), 8000, 'Dan cashed out');
    expect(escrow.balances.get('dan.testnet')).toBe(100n * CHIP_YOCTO);
    ok.d.game.stop();
    ok.d.conn.close();
  }, 30_000);
});
