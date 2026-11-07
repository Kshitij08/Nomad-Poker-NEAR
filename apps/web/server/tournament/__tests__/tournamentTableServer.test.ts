/**
 * A dev tournament (TRNDEV05) through the local server's IPokerTableServer / TableNet contract on a virtual clock:
 * two people connect, bots fill the rest, every payload goes through PokerEventCodec, and the tournament ends with a
 * champion and the final result for both connections.
 */
import { describe, expect, it } from 'vitest';
import { PlayerAction } from '../../../src/core/actions/actions';
import { PokerEventCodec, isHiddenCard, type WireEvent } from '../../../src/core/events/pokerEventCodec';
import type { ServerClock } from '../../src/clock';
import type { PlayerRef, TableNet } from '../../src/tableNet';
import { TournamentTableServer } from '../tournamentTableServer';
import { devPlayersFor, registerTournaments } from '..';

class VirtualClock implements ServerClock {
  t = 0;
  private timers: { at: number; resolve: () => void }[] = [];
  now = () => this.t;
  wait = (seconds: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    this.timers.push({ at: this.t + Math.max(0, seconds), resolve });
  });
  frame = () => this.wait(0);
  every = (seconds: number, fn: () => void) => {
    let on = true;
    const loop = async () => { while (on) { await this.wait(seconds); if (on) fn(); } };
    void loop();
    return () => { on = false; };
  };
  async runUntil(done: () => boolean, limitSeconds: number): Promise<void> {
    while (!done() && this.t < limitSeconds) {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      if (!this.timers.length) continue;
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers.shift()!;
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
  }
}

describe('TournamentTableServer on the local server contract', () => {
  it('parses TRNDEV session names', () => {
    expect(devPlayersFor('TRNDEV')).toBe(8);
    expect(devPlayersFor('TRNDEV05')).toBe(5);
    expect(devPlayersFor('TRNDEV99')).toBe(30);
    expect(devPlayersFor('TRNABCDEFGHIJ')).toBeNull();
    expect(devPlayersFor('poker-free')).toBeNull();
  });

  it('registers a factory for TRNDEV sessions only (no backend configured)', () => {
    let match: ((s: string) => boolean) | null = null;
    registerTournaments({ registerServer: (m) => { match = m; } }, { clock: new VirtualClock(), backendUrl: '', log: () => {} });
    expect(match!('TRNDEV05')).toBe(true);
    expect(match!('TRNXXXXXXXXXX')).toBe(false);
  });

  it('runs a dev tournament with two people and bots to a champion', async () => {
    const clock = new VirtualClock();
    const inbox = new Map<PlayerRef, WireEvent[]>([[1, []], [2, []]]);
    const server = new TournamentTableServer({ clock, devPlayers: 5, devFillWaitSeconds: 2, log: () => {} });
    const net: TableNet = {
      sessionName: 'TRNDEV05',
      properties: {},
      activePlayers: () => [1, 2],
      broadcastEvent: () => { throw new Error('tournaments address every event to one player'); },
      sendEventTo: (player, payload) => {
        const { sequence, event } = PokerEventCodec.decode(payload);
        expect(Number.isInteger(sequence)).toBe(true);
        if (!event) return;
        inbox.get(player)!.push(event);
        if (event.type === 'TurnStarted' && event.forYou)
          queueMicrotask(() => server.onActionSubmitted(player, event.seat, event.legal.canCheck ? PlayerAction.check() : PlayerAction.fold()));
      },
      sendSeatAssignment: () => {},
      sendWalletBalance: () => {},
      broadcastRetentionGrantResult: () => {},
    };
    server.activate(net);
    server.onHello(1, 'Ana', 'tok-ana', '', 0);
    server.onHello(2, 'Ben', 'tok-ben', '', 0);
    const finalFor = (p: PlayerRef) => inbox.get(p)!.find((e) => e.type === 'TournamentResult' && e.finished);
    await clock.runUntil(() => !!finalFor(1) && !!finalFor(2), 6 * 3600);
    server.dispose();

    for (const p of [1, 2] as PlayerRef[]) {
      const result = finalFor(p);
      expect(result && result.type === 'TournamentResult' && result.entrants).toBe(5);
      // Nobody ever sees another seat's hole cards.
      const events = inbox.get(p)!;
      let mySeat = -1;
      for (const e of events) {
        if (e.type === 'TournamentView') mySeat = e.yourSeat;
        if (e.type === 'HoleCardsDealt' && e.seat !== mySeat) expect(isHiddenCard(e.card0)).toBe(true);
      }
    }
  }, 60_000);
});
