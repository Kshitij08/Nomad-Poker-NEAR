/**
 * A player who presses Leave in the moment between a hand ending and the table settling it. The engine had already
 * unlocked the seats, so the seat was released (and cashed out) at once; the settlement then read that player's stack
 * as 0, reported "Chip conservation broken", halted the table's books and never recorded the hand's house result.
 * Found by the 300-player load test on staging (9 Nov: one table of 60, off by -416, house books short by 112).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlayerAction } from '@nomad/engine/actions/actions';
import { PokerServerGame } from '@nomad/table-server/pokerServerGame';
import { connectTable } from '../../src/net/matchmaking';
import { startPokerServer, type PokerServer } from '../src/server';
import { headlessClient, until, type Headless } from './headlessClient';

const SPEED = 25;
let server: PokerServer;
const errors: string[] = [];
const settled: number[] = [];
let game: PokerServerGame | null = null;
let leaveInGap: (() => void) | null = null;

beforeAll(async () => {
  const log = (level: 'info' | 'warn' | 'error', m: string) => {
    if (level === 'error') errors.push(m);
  };
  server = await startPokerServer({ port: 0, speed: SPEED, log });
  server.registerServer(
    (s) => s.startsWith('poker-free'),
    () => {
      const g = new PokerServerGame({ clock: server.clock, log, economy: server.economy, onHandSettled: (h) => void settled.push(h.handNumber) });
      // Step in exactly where the race was: the hand has ended, the settlement hasn't started.
      const inner = g as unknown as { processEventsUntilHandEnds(): Promise<void> };
      const original = inner.processEventsUntilHandEnds.bind(g);
      inner.processEventsUntilHandEnds = async () => {
        await original();
        const go = leaveInGap;
        leaveInGap = null;
        go?.();
      };
      game = g;
      return g;
    },
  );
});

afterAll(async () => {
  await server?.close();
});

async function player(name: string): Promise<Headless> {
  const r = await connectTable({ kind: 'quick', minBuyIn: 100 }, { url: server.url, coins: 5000, delay: (ms) => new Promise((res) => setTimeout(res, ms / SPEED)) });
  expect(r.ok, r.message).toBe(true);
  const h = headlessClient(r.conn!, { name, token: `tok-${name}`, playerId: `pid-${name}`, coins: 5000, speed: SPEED, buyIn: 500 });
  h.panel.policy = (legal) => (legal.canCheck ? PlayerAction.check() : PlayerAction.fold());
  h.game.start();
  return h;
}

describe('leaving between the end of a hand and its settlement', () => {
  it('waits for the settlement, so the books stay whole', async () => {
    const a = await player('Ann');
    const b = await player('Ben');
    await until(() => a.game.handsSeen >= 1 && b.game.handsSeen >= 1 && game !== null, 20000, 'both dealt in');
    const before = settled.length;
    const ann = server.economy.title.state.players['pid-Ann']!;
    // Ann leaves at the next hand's end, before it is settled.
    leaveInGap = () => {
      const humans = (game as unknown as { humans: Map<number, { name: string; player: number }> }).humans;
      const seat = [...humans].find(([, o]) => o.name === 'Ann');
      if (seat) game!.onLeaveTable(seat[1].player as never);
    };
    await until(() => leaveInGap === null && !ann.objects['SeatLock'], 30000, "Ann's cash-out");
    await until(() => settled.length > before, 10000, 'the hand settled').catch((e: Error) => {
      throw new Error(`${e.message}; table errors: ${errors.join(' / ').slice(0, 300)}`);
    });
    expect(errors.filter((e) => e.includes('conservation'))).toEqual([]);
    expect((game as unknown as { economy: { isHalted: boolean } }).economy.isHalted).toBe(false);
    for (const h of [a, b]) {
      h.game.stop();
      h.conn.close();
    }
  }, 60000);
});
