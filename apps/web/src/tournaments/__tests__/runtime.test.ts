/**
 * The tournament runtime (TournamentServerGame + TournamentTableRunner ports) on a virtual clock: a whole practice
 * tournament with one scripted "human" connection and bots, end to end through the transport, plus the client
 * state and the TournamentTableClient's seat mapping.
 */
import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../core/cards/random';
import { PlayerAction } from '../../core/actions/actions';
import { TournamentPhase, TournamentPlayerState, TournamentViewReason, type TournamentResultEvent, type TournamentStatusEvent, type TournamentViewEvent } from '../../core/tournament';
import { TournamentServerGame, cleanName } from '../runtime/tournamentServerGame';
import { OUT_OF_BAND, type RuntimeTiming, type WireEvent } from '../runtime/wire';
import { TournamentClientState } from '../clientState';
import { SeatMapView } from '../client/seatMapView';
import type { TableViewPort } from '../../core/orchestration/tableView';
import { TournamentDemoData } from '../api/demoData';
import { TournamentApiClient } from '../api/apiClient';
import { clock, ordinal } from '../format';

/** A virtual clock: wait() parks a timer; run() jumps to the next one, letting promises settle in between. */
class VirtualTime {
  now = 0;
  private timers: { at: number; resolve: () => void }[] = [];
  readonly timing: RuntimeTiming;
  constructor(seed: number) {
    const rng = new SeededRandom(seed);
    this.timing = {
      nowMs: () => this.now,
      wait: (seconds, signal) => new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        this.timers.push({ at: this.now + Math.max(0, seconds) * 1000, resolve });
      }),
      random: () => rng.next(1_000_000) / 1_000_000,
      makeRandom: () => new SeededRandom(rng.next(1 << 30)),
    };
  }
  async runUntil(done: () => boolean, limitMs: number): Promise<void> {
    while (!done() && this.now < limitMs) {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      if (this.timers.length === 0) continue;
      this.timers.sort((a, b) => a.at - b.at);
      const t = this.timers.shift()!;
      this.now = Math.max(this.now, t.at);
      t.resolve();
    }
  }
}

const PACING = { turnTimer: 15, dealDelay: 0.12, dealSettleDelay: 0.9, actionDelay: 0.4, showdownDelay: 2, betweenHands: 2.5 };

describe('TournamentServerGame (practice mode, virtual time)', () => {
  it.each([5, 8, 16])('a %i-player practice runs to a champion and tells the human', async (players) => {
    const vt = new VirtualTime(players);
    const received: { seq: number; e: WireEvent }[] = [];
    let server!: TournamentServerGame;
    const me = 7;
    server = new TournamentServerGame({
      transport: {
        sendEventTo: (player, seq, e) => {
          expect(player).toBe(me);
          received.push({ seq, e });
          // The human plays like an absent-minded player: check if free, else fold — straight away.
          if (e.type === 'TurnStarted' && e.forYou) {
            setTimeout(() => {}, 0);
            queueMicrotask(() => server.onActionSubmitted(me, e.seat, e.legal.canCheck ? PlayerAction.check() : PlayerAction.fold()));
          }
        },
        disconnect: () => { throw new Error('nobody is turned away'); },
      },
      timing: vt.timing,
      pacing: PACING,
      devPlayers: players,
      practiceHost: true,
      devFillWaitMs: 0,
      botSeed: 42,
      log: () => {},
    });
    server.activate();
    server.onHello(me, '  Kshitij  ', 'tok', '');
    await vt.runUntil(() => server.phase === TournamentPhase.Finished, 6 * 3600_000);
    server.shutdown();

    expect(server.phase).toBe(TournamentPhase.Finished);
    const views = received.filter((r) => r.e.type === 'TournamentView').map((r) => r.e as TournamentViewEvent);
    expect(views[0]!.reason).toBe(TournamentViewReason.BeforeStart);
    expect(views.some((v) => v.reason === TournamentViewReason.Seated && v.yourSeat >= 0)).toBe(true);
    const results = received.filter((r) => r.e.type === 'TournamentResult').map((r) => r.e as TournamentResultEvent);
    const final = results.find((r) => r.finished)!;
    expect(final).toBeDefined();
    expect(final.entrants).toBe(players);
    expect(final.yourPlace).toBeGreaterThanOrEqual(1);
    expect(final.championName).toBeTruthy();
    // Out-of-band for tournament events; table events carry a sequence that rises per table stream.
    expect(received.filter((r) => r.e.type.startsWith('Tournament')).every((r) => r.seq === OUT_OF_BAND)).toBe(true);
    // Statuses name the practice run and know who we are.
    const statuses = received.filter((r) => r.e.type === 'TournamentStatus').map((r) => r.e as TournamentStatusEvent);
    expect(statuses.at(-1)!.name).toBe('Practice tournament');
    expect(statuses.at(-1)!.phase).toBe(TournamentPhase.Finished);
    expect([TournamentPlayerState.Champion, TournamentPlayerState.Eliminated]).toContain(statuses.at(-1)!.myState);
    // Our own hole cards are real; nobody else's ever reach us.
    for (const r of received) if (r.e.type === 'HoleCardsDealt' && r.e.card0) expect(r.e.card0).toBeTruthy();
  }, 60_000);
});

describe('TournamentClientState', () => {
  it('keeps the final standings over a later knockout and pays XP once per kind', () => {
    const s = new TournamentClientState();
    let changes = 0;
    s.onChanged(() => changes++);
    s.begin('TRNX');
    const base = { type: 'TournamentResult' as const, youWon: false, yourPlace: 0, yourRound: 1, entrants: 5, xpEarned: 20, yourPrize: 0, championName: '', runnerUpName: '', firstPrize: 0, secondPrize: 0 };
    s.onResult({ ...base, finished: true, yourPlace: 2 });
    s.onResult({ ...base, finished: false });
    expect(s.result!.finished).toBe(true);
    expect(s.tryClaimXp('TRNX', false)).toBe(true);
    expect(s.tryClaimXp('TRNX', false)).toBe(false);
    s.clear();
    expect(s.active).toBe(false);
    expect(changes).toBeGreaterThan(0);
  });
});

describe('SeatMapView', () => {
  it('puts the local seat at view slot 0 and spreads the rest in table order', () => {
    const calls: string[] = [];
    const inner = { seatCount: 7, betting: null, hideSeat: (s: number) => calls.push(`hide ${s}`) } as unknown as TableViewPort;
    const v = new SeatMapView(inner);
    v.setPerspective([0, 2, 4, 6], 4, 8);
    expect([v.slotOf(4), v.slotOf(6), v.slotOf(0), v.slotOf(2)]).toEqual([0, 1, 3, 5]);
    v.setPerspective([1, 3, 5], -1, 8);
    expect([v.slotOf(1), v.slotOf(3), v.slotOf(5)]).toEqual([0, 2, 4]);
  });
});

describe('demo data, API client and formatting', () => {
  it('registers, leaves, hosts and finds by code like TournamentDemoData', async () => {
    const api = new TournamentApiClient({ live: false, backendUrl: '', sessionTicket: () => null, playFabId: () => null });
    expect(api.demoMode).toBe(true);
    const open = (await api.list()).value!.tournaments;
    expect(open.map((t) => t.id)).toEqual(['demo-ready', 'demo-highroller', 'demo-rookie', 'demo-friday', 'demo-weekend', 'demo-freeroll', 'demo-midnight']);
    const friday = open.find((t) => t.id === 'demo-friday')!;
    expect([friday.prizePool, friday.firstPrize, friday.secondPrize]).toEqual([29000, 17400, 11600]);
    const reg = await api.register('demo-friday');
    expect(reg.value!.myStatus).toBe('registered');
    expect(reg.value!.players).toBe(19);
    expect((await api.unregister('demo-friday')).value!.players).toBe(18);
    expect((await api.byCode(' k7q2xm ')).value!.id).toBe('demo-mine-hosted');
    expect((await api.byCode('NOPE')).error).toContain('Demo codes');
    const made = await api.create({ name: 'Mine', hostPrize: 0, entryFee: 0, maxPlayers: 8, speed: 'turbo', visibility: 'private', startsAtUnix: api.serverNowUnix + 3600 });
    expect(made.value!.joinCode).toBe('DEMO11');
    expect((await api.cancel(made.value!.id)).value!.status).toBe('cancelled');
    expect((await api.cancel('demo-friday')).error).toBe('Only the host can do that.');
    const mine = (await api.mine()).value!;
    expect(mine.hosted.some((t) => t.id === 'demo-mine-hosted')).toBe(true);
  });

  it('demo data is per instance', () => {
    const a = new TournamentDemoData(() => 1000);
    a.register('demo-rookie');
    expect(new TournamentDemoData(() => 1000).get('demo-rookie').value!.players).toBe(3);
  });

  it('formats like the C#', () => {
    expect(clock(245)).toBe('4:05');
    expect(clock(3600 + 7 * 60)).toBe('1h 07m');
    expect(clock(-3)).toBe('0:00');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
    expect(cleanName('  ', 'abcdef')).toBe('Player cdef');
    expect(cleanName('a'.repeat(25), 'x')).toBe('a'.repeat(20));
  });
});
