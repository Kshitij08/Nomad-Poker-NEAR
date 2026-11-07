/**
 * Multi-client tests against the real local table server: headless ClientGames (the port of PokerClientGame) over
 * real WebSockets, a real PokerServerGame per room, the shared rules engine and the offline chip ledger. Time runs
 * SPEED× faster on both sides.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlayerAction } from '../../src/core/actions/actions';
import { TablePhase } from '../../src/core/events/pokerEvent';
import { connectTable } from '../../src/net/matchmaking';
import { NetConnection } from '../../src/net/netConnection';
import { TableChat } from '../../src/net/tableChat';
import { startPokerServer, type PokerServer } from '../src/server';
import { headlessClient, until, type Headless } from './headlessClient';

const SPEED = 25;
let server: PokerServer;
const quiet = (level: 'info' | 'warn' | 'error', m: string) => {
  if (level === 'error') console.error(m);
};

beforeAll(async () => {
  server = await startPokerServer({ port: 0, speed: SPEED, log: quiet });
});

afterAll(async () => {
  await server?.close();
});

async function quickPlayer(name: string, coins = 20000, minBuyIn = 1000, buyIn = 5000): Promise<Headless> {
  const r = await connectTable({ kind: 'quick', minBuyIn }, { url: server.url, coins, delay: (ms) => new Promise((res) => setTimeout(res, ms / SPEED)) });
  expect(r.ok, r.message).toBe(true);
  const h = headlessClient(r.conn!, { name, token: `tok-${name}`, playerId: `pid-${name}`, coins, speed: SPEED, buyIn });
  // Check or fold: these players must not bust out mid-suite (a busted seat is released, lock and all).
  h.panel.policy = (legal) => (legal.canCheck ? PlayerAction.check() : PlayerAction.fold());
  h.game.start();
  return h;
}

describe('local table server — Quick Play', () => {
  let a: Headless;
  let b: Headless;

  it('seats two players at the same pool table with filler bots and deals hands', async () => {
    a = await quickPlayer('Alice');
    await until(() => a.game.localSeat >= 0, 5000, 'Alice seat');
    expect(a.conn.session).toBe('poker-free');
    // A lone principal gets the Quick Play filler pack.
    await until(() => (a.game.roster ?? []).filter((s) => s.isOccupied).length >= 2, 5000, 'filler bots');

    b = await quickPlayer('Bob');
    await until(() => b.game.localSeat >= 0, 5000, 'Bob seat');
    expect(b.conn.session).toBe('poker-free');
    expect(b.game.localSeat).not.toBe(a.game.localSeat);

    // Both are dealt in and play several hands together.
    await until(() => a.game.handsSeen >= 3 && b.game.handsSeen >= 3, 60000, 'three hands');
    expect(a.game.sequenceErrors).toBe(0);
    expect(b.game.sequenceErrors).toBe(0);
    expect(a.game.lobby?.phase).toBe(TablePhase.Playing);
    expect(a.game.lobby?.autoStart).toBe(true);
  }, 90000);

  it('shows each player only their own hole cards', async () => {
    // Wait for a hand where both are dealt.
    await until(() => a.view.holeCards.has(a.game.localSeat) && b.view.holeCards.has(b.game.localSeat) && a.view.holeCards.has(b.game.localSeat), 30000, 'a dealt hand');
    const mineA = a.view.holeCards.get(a.game.localSeat)!;
    const bobOnA = a.view.holeCards.get(b.game.localSeat)!;
    const mineB = b.view.holeCards.get(b.game.localSeat)!;
    expect(mineA).not.toBe('??');
    expect(mineB).not.toBe('??');
    // Bob's cards on Alice's screen are face down unless a showdown just revealed them.
    if (bobOnA !== '??') expect(bobOnA).toBe(mineB);
  }, 40000);

  it('rotates the table so each player sits at the local HUD', () => {
    expect(a.view.perspective).toEqual({ localSeat: a.game.localSeat, localSlot: 0 });
    expect(b.view.perspective).toEqual({ localSeat: b.game.localSeat, localSlot: 0 });
  });

  it('debits the buy-in through the chip ledger and pushes the balance', async () => {
    const title = server.economy.title.state.players['pid-Alice']!;
    expect(title.objects['SeatLock']).toBeTruthy();
    await until(() => a.wallet.coins === title.chips, 5000, 'wallet balance push');
    expect(title.chips).toBe(20000 - 5000);
  });

  it('relays reactions over the sender seat (attributed by the server)', async () => {
    expect(a.game.sendReaction(5)).toBe(true);
    await until(() => b.view.seats[a.game.localSeat]!.reaction === 5, 5000, 'reaction');
  });

  it('relays table chat to the other players only', async () => {
    const chatA = new TableChat(a.conn, 'ua', () => 'Alice');
    const chatB = new TableChat(b.conn, 'ub', () => 'Bob');
    chatA.join(a.conn.session!, 'in');
    chatB.join(b.conn.session!, 'in');
    expect(chatA.send('  gl   hf  ')).toBe(true);
    await until(() => chatB.log.length === 1, 5000, 'chat line');
    expect(chatB.log[0]).toMatchObject({ name: 'Alice', body: 'gl hf', isLocal: false });
    expect(chatA.log[0]).toMatchObject({ body: 'gl hf', isLocal: true });
    expect(chatA.send('gl hf')).toBe(false); // duplicate inside 10 s
  });

  it('keeps a dropped player\'s seat and stack for the reconnect', async () => {
    const seat = b.game.localSeat;
    b.game.stop();
    b.conn.close();
    await until(() => (a.game.roster?.[seat]?.isLeaving ?? false), 5000, 'leaving mark');
    // Back inside the grace (5 s on a dedicated server = 200 ms at 25×): same seat, stack intact.
    const r = await connectTable({ kind: 'quick', minBuyIn: 1000 }, { url: server.url });
    expect(r.ok).toBe(true);
    const b2 = headlessClient(r.conn!, { name: 'Bob', token: 'tok-Bob', playerId: 'pid-Bob', coins: b.wallet.coins, speed: SPEED });
    b2.game.start();
    await until(() => b2.game.localSeat >= 0, 5000, 'Bob back');
    expect(b2.game.localSeat).toBe(seat);
    b = b2;
  }, 20000);

  it('cashes the stack out when a player leaves the table', async () => {
    const title = server.economy.title.state.players['pid-Bob']!;
    b.game.requestLeaveTable();
    await until(() => b.game.localSeat < 0, 5000, 'seat released');
    await until(() => !title.objects['SeatLock'], 30000, 'cash-out at the boundary');
    await until(() => b.wallet.coins === title.chips, 5000, 'balance pushed');
    expect(title.chips).toBeGreaterThan(0);
    b.game.stop();
    b.conn.close();
  }, 40000);

  it('overflows to another table when the pool is full', async () => {
    // Fill poker-free to its 8 connections with spectating sockets.
    const fillers: NetConnection[] = [];
    const room = server.registry.rooms.get('poker-free')!;
    while (!room.isFull) {
      const c = new NetConnection(server.url);
      const r = await c.join('poker-free');
      expect(r.ok).toBe(true);
      fillers.push(c);
    }
    const r = await connectTable({ kind: 'quick', minBuyIn: 1000 }, { url: server.url, delay: (ms) => new Promise((res) => setTimeout(res, ms / SPEED)) });
    expect(r.ok, r.message).toBe(true);
    expect(r.session).toBe('poker-free-2');
    r.conn!.close();
    for (const c of fillers) c.close();
  }, 20000);

  afterAll(() => {
    a?.game.stop();
    a?.conn.close();
  });
});

describe('local table server — leaving on purpose', () => {
  it('keeps the browser wallet and the ledger in step when the socket closes right after Leave', async () => {
    const d = await quickPlayer('Dave', 3000, 100, 500);
    await until(() => d.game.localSeat >= 0 && d.game.handsSeen >= 1, 20000, 'Dave dealt in');
    // NetTableSession.stop(): optimistic credit, leave RPC, then the runner shuts down.
    d.wallet.adopt(d.wallet.coins + d.game.localChips());
    d.game.requestLeaveTable();
    d.game.stop();
    await new Promise((r) => setTimeout(r, 30));
    d.conn.close();
    const p = server.economy.title.state.players['pid-Dave']!;
    await until(() => !p.objects['SeatLock'], 30000, 'cash-out');
    // A later hello with the wallet's figure must not move the ledger (no double credit, nothing lost).
    const chips = p.chips;
    server.economy.adoptTicket(`local:pid-Dave:${d.wallet.coins}`);
    expect(p.chips).toBe(chips);
    expect(Math.abs(d.wallet.coins - chips!)).toBeLessThanOrEqual(0);
  }, 40000);
});

describe('local table server — party rooms', () => {
  it('creates a room, joins by code, and the owner adds a bot and starts', async () => {
    const created = await connectTable({ kind: 'create' }, { url: server.url });
    expect(created.ok, created.message).toBe(true);
    const code = created.session!;
    expect(code).toMatch(/^[A-Z1-9]{8}$/);
    const host = headlessClient(created.conn!, { name: 'Host', token: 'tok-host', playerId: 'pid-host', coins: 5000, speed: SPEED });
    host.game.start();
    // Private rooms spectate on hello; Join Table claims the seat (500–1,000 buy-in).
    await until(() => host.game.canJoinTable, 5000, 'join offer');
    expect(host.game.isPrivateTable).toBe(true);
    host.game.requestJoinTable();
    await until(() => host.game.localSeat >= 0 && host.game.isTableOwner, 5000, 'host seated & owner');

    const joined = await connectTable({ kind: 'join', code: code.toLowerCase() }, { url: server.url });
    expect(joined.ok, joined.message).toBe(true);
    const guest = headlessClient(joined.conn!, { name: 'Guest', token: 'tok-guest', playerId: 'pid-guest', coins: 5000, speed: SPEED });
    guest.game.start();
    await until(() => guest.game.canJoinTable, 5000, 'guest offer');
    guest.game.confirmPrivateBuyIn(600);
    await until(() => guest.game.localSeat >= 0, 5000, 'guest seated');
    expect(guest.game.isTableOwner).toBe(false);

    host.game.requestAddBot();
    await until(() => (host.game.roster ?? []).filter((s) => s.isOccupied).length === 3, 5000, 'bot added');
    await until(() => host.game.lobby!.readyCount >= 2, 5000, 'funded');
    host.game.requestStartGame();
    await until(() => host.game.handsSeen >= 1 && guest.game.handsSeen >= 1, 20000, 'first hand');
    expect(guest.view.seats[guest.game.localSeat]!.stack).toBeLessThanOrEqual(600);
    // Blinds 5/10 on a private table.
    expect(server.economy.title.state.players['pid-guest']!.chips).toBe(5000 - 600);

    const missing = await connectTable({ kind: 'join', code: 'ZZZZZZZZ' }, { url: server.url, delay: async () => {} });
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('not found');

    for (const h of [host, guest]) {
      h.game.stop();
      h.conn.close();
    }
  }, 40000);
});
