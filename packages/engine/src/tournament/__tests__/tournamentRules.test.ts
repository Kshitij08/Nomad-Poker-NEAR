/** Ports of Assets/Scripts/Tests/TournamentRulesTests.cs and TournamentClockTests.cs (NUnit → vitest). */
import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../cards/random';
import { ArgumentOutOfRangeError } from '../../errors';
import {
  ArgumentError, BlindSchedule, HighCardDraw, OverflowError, PayoutCalculator, RoundPlanner, TableClock, TableReferee,
  TableStage, TournamentFormat, TournamentRewards, TournamentRules, TournamentSpeed, seatResult as R, speedLevelMs,
} from '..';

import { ids } from './script';

describe('BlindSchedule', () => {
  it.each([
    [1, 25, 50], [2, 50, 100], [7, 500, 1000], [10, 1500, 3000], [11, 3000, 6000], [12, 6000, 12000],
  ])('level %i is %i/%i', (level, small, big) => {
    const b = BlindSchedule.forLevel(level);
    expect(b.level).toBe(level);
    expect(b.smallBlind).toBe(small);
    expect(b.bigBlind).toBe(big);
  });

  it('never goes down and stops rising at the cap', () => {
    let previous = 0;
    for (let level = 1; level <= BlindSchedule.MaxLevel + 20; level++) {
      const b = BlindSchedule.forLevel(level);
      expect(b.bigBlind).toBeGreaterThanOrEqual(previous);
      expect(b.bigBlind).toBe(b.smallBlind * 2);
      expect(b.smallBlind).toBeGreaterThan(0);
      previous = b.bigBlind;
    }
    expect(BlindSchedule.forLevel(BlindSchedule.MaxLevel + 100).bigBlind).toBe(BlindSchedule.forLevel(BlindSchedule.MaxLevel).bigBlind);
    expect(BlindSchedule.forLevel(40).smallBlind).toBe(1500 * 2 ** 30); // C# 1500L << 30
  });

  it('level zero throws', () => {
    expect(() => BlindSchedule.forLevel(0)).toThrow(ArgumentOutOfRangeError);
  });

  it('speeds have their level lengths', () => {
    expect(speedLevelMs(TournamentSpeed.Turbo)).toBe(5 * 60_000);
    expect(speedLevelMs(TournamentSpeed.Regular)).toBe(8 * 60_000);
    expect(speedLevelMs(TournamentSpeed.Slow)).toBe(12 * 60_000);
    expect(() => speedLevelMs(7 as TournamentSpeed)).toThrow(ArgumentOutOfRangeError);
  });
});

describe('TableClock', () => {
  const Min = 60_000;
  const Regular = 8 * Min;

  it('is level one before it starts', () => {
    const clock = new TableClock(Regular);
    expect(clock.isStarted).toBe(false);
    expect(clock.levelAt(1_000_000_000)).toBe(1);
    expect(clock.msToNextLevel(1_000_000_000)).toBe(Regular);
  });

  it('changes levels on the minute', () => {
    const clock = new TableClock(Regular);
    clock.start(0);
    expect(clock.levelAt(Regular - 1)).toBe(1);
    expect(clock.levelAt(Regular)).toBe(2);
    expect(clock.levelAt(2 * Regular)).toBe(3);
    expect(clock.msToNextLevel(1 * Min)).toBe(7 * Min);
  });

  it('counts from its own start', () => {
    const clock = new TableClock(Regular);
    clock.start(90 * Min);
    expect(clock.levelAt(97 * Min)).toBe(1);
    expect(clock.levelAt(98 * Min)).toBe(2);
  });

  it('honours start only once', () => {
    const clock = new TableClock(Regular);
    clock.start(0);
    clock.start(5 * Min);
    expect(clock.levelAt(Regular)).toBe(2);
  });

  it('speed-up halves the rest of the level, then every level', () => {
    const clock = new TableClock(Regular);
    clock.start(0);
    clock.enableSpeedUp(2 * Min); // 6 minutes left in level 1
    expect(clock.isSpedUp).toBe(true);
    expect(clock.levelAt(2 * Min)).toBe(1);
    expect(clock.msToNextLevel(2 * Min)).toBe(3 * Min);
    expect(clock.levelAt(5 * Min - 1)).toBe(1);
    expect(clock.levelAt(5 * Min)).toBe(2);
    expect(clock.levelAt(9 * Min - 1)).toBe(2);
    expect(clock.levelAt(9 * Min)).toBe(3);
    expect(clock.msToNextLevel(9 * Min)).toBe(4 * Min);
  });

  it('speed-up later in the clock keeps earlier levels', () => {
    const clock = new TableClock(Regular);
    clock.start(0);
    clock.enableSpeedUp(20 * Min); // level 3 (16–24), 4 minutes left
    expect(clock.levelAt(20 * Min)).toBe(3);
    expect(clock.levelAt(22 * Min)).toBe(4);
    expect(clock.levelAt(26 * Min)).toBe(5);
    expect(clock.levelAt(30 * Min)).toBe(6);
  });

  it('applies the speed-up only once', () => {
    const clock = new TableClock(Regular);
    clock.start(0);
    clock.enableSpeedUp(2 * Min);
    clock.enableSpeedUp(4 * Min);
    expect(clock.levelAt(5 * Min)).toBe(2);
    expect(clock.levelAt(9 * Min)).toBe(3);
  });

  it('speed-up before the first hand makes every level short', () => {
    const clock = new TableClock(Regular);
    clock.enableSpeedUp(0);
    clock.start(10 * Min);
    expect(clock.levelAt(14 * Min - 1)).toBe(1);
    expect(clock.levelAt(14 * Min)).toBe(2);
  });

  it('rejects a too-short level', () => {
    expect(() => new TableClock(1)).toThrow(ArgumentOutOfRangeError);
  });
});

describe('RoundPlanner', () => {
  it.each([
    [0, TournamentFormat.Cancelled], [1, TournamentFormat.Cancelled], [2, TournamentFormat.SingleTable],
    [7, TournamentFormat.SingleTable], [8, TournamentFormat.TwoTables], [15, TournamentFormat.TwoTables],
    [16, TournamentFormat.FourTables], [30, TournamentFormat.FourTables],
  ])('%i players → format %i', (players, expected) => {
    expect(RoundPlanner.formatFor(players)).toBe(expected);
  });

  it('more than thirty throws', () => {
    expect(() => RoundPlanner.formatFor(31)).toThrow(ArgumentOutOfRangeError);
  });

  it('rounds end in one final table', () => {
    expect(RoundPlanner.tablesPerRound(TournamentFormat.Cancelled)).toEqual([]);
    expect(RoundPlanner.tablesPerRound(TournamentFormat.SingleTable)).toEqual([1]);
    expect(RoundPlanner.tablesPerRound(TournamentFormat.TwoTables)).toEqual([2, 1]);
    expect(RoundPlanner.tablesPerRound(TournamentFormat.FourTables)).toEqual([4, 2, 1]);
  });

  it('first-round tables are even and fit', () => {
    for (let n = 2; n <= 30; n++) {
      const tables = RoundPlanner.tablesPerRound(RoundPlanner.formatFor(n))[0]!;
      const sizes = RoundPlanner.splitSeats(n, tables);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(n);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(TournamentRules.SeatsPerTable);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(2);
    }
    expect(RoundPlanner.splitSeats(30, 4)).toEqual([8, 8, 7, 7]);
    expect(RoundPlanner.splitSeats(27, 4)).toEqual([7, 7, 7, 6]);
  });

  it('first-round draw seats everyone once', () => {
    const all = ids(30);
    const tables = RoundPlanner.drawFirstRound(all, 4, new SeededRandom(5));
    expect(tables.flatMap((t) => t.map((s) => s.entrantId)).sort()).toEqual([...all].sort());
    expect(tables.map((t) => t.length)).toEqual([8, 8, 7, 7]);
    for (const t of tables) {
      expect(new Set(t.map((s) => s.seat)).size).toBe(t.length);
      expect(t.every((s) => s.seat >= 0 && s.seat < TournamentRules.SeatsPerTable)).toBe(true);
    }
  });

  it('first-round draw is repeatable for a seed and shuffled', () => {
    const describeTables = (seed: number) =>
      RoundPlanner.drawFirstRound(ids(20), 4, new SeededRandom(seed)).map((t) => t.map((s) => `${s.entrantId}@${s.seat}`).join(',')).join('|');
    expect(describeTables(9)).toBe(describeTables(9));
    expect(describeTables(9)).not.toBe(describeTables(10));
  });

  it('next-round draw never puts table-mates side by side', () => {
    for (let seed = 0; seed < 200; seed++) {
      const seats = RoundPlanner.drawNextRound([['a1', 'a2'], ['b1', 'b2']], new SeededRandom(seed));
      expect(seats.length).toBe(4);
      const round = [...seats].sort((a, b) => a.seat - b.seat).map((s) => s.entrantId[0]);
      for (let i = 0; i < round.length; i++) expect(round[i]).not.toBe(round[(i + 1) % round.length]);
    }
  });

  it('spreadSeats uses the whole table', () => {
    expect(RoundPlanner.spreadSeats(4, 8)).toEqual([0, 2, 4, 6]);
    expect(RoundPlanner.spreadSeats(8, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(() => RoundPlanner.spreadSeats(9, 8)).toThrow(ArgumentOutOfRangeError);
  });
});

describe('HighCardDraw', () => {
  it('cards are different and best comes first', () => {
    const who = ['a', 'b', 'c', 'd', 'e'];
    for (let seed = 0; seed < 100; seed++) {
      const drawn = HighCardDraw.draw(who, new SeededRandom(seed));
      expect(drawn.length).toBe(who.length);
      expect(new Set(drawn.map((d) => d.card.index)).size).toBe(who.length);
      expect(drawn.map((d) => d.entrantId).sort()).toEqual(who);
      for (let i = 1; i < drawn.length; i++) {
        const hi = drawn[i - 1]!.card;
        const lo = drawn[i]!.card;
        expect(hi.rank > lo.rank || (hi.rank === lo.rank && hi.suit > lo.suit)).toBe(true);
      }
    }
  });

  it('is repeatable for a seed', () => {
    const run = () => HighCardDraw.draw(['a', 'b', 'c'], new SeededRandom(4)).map((d) => d.entrantId + d.card.short);
    expect(run()).toEqual(run());
  });
});

describe('TableReferee', () => {
  it('qualifier four to three keeps playing', () => {
    const o = TableReferee.resolve(TableStage.Qualifier, [R('a', 2000, 0), R('b', 6000, 8000), R('c', 6000, 6000), R('d', 6000, 6000)], new SeededRandom(1));
    expect(o.tableClosed).toBe(false);
    expect(o.eliminatedWorstFirst).toEqual(['a']);
    expect([...o.remaining].sort()).toEqual(['b', 'c', 'd']);
  });

  it('qualifier down to two closes', () => {
    const o = TableReferee.resolve(TableStage.Qualifier, [R('a', 3000, 0), R('b', 6000, 9000), R('c', 6000, 6000)], new SeededRandom(1));
    expect(o.tableClosed).toBe(true);
    expect(o.eliminatedWorstFirst).toEqual(['a']);
    expect([...o.remaining].sort()).toEqual(['b', 'c']);
  });

  it('qualifier leaving one: the biggest starting bust also goes through', () => {
    const o = TableReferee.resolve(TableStage.Qualifier, [R('a', 1000, 0), R('b', 3000, 0), R('c', 2000, 0), R('d', 4000, 10000)], new SeededRandom(1));
    expect(o.tableClosed).toBe(true);
    expect([...o.remaining].sort()).toEqual(['b', 'd']);
    expect(o.eliminatedWorstFirst).toEqual(['a', 'c']);
    expect(o.draws.length).toBe(0);
  });

  it('qualifier tied start stacks: high card decides who goes through', () => {
    const o = TableReferee.resolve(TableStage.Qualifier, [R('a', 2000, 0), R('b', 2000, 0), R('c', 1000, 0), R('d', 5000, 10000)], new SeededRandom(7));
    expect(o.tableClosed).toBe(true);
    expect(o.draws.length).toBe(2);
    const drawWinner = o.draws[0]!.entrantId;
    const drawLoser = o.draws[1]!.entrantId;
    expect([...o.remaining].sort()).toEqual(['d', drawWinner].sort());
    expect(o.eliminatedWorstFirst).toEqual(['c', drawLoser]);
  });

  it('final double bust ordered by start stack', () => {
    const o = TableReferee.resolve(TableStage.Final, [R('a', 1000, 0), R('b', 3000, 0), R('c', 6000, 10000), R('d', 10000, 10000)], new SeededRandom(1));
    expect(o.tableClosed).toBe(false);
    expect(o.champion).toBeNull();
    expect(o.eliminatedWorstFirst).toEqual(['a', 'b']);
  });

  it('final last bust crowns the champion', () => {
    const o = TableReferee.resolve(TableStage.Final, [R('a', 4000, 0), R('b', 16000, 20000)], new SeededRandom(1));
    expect(o.tableClosed).toBe(true);
    expect(o.champion).toBe('b');
    expect(o.eliminatedWorstFirst).toEqual(['a']);
  });

  it('nobody left with chips throws', () => {
    expect(() => TableReferee.resolve(TableStage.Final, [R('a', 100, 0), R('b', 100, 0)], new SeededRandom(1))).toThrow(ArgumentError);
  });

  it('rejects zero start stacks and negative end stacks', () => {
    expect(() => TableReferee.resolve(TableStage.Final, [R('a', 0, 0), R('b', 100, 100)], new SeededRandom(1))).toThrow(ArgumentError);
    expect(() => TableReferee.resolve(TableStage.Final, [R('a', 10, -1), R('b', 100, 111)], new SeededRandom(1))).toThrow(ArgumentError);
  });
});

describe('PayoutCalculator', () => {
  it('empty pool pays nothing', () => {
    const p = PayoutCalculator.compute(0, 0, 0);
    expect([p.pool, p.first, p.second]).toEqual([0, 0, 0]);
  });

  it.each([[1000, 600, 400], [1001, 601, 400], [10000, 6000, 4000], [1, 1, 0]])('host prize %i splits %i/%i', (prize, first, second) => {
    const p = PayoutCalculator.compute(prize, 0, 0);
    expect(p.first).toBe(first);
    expect(p.second).toBe(second);
  });

  it('entries add to the pool', () => {
    const p = PayoutCalculator.compute(10000, 500, 20);
    expect([p.pool, p.first, p.second]).toEqual([20000, 12000, 8000]);
  });

  it('fee comes off entries only', () => {
    const p = PayoutCalculator.compute(10000, 500, 20, 1000);
    expect(p.fee).toBe(1000);
    expect(p.first + p.second).toBe(19000);
    expect(p.second).toBe(7600);
  });

  it('prizes and fee always add up to the pool', () => {
    const rng = new SeededRandom(3);
    for (let i = 0; i < 2000; i++) {
      const p = PayoutCalculator.compute(rng.next(1_000_000), rng.next(10_000), rng.next(31), rng.next(10_001));
      expect(p.first + p.second + p.fee).toBe(p.pool);
      expect(p.first).toBeGreaterThanOrEqual(p.second);
      expect(p.second).toBeGreaterThanOrEqual(0);
    }
  });

  it('bad input throws', () => {
    expect(() => PayoutCalculator.compute(-1, 0, 0)).toThrow(ArgumentOutOfRangeError);
    expect(() => PayoutCalculator.compute(0, -1, 0)).toThrow(ArgumentOutOfRangeError);
    expect(() => PayoutCalculator.compute(0, 0, -1)).toThrow(ArgumentOutOfRangeError);
    expect(() => PayoutCalculator.compute(0, 0, 0, 10_001)).toThrow(ArgumentOutOfRangeError);
    expect(() => PayoutCalculator.compute(9223372036854775807n, 1, 1)).toThrow(OverflowError);
  });

  it('flags pools beyond 32 bits', () => {
    expect(PayoutCalculator.compute(2147483647, 0, 0).fitsInt32).toBe(true);
    expect(PayoutCalculator.compute(2147483647, 1, 1).fitsInt32).toBe(false);
  });
});

describe('TournamentRewards', () => {
  it('xp follows the design', () => {
    expect(TournamentRewards.playerXp(0, false)).toBe(20);
    expect(TournamentRewards.playerXp(1, false)).toBe(35);
    expect(TournamentRewards.playerXp(2, true)).toBe(20 + 30 + 150);
    expect(TournamentRewards.hostXpFor(16, true)).toBe(100);
    expect(TournamentRewards.hostXpFor(15, true)).toBe(0);
    expect(TournamentRewards.hostXpFor(30, false)).toBe(0);
  });
});
