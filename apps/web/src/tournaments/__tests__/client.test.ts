/**
 * TournamentServerGame → in-memory transport → TournamentTableClient → a recording TableViewPort, on a virtual clock:
 * the offline practice wiring without the DOM. The human answers the betting panel with check/fold.
 */
import { describe, expect, it } from 'vitest';
import { SeededRandom } from '@nomad/engine/cards/random';
import { PlayerAction } from '@nomad/engine/actions/actions';
import type { BettingPanelPort, TableViewPort } from '@nomad/engine/orchestration/tableView';
import type { AudioPort } from '@nomad/engine/orchestration/pokerSound';
import { TournamentPhase } from '@nomad/engine/tournament';
import { TournamentServerGame } from '../runtime/tournamentServerGame';
import type { RuntimeTiming } from '../runtime/wire';
import { TournamentClientState } from '../clientState';
import { TournamentTableClient } from '../client/tournamentTableClient';

describe('TournamentTableClient mirrors the practice server', () => {
  it('plays a 5-player practice to the end through the betting panel', async () => {
    let now = 0;
    const timers: { at: number; resolve: () => void }[] = [];
    const rng = new SeededRandom(9);
    const wait = (seconds: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      timers.push({ at: now + Math.max(0, seconds) * 1000, resolve });
    });
    const timing: RuntimeTiming = { nowMs: () => now, wait, random: () => rng.next(1000) / 1000, makeRandom: () => new SeededRandom(rng.next(1 << 30)) };
    const pacing = { turnTimer: 15, dealDelay: 0.12, dealSettleDelay: 5, actionDelay: 0.4, showdownDelay: 2, betweenHands: 2.5 };

    const log: string[] = [];
    let prompts = 0;
    const betting: BettingPanelPort = {
      show: (legal, _bet, onChosen) => {
        prompts++;
        queueMicrotask(() => onChosen(legal.canCheck ? PlayerAction.check() : PlayerAction.fold()));
      },
      hide: () => {},
    };
    const record = (name: string) => (...args: unknown[]) => { log.push(`${name} ${args.filter((a) => typeof a !== 'object').join(' ')}`); };
    const view = new Proxy({ seatCount: 7, betting } as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : record(k)),
    }) as unknown as TableViewPort;
    const audio: AudioPort = { play: () => {}, startTurnTimer: () => {}, stopTurnTimer: () => {} } as unknown as AudioPort;
    const state = new TournamentClientState();
    let client: TournamentTableClient | null = null;
    const server = new TournamentServerGame({
      transport: { sendEventTo: (p, seq, e) => p === 1 && client?.receive(seq, e), disconnect: () => {} },
      timing, pacing, devPlayers: 5, practiceHost: true, devFillWaitMs: 0, botSeed: 3, log: () => {},
    });
    client = new TournamentTableClient(view, audio, state, {
      session: 'TRNPRACTICE', pacing, wait, now: () => now / 1000,
      submitAction: (seat, a) => server.onActionSubmitted(1, seat, a),
    });
    client.start();
    server.activate();
    server.onHello(1, 'You', 'me', '');

    while (server.phase !== TournamentPhase.Finished && now < 6 * 3600_000) {
      for (let i = 0; i < 30; i++) await Promise.resolve();
      if (!timers.length) continue;
      timers.sort((a, b) => a.at - b.at);
      const t = timers.shift()!;
      now = Math.max(now, t.at);
      t.resolve();
    }
    // Let the client drain what is still queued (the final result follows the last hand's animations).
    for (let k = 0; k < 2000 && !state.result?.finished; k++) {
      for (let i = 0; i < 30; i++) await Promise.resolve();
      const t = timers.sort((a, b) => a.at - b.at).shift();
      if (!t) continue;
      now = Math.max(now, t.at);
      t.resolve();
    }
    server.shutdown();
    client.stop();

    expect(state.session).toBe('TRNPRACTICE');
    expect(state.status?.name).toBe('Practice tournament');
    expect(state.result?.finished).toBe(true);
    expect(prompts).toBeGreaterThan(0);
    expect(log.some((l) => l.startsWith('beginHand'))).toBe(true);
    expect(log.some((l) => l.startsWith('showHoleCards 0'))).toBe(true); // our seat always maps to view slot 0
    // Only mapped slots are ever drawn.
    expect(log.filter((l) => l.startsWith('bindSeat')).every((l) => Number(l.split(' ')[1]) < 7)).toBe(true);
  }, 60_000);
});
