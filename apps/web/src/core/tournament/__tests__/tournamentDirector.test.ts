/** Port of Assets/Scripts/Tests/TournamentDirectorTests.cs and TournamentSimulationTests.cs. */
import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../cards/random';
import { InvalidOperationError, ArgumentOutOfRangeError } from '../../errors';
import { PokerEngine } from '../../engine/pokerEngine';
import { HeuristicBot } from '../../bots/heuristicBot';
import type { IPokerBot } from '../../bots/botContext';
import {
  ArgumentError, EntrantState, RoundPlanner, TournamentDirector, TournamentFormat, TournamentRules, TournamentSpeed,
  roundsPassed, seatResult, speedLevelMs, type TournamentCommand, type TournamentFinishedCommand,
} from '..';
import { Script, ids, ofKind, only } from './script';
import { playBotHand } from './simulate';

describe('TournamentDirector', () => {
  it.each([0, 1])('%i players cancels', (players) => {
    const s = new Script(players, 1);
    const commands = s.start();
    expect(s.d.format).toBe(TournamentFormat.Cancelled);
    expect(commands.length).toBe(1);
    expect(commands[0]!.kind).toBe('TournamentCancelled');
    expect(s.d.isFinished).toBe(true);
  });

  it('five players play one table to the end', () => {
    const s = new Script(5, 2);
    const open = only(s.start(), 'TableOpened');
    expect(s.d.format).toBe(TournamentFormat.SingleTable);
    expect(open.isFinal).toBe(true);
    expect(open.seats.length).toBe(5);
    expect(open.dealAtMs).toBe(TournamentRules.FirstDealDelayMs);
    expect(s.d.canDeal(0, TournamentRules.FirstDealDelayMs - 1)).toBe(false);
    expect(s.d.canDeal(0, TournamentRules.FirstDealDelayMs)).toBe(true);

    const commands = s.playDown(0, 1);
    const finished = only(commands, 'TournamentFinished');
    const outOrder = ofKind(commands, 'PlayersEliminated').flatMap((e) => e.entrantIds);
    expect(s.d.isFinished).toBe(true);
    expect(finished.standings.length).toBe(5);
    expect(finished.standings[0]!.entrantId).toBe(finished.championId);
    expect(finished.standings[1]!.entrantId).toBe(outOrder[outOrder.length - 1]); // last out is 2nd
    expect(finished.standings[4]!.entrantId).toBe(outOrder[0]); // first out is last
    expect(finished.standings.every((x) => roundsPassed(x) === 0)).toBe(true);
    expect(s.d.stateOf(finished.championId).state).toBe(EntrantState.Champion);
  });

  it('twelve players: the last table speeds up and the final waits for the countdown', () => {
    const s = new Script(12, 3);
    const opened = ofKind(s.start(), 'TableOpened');
    expect(opened.map((o) => o.seats.length)).toEqual([6, 6]);
    expect(opened.every((o) => !o.isFinal && o.round === 1)).toBe(true);

    const first = s.playDown(0, 2);
    const closed0 = only(first, 'TableClosed');
    expect(only(first, 'SpeedUpStarted').tableId).toBe(1);
    expect(ofKind(first, 'TableOpened').length).toBe(0); // one finished table waits for the other
    expect(s.d.snapshot(s.now).tables[1]!.isSpedUp).toBe(true);
    for (const id of closed0.survivors) expect(s.d.stateOf(id).state).toBe(EntrantState.Waiting);

    const second = s.playDown(1, 2);
    const closed1 = only(second, 'TableClosed');
    const final = only(second, 'TableOpened');
    expect(final.isFinal).toBe(true);
    expect(final.round).toBe(2);
    expect(final.dealAtMs).toBe(s.now + TournamentRules.NextTableCountdownMs);
    expect(final.seats.map((x) => x.entrantId).sort()).toEqual([...closed0.survivors, ...closed1.survivors].sort());

    // Table-mates sit apart.
    const round = [...final.seats].sort((a, b) => a.seat - b.seat).map((x) => closed0.survivors.includes(x.entrantId));
    for (let i = 0; i < round.length; i++) expect(round[i]).not.toBe(round[(i + 1) % round.length]);

    // The final's clock starts fresh at level 1, however long Round 1 ran.
    expect(() => s.d.blindsForNextHand(2, final.dealAtMs - 1)).toThrow(InvalidOperationError);
    expect(s.d.blindsForNextHand(2, final.dealAtMs).level).toBe(1);

    const standings = only(s.playDown(2, 1), 'TournamentFinished').standings;
    expect(standings.slice(0, 4).every((x) => x.roundReached === 2)).toBe(true);
    expect(standings.slice(4).every((x) => x.roundReached === 1)).toBe(true);
  });

  it('thirty players: tables pair in the order they finish', () => {
    const s = new Script(30, 4);
    expect(ofKind(s.start(), 'TableOpened').map((o) => o.seats.length)).toEqual([8, 8, 7, 7]);

    const c = only(s.playDown(2, 2), 'TableClosed').survivors;
    const afterA = s.playDown(0, 2);
    const a = only(afterA, 'TableClosed').survivors;
    const r2t1 = only(afterA, 'TableOpened');
    expect(r2t1.tableId).toBe(4);
    expect(r2t1.round).toBe(2);
    expect(r2t1.seats.map((x) => x.entrantId).sort()).toEqual([...c, ...a].sort()); // C finished first, then A

    const afterB = s.playDown(1, 2);
    const b = only(afterB, 'TableClosed').survivors;
    expect(only(afterB, 'SpeedUpStarted').tableId).toBe(3); // table D is now the one everyone waits on

    const afterR2T1 = s.playDown(4, 2);
    const r2Winners = only(afterR2T1, 'TableClosed').survivors;
    expect(ofKind(afterR2T1, 'SpeedUpStarted').length).toBe(0); // Round 2's other table doesn't exist yet

    const afterD = s.playDown(3, 2);
    const d = only(afterD, 'TableClosed').survivors;
    const r2t2 = only(afterD, 'TableOpened');
    expect(r2t2.tableId).toBe(5);
    expect(r2t2.seats.map((x) => x.entrantId).sort()).toEqual([...b, ...d].sort());
    expect(only(afterD, 'SpeedUpStarted').tableId).toBe(5); // opens with players already waiting on it

    const afterR2T2 = s.playDown(5, 2);
    const final = only(afterR2T2, 'TableOpened');
    expect(final.isFinal).toBe(true);
    expect(final.round).toBe(3);
    expect(final.seats.map((x) => x.entrantId).sort()).toEqual([...r2Winners, ...only(afterR2T2, 'TableClosed').survivors].sort());

    s.now = final.dealAtMs;
    expect(s.d.blindsForNextHand(final.tableId, s.now).level).toBe(1);

    const standings = only(s.playDown(final.tableId, 1), 'TournamentFinished').standings;
    expect(standings.map((x) => x.place)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(standings.filter((x) => x.isChampion).length).toBe(1);
    expect(roundsPassed(standings[0]!)).toBe(2);
    expect(standings.slice(0, 4).every((x) => x.roundReached === 3)).toBe(true);
    expect(standings.slice(4, 8).every((x) => x.roundReached === 2)).toBe(true);
    expect(standings.slice(8).every((x) => x.roundReached === 1)).toBe(true);
  });

  const runScripted = (players: number, seed: number): string => {
    const s = new Script(players, seed);
    s.start();
    for (const t of [1, 3, 0, 2, 4, 5, 6]) s.playDown(t, t === 6 ? 1 : 2);
    expect(s.d.isFinished).toBe(true);
    return s.log.join('\n');
  };

  it('same seed, same tournament', () => {
    expect(runScripted(30, 8)).toBe(runScripted(30, 8));
    expect(runScripted(30, 8)).not.toBe(runScripted(30, 9));
  });

  it('tick announces each level once', () => {
    const s = new Script(8, 5);
    s.start();
    const start = TournamentRules.FirstDealDelayMs;
    const L = speedLevelMs(TournamentSpeed.Regular);
    s.d.blindsForNextHand(0, start);
    expect(s.d.tick(start + 1000)).toEqual([]);
    const up = s.d.tick(start + L);
    expect(up.length).toBe(1);
    expect(up[0]!.kind === 'BlindsUp' && up[0]!.blinds.level).toBe(2);
    expect(s.d.tick(start + L + 1000)).toEqual([]);
    const next = s.d.tick(start + 2 * L);
    expect(next.length === 1 && next[0]!.kind === 'BlindsUp' && next[0]!.blinds.level).toBe(3);
  });

  it('rejects bad reports', () => {
    const s = new Script(8, 6);
    s.start();
    const players = [...s.d.playersAt(0)];
    const even = players.map((id) => seatResult(id, 5000, 5000));

    expect(() => s.d.reportHand(0, even, 0)).toThrow(InvalidOperationError); // no hand dealt yet
    expect(() => s.d.blindsForNextHand(0, 0)).toThrow(InvalidOperationError); // still counting down

    const now = TournamentRules.FirstDealDelayMs;
    s.d.blindsForNextHand(0, now);
    expect(() => s.d.reportHand(0, even.slice(1), now)).toThrow(ArgumentError); // someone missing
    const leaky = players.map((id, i) => seatResult(id, 5000, i === 0 ? 0 : 5000));
    expect(() => s.d.reportHand(0, leaky, now)).toThrow(ArgumentError); // chips vanished
    const stranger = [...even.slice(0, even.length - 1), seatResult('nobody', 5000, 5000)];
    expect(() => s.d.reportHand(0, stranger, now)).toThrow(ArgumentError);
    const twice = [...even.slice(0, even.length - 1), even[0]!];
    expect(() => s.d.reportHand(0, twice, now)).toThrow(ArgumentError);
    expect(() => s.d.reportHand(9, even, now)).toThrow(InvalidOperationError); // unknown table

    s.now = now;
    s.playDown(0, 2);
    expect(() => s.d.blindsForNextHand(0, s.now)).toThrow(InvalidOperationError); // closed table
  });

  it('constructor rejects bad entrants', () => {
    expect(() => new TournamentDirector(['a', 'a'], TournamentSpeed.Turbo, new SeededRandom(1))).toThrow(ArgumentError);
    expect(() => new TournamentDirector(['a', ''], TournamentSpeed.Turbo, new SeededRandom(1))).toThrow(ArgumentError);
    expect(() => new TournamentDirector(ids(31), TournamentSpeed.Turbo, new SeededRandom(1))).toThrow(ArgumentOutOfRangeError);
  });

  it('start twice throws, and queries reject unknowns', () => {
    const s = new Script(4, 1);
    s.start();
    expect(() => s.d.start(0)).toThrow(InvalidOperationError);
    expect(() => s.d.stateOf('zz')).toThrow(ArgumentError);
    expect(() => s.d.playersAt(5)).toThrow(ArgumentOutOfRangeError);
    expect(s.d.canDeal(-1, 1e9)).toBe(false);
  });

  it('snapshot reflects countdowns, dealing tables and the field', () => {
    const s = new Script(12, 3);
    s.start();
    let snap = s.d.snapshot(0);
    expect(snap.entrants).toBe(12);
    expect(snap.playersRemaining).toBe(12);
    expect(snap.tables.map((t) => [t.isDealing, t.dealAtMs, t.blinds.level])).toEqual([[false, 15000, 1], [false, 15000, 1]]);
    s.playDown(0, 2);
    snap = s.d.snapshot(s.now);
    expect(snap.playersRemaining).toBe(8);
    expect(snap.tables[0]!.isClosed).toBe(true);
    expect(snap.tables[1]!.isSpedUp).toBe(true);
  });
});

describe('Whole tournaments on engines with bots (TournamentSimulationTests)', () => {
  it.each([[2, 1], [7, 2], [8, 3], [15, 4], [16, 5], [30, 6]])('%i players (seed %i) end with one champion', (players, seed) => {
    const entrants = ids(players);
    const director = new TournamentDirector(entrants, TournamentSpeed.Regular, new SeededRandom(seed));
    const bots = new Map<string, IPokerBot>(entrants.map((id, i) => [id, new HeuristicBot(seed * 1000 + i)]));
    interface SimTable { id: number; isFinal: boolean; engine: PokerEngine; chips: number; seatOf: Map<string, number> }
    const tables = new Map<number, SimTable>();
    let finished: TournamentFinishedCommand | null = null;
    let closedQualifiers = 0;
    let now = 0;

    const apply = (commands: readonly TournamentCommand[]) => {
      for (const c of commands) {
        switch (c.kind) {
          case 'TableOpened': {
            expect(c.startingStack).toBe(TournamentRules.StartingStack);
            const t: SimTable = {
              id: c.tableId, isFinal: c.isFinal, chips: c.startingStack * c.seats.length, seatOf: new Map(),
              engine: new PokerEngine({ seatCount: TournamentRules.SeatsPerTable, smallBlind: 25, bigBlind: 50, startingStack: 5000 }, new SeededRandom(seed * 31 + c.tableId)),
            };
            for (const st of c.seats) {
              t.engine.seatPlayer(st.seat, st.entrantId, st.entrantId, true, c.startingStack);
              t.seatOf.set(st.entrantId, st.seat);
            }
            tables.set(c.tableId, t);
            break;
          }
          case 'PlayersEliminated': {
            const at = tables.get(c.tableId)!;
            for (const id of c.entrantIds) {
              expect(at.engine.table.seats[at.seatOf.get(id)!]!.stack).toBe(0);
              at.engine.vacateSeat(at.seatOf.get(id)!);
              at.seatOf.delete(id);
            }
            break;
          }
          case 'TableClosed':
            expect(c.survivors.length).toBe(TournamentRules.SurvivorsPerTable);
            expect(tables.get(c.tableId)!.isFinal).toBe(false);
            tables.delete(c.tableId);
            closedQualifiers++;
            break;
          case 'TournamentFinished': finished = c; break;
          case 'TournamentCancelled': throw new Error('A tournament with players must not cancel.');
          default: break;
        }
      }
    };

    apply(director.start(now));
    let hands = 0;
    while (!director.isFinished) {
      now += 20_000;
      apply(director.tick(now));
      for (const t of [...tables.values()]) {
        if (director.isFinished) break;
        if (!tables.has(t.id) || !director.canDeal(t.id, now)) continue;
        const blinds = director.blindsForNextHand(t.id, now);
        t.engine.setBlinds(blinds.smallBlind, blinds.bigBlind);
        const dealtIn = [...director.playersAt(t.id)];
        const start = new Map(dealtIn.map((id) => [id, t.engine.table.seats[t.seatOf.get(id)!]!.stack]));
        playBotHand(t.engine, bots, false);
        let total = 0;
        const results = dealtIn.map((id) => {
          const end = t.engine.table.seats[t.seatOf.get(id)!]!.stack;
          total += end;
          return seatResult(id, start.get(id)!, end);
        });
        expect(total).toBe(t.chips);
        apply(director.reportHand(t.id, results, now));
        expect(++hands).toBeLessThan(20_000);
      }
    }

    const f = finished as TournamentFinishedCommand | null;
    expect(f).not.toBeNull();
    expect(f!.standings.length).toBe(players);
    expect(f!.standings.map((x) => x.place)).toEqual(Array.from({ length: players }, (_, i) => i + 1));
    expect(f!.standings.filter((x) => x.isChampion).length).toBe(1);
    expect(f!.standings[0]!.entrantId).toBe(f!.championId);
    const perRound = RoundPlanner.tablesPerRound(RoundPlanner.formatFor(players));
    expect(closedQualifiers).toBe(perRound.reduce((a, b) => a + b, 0) - 1);
    expect(f!.standings[0]!.roundReached).toBe(perRound.length);
  });
});
