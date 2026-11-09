/**
 * SOL tables (Phase 6) end to end in Node: the real TableSlot / TableHost / PokerServerGame and web client, with the
 * escrow program replaced by a stand-in that enforces its rules (rounds, nonces, zero-sum settlements, pending
 * buy-ins, no cash-out while a round is open). The real program is exercised on devnet by scripts/escrow-check.ts.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { PlayerAction } from '@nomad/engine/actions/actions';
import { EscrowError } from '@nomad/chain/accounts';
import { EscrowTxError, type EscrowClient } from '@nomad/chain/escrowClient';
import { createPlayer, createSession } from '@nomad/db/accounts';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { realClock } from '@nomad/table-server/clock';
import { connectTable } from '../../../web/src/net/matchmaking';
import { headlessClient, until, type Headless } from '../../../web/server/__tests__/headlessClient';
import { canonicalSession, roomSpecFor } from '../roomSpec';
import { TableHost, type HostSocket } from '../tableHost';
import { TableSlot } from '../tableSlot';
import { sweepEscrowTables } from '../escrowTable';
import { recordEscrowTable, setEscrowTableState } from '@nomad/db/escrowTables';

const SPEED = 25;
const logs: string[] = [];
const log = (level: 'info' | 'warn' | 'error', m: string) => {
  logs.push(`${level} ${m}`);
  if (level === 'error') console.error(m);
};

interface FakeSeat {
  chips: number;
  pending: number;
}
interface FakeTable {
  buyIn: bigint;
  roundActive: boolean;
  nonce: bigint;
  seats: Map<string, FakeSeat>;
  closed: boolean;
}

/** The poker-escrow program's rules, in memory, behind EscrowClient's surface. */
class FakeChain {
  readonly authority = 'FakeAuthority1111111111111111111111111111111';
  readonly programId = 'GdduGzsoiEamv285Z4DnBapmkMScnHLDdUAdWPywHozo';
  readonly tables = new Map<string, FakeTable>();
  readonly paid = new Map<string, number>();
  readonly calls: string[] = [];
  settlements = 0;
  failNextSettles = 0;

  private t(id: string): FakeTable {
    const t = this.tables.get(id);
    if (!t || t.closed) throw new EscrowTxError(`table ${id} not on chain`, null);
    return t;
  }
  async createTable(id: string, buyIn: bigint): Promise<string> {
    this.calls.push(`create ${id}`);
    this.tables.set(id, { buyIn, roundActive: false, nonce: 0n, seats: new Map(), closed: false });
    return 'sig';
  }
  /** The player's own buy_in / rebuy (their wallet signs it): pending while a round is open. */
  buyIn(id: string, wallet: string, chips: number): void {
    const t = this.t(id);
    const s = t.seats.get(wallet) ?? { chips: 0, pending: 0 };
    if (t.roundActive) s.pending += chips;
    else s.chips += chips;
    t.seats.set(wallet, s);
  }
  async beginRound(id: string): Promise<'begun' | 'already'> {
    const t = this.t(id);
    this.calls.push(`begin ${t.nonce}`);
    if (t.roundActive) return 'already';
    t.roundActive = true;
    return 'begun';
  }
  async table(id: string) {
    const t = this.tables.get(id);
    if (!t || t.closed) return null;
    let pending = 0n;
    let chips = 0n;
    for (const s of t.seats.values()) {
      pending += BigInt(s.pending);
      chips += BigInt(s.chips);
    }
    return { roundActive: t.roundActive, roundNonce: t.nonce, pendingChipsInPlay: pending, chipsInPlay: chips, seatedCount: t.seats.size };
  }
  async seat(id: string, wallet: string) {
    const s = this.tables.get(id)?.seats.get(wallet);
    return s ? { player: wallet, chips: BigInt(s.chips), pendingChips: BigInt(s.pending) } : null;
  }
  async seatsFor(id: string, wallets: string[]) {
    return (await this.seatsOf(id)).filter((s) => wallets.includes(s.player));
  }
  async seatsOf(id: string) {
    return [...(this.tables.get(id)?.seats ?? new Map<string, FakeSeat>())].map(([player, s]) => ({ player, chips: BigInt(s.chips), pendingChips: BigInt(s.pending) }));
  }
  async settleRound(id: string, deltas: { player: string; chipDelta: number }[], expected?: bigint): Promise<bigint | null> {
    const t = this.t(id);
    if (this.failNextSettles > 0) {
      this.failNextSettles--;
      throw new EscrowTxError('settle_round: RPC timed out', null);
    }
    if (expected !== undefined && t.nonce !== expected) {
      if (t.nonce > expected && !t.roundActive) return null;
      throw new EscrowTxError('stale', EscrowError.StaleSettlement);
    }
    if (deltas.reduce((a, d) => a + d.chipDelta, 0) !== 0) throw new EscrowTxError('not zero-sum', EscrowError.SettlementNotZeroSum);
    for (const s of t.seats.values()) {
      s.chips += s.pending; // EscrowClient lists every pending seat, so the program applies them all
      s.pending = 0;
    }
    for (const d of deltas) {
      const s = t.seats.get(d.player);
      if (!s) throw new EscrowTxError(`no seat for ${d.player}`, EscrowError.SeatNotInSettlement);
      if (s.chips + d.chipDelta < 0) throw new EscrowTxError('underflow', 6006);
      s.chips += d.chipDelta;
    }
    this.calls.push(`settle ${t.nonce}`);
    t.nonce++;
    t.roundActive = false;
    this.settlements++;
    return t.nonce - 1n;
  }
  async cashOut(id: string, wallet: string) {
    const t = this.tables.get(id);
    const s = t?.seats.get(wallet);
    if (!t || !s) return null; // as EscrowClient: no seat account, nothing to pay
    if (t.roundActive) throw new EscrowTxError('round in progress', EscrowError.RoundInProgress);
    t.seats.delete(wallet);
    this.paid.set(wallet, (this.paid.get(wallet) ?? 0) + s.chips + s.pending);
    this.calls.push(`cashout ${wallet}`);
    return { signature: 'sig', chips: BigInt(s.chips + s.pending) };
  }
  async closeTable(id: string): Promise<string> {
    const t = this.t(id);
    if (t.seats.size > 0) throw new EscrowTxError('not empty', EscrowError.TableNotEmpty);
    if (t.roundActive) throw new EscrowTxError('round open', EscrowError.RoundInProgress);
    t.closed = true;
    this.calls.push(`close ${id}`);
    return 'sig';
  }
}

let db: D1Database;
let http: Server;
let base: string;
const chain = new FakeChain();
const slots = new Map<string, TableSlot>();

function slotFor(session: string): TableSlot {
  let slot = slots.get(session);
  if (!slot) {
    slot = new TableSlot({
      session,
      isSpawned: async () => false,
      qaRooms: true,
      moneyTables: true,
      qaSpeed: 1,
      log,
      createHost: (spec) =>
        new TableHost({
          spec,
          escrow: spec.properties.mode === 'chain' ? (chain as unknown as EscrowClient) : undefined,
          db,
          clock: realClock(SPEED),
          log,
          stillSeatedElsewhere: async () => false,
        }),
    });
    slots.set(session, slot);
  }
  return slot;
}

beforeAll(async () => {
  db = await D1Shim.migrated();
  http = createServer((req, res) => {
    if (req.url?.startsWith('/v1/health')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
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
  for (const s of slots.values()) await s.live?.close('test over');
  http.closeAllConnections();
  await new Promise<void>((r) => http.close(() => r()));
}, 30_000);

async function walletAccount(name: string): Promise<{ id: string; token: string; wallet: string }> {
  const wallet = `${name}Wallet`.padEnd(44, '1');
  const p = await createPlayer(db, { displayName: name, identity: { provider: 'wallet', subject: wallet, label: wallet } });
  return { id: p.id, token: (await createSession(db, p.id)).token, wallet };
}

async function join(name: string, acct: { token: string }): Promise<Headless> {
  const r = await connectTable({ kind: 'join', code: 'poker-money' }, { url: base, delay: (ms) => new Promise((res) => setTimeout(res, ms / SPEED)) });
  expect(r.ok, r.message).toBe(true);
  const h = headlessClient(r.conn!, { name, token: `tok-${name}`, playerId: name, coins: 0, speed: SPEED, ticket: () => acct.token });
  h.panel.policy = (legal) => (legal.canCheck ? PlayerAction.check() : PlayerAction.call());
  h.game.start();
  return h;
}

const host = () => slots.get('poker-money')!.live as TableHost;

describe('SOL tables on the escrow', () => {
  it('the room only exists where SOL tables are switched on, and plays without bots', () => {
    expect(roomSpecFor('poker-money', { spawned: false, qaRooms: true }).ok).toBe(false);
    const spec = roomSpecFor('poker-money-st1000', { spawned: false, qaRooms: true, moneyTables: true });
    expect(spec.ok && spec.spec.properties).toMatchObject({ kind: 'quick', mode: 'chain', stake: '1000' });
  });

  let alice: Awaited<ReturnType<typeof walletAccount>>;
  let bob: Awaited<ReturnType<typeof walletAccount>>;
  let a: Headless;
  let b: Headless;
  let tableId: string;

  it('a player with no seat on chain watches; after their wallet buys in, they sit with the chain\'s chips', async () => {
    alice = await walletAccount('Alice');
    bob = await walletAccount('Bob');
    a = await join('Alice', alice);
    await until(() => !!slots.get('poker-money')?.live, 5000, 'room open');
    tableId = host().escrow!.tableId;
    expect(await host().escrow!.ready).toBe(true);
    expect(chain.calls[0]).toBe(`create ${tableId}`);
    await new Promise((r) => setTimeout(r, 300));
    expect(a.game.localSeat).toBe(-1); // no seat on chain yet
    expect(logs.some((l) => l.includes('could not buy in: Buy in with your wallet first.'))).toBe(true);

    chain.buyIn(tableId, alice.wallet, 1000);
    a.game.requestBuyIn();
    await until(() => a.game.localSeat >= 0, 5000, 'Alice seated');

    chain.buyIn(tableId, bob.wallet, 1000);
    b = await join('Bob', bob);
    await until(() => b.game.localSeat >= 0, 5000, 'Bob seated');
    expect(host().game.pokerEngine.table.seats.filter((s) => s.isOccupied && s.isBot)).toHaveLength(0);
  });

  it('opens a round before every deal and settles it after, chips staying equal on chain and at the table', async () => {
    await until(() => chain.settlements >= 6, 60_000, '6 settled hands');
    // A buy-in while a round is open lands as pending; the next settlement moves it into play.
    await until(() => chain.tables.get(tableId)!.roundActive, 10_000, 'a round open');
    const carol = 'CarolWallet'.padEnd(44, '1');
    chain.buyIn(tableId, carol, 500);
    expect(chain.tables.get(tableId)!.seats.get(carol)).toEqual({ chips: 0, pending: 500 });
    const before = chain.settlements;
    await until(() => chain.settlements > before, 20_000, 'the next settlement');
    expect(chain.tables.get(tableId)!.seats.get(carol)).toEqual({ chips: 500, pending: 0 });

    // Every hand: begin then settle, nonces in order, never two rounds at once.
    const roundCalls = chain.calls.filter((c) => /^(begin|settle) /.test(c));
    for (let i = 0; i + 1 < roundCalls.length; i += 2) {
      expect(roundCalls[i]).toBe(`begin ${i / 2}`);
      expect(roundCalls[i + 1]).toBe(`settle ${i / 2}`);
    }
    // Alice + Bob's chips are conserved on chain.
    const seats = chain.tables.get(tableId)!.seats;
    expect(seats.get(alice.wallet)!.chips + seats.get(bob.wallet)!.chips).toBe(2000);
  }, 90_000);

  it('rides out a settlement that fails twice', async () => {
    const before = chain.settlements;
    chain.failNextSettles = 2;
    await until(() => chain.settlements > before + 1, 40_000, 'settlements after the failures');
    expect(host().game.tableId).toBe(tableId);
    expect(logs.filter((l) => l.includes('settle_round attempt')).length).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.includes('HALTED'))).toBe(false);
  }, 60_000);

  it('a player who leaves is paid their seat at the hand boundary; closing pays everyone left and closes the table', async () => {
    const aliceChips = () => chain.tables.get(tableId)!.seats.get(alice.wallet)?.chips;
    a.game.requestLeaveTable();
    await until(() => chain.paid.has(alice.wallet), 20_000, 'Alice paid');
    expect(chain.tables.get(tableId)!.seats.has(alice.wallet)).toBe(false);
    expect(aliceChips()).toBeUndefined();
    const bobAtTable = () => host().game.pokerEngine.table.seats.find((s) => s.isOccupied)?.stack ?? 0;
    expect(chain.paid.get(alice.wallet)! + bobAtTable()).toBe(2000);

    await host().close('test');
    expect(chain.paid.get(alice.wallet)! + chain.paid.get(bob.wallet)!).toBe(2000);
    expect(chain.paid.get('CarolWallet'.padEnd(44, '1'))).toBe(500); // bought in, never sat: refunded at close
    expect(chain.tables.get(tableId)!.closed).toBe(true);
    const row = await db.prepare('SELECT state, hands FROM escrow_tables WHERE table_id = ?1').bind(tableId).first<{ state: string; hands: number }>();
    expect(row!.state).toBe('closed');
    expect(row!.hands).toBe(chain.settlements);
    // No Coins bookkeeping for a SOL table.
    expect(await db.prepare('SELECT count(*) AS n FROM table_sessions WHERE id = ?1').bind(tableId).first<{ n: number }>()).toEqual({ n: 0 });
    expect(logs.filter((l) => l.startsWith('error'))).toEqual([]);
    for (const h of [a, b]) {
      h.game.stop();
      h.conn.close();
    }
  }, 60_000);

  it('the cron sweep pays out and closes a table its room left behind, and leaves a running one alone', async () => {
    const left = 't-left-behind';
    const running = 't-still-running';
    for (const id of [left, running]) {
      await recordEscrowTable(db, { tableId: id, room: `poker-money-${id}`, authority: chain.authority, buyInLamports: 100_000_000 });
      await setEscrowTableState(db, id, 'open', null, Date.now() - 10 * 60_000);
      await chain.createTable(id, 100_000_000n);
    }
    chain.buyIn(left, 'DanWallet'.padEnd(44, '1'), 1000);
    chain.buyIn(left, 'EveWallet'.padEnd(44, '1'), 1000);
    await chain.beginRound(left); // a hand was running when the room went away
    chain.buyIn(left, 'FayWallet'.padEnd(44, '1'), 300); // pending, never sat
    const hosts = async (_room: string, id: string) => id === running;
    // Two sweeps at once (the cron minute and the admin route): only one takes the table.
    const [x, y] = await Promise.all([sweepEscrowTables(db, chain as unknown as EscrowClient, log, hosts), sweepEscrowTables(db, chain as unknown as EscrowClient, log, hosts)]);
    expect(x + y).toBe(1);
    expect(chain.tables.get(left)!.closed).toBe(true);
    expect(chain.paid.get('DanWallet'.padEnd(44, '1'))).toBe(1000);
    expect(chain.paid.get('FayWallet'.padEnd(44, '1'))).toBe(300);
    expect(chain.tables.get(running)!.closed).toBe(false);
    const states = (await db.prepare('SELECT table_id, state FROM escrow_tables WHERE table_id IN (?1, ?2) ORDER BY table_id').bind(left, running).all<{ table_id: string; state: string }>()).results;
    expect(states).toEqual([{ table_id: left, state: 'closed' }, { table_id: running, state: 'open' }]);
  });
});
