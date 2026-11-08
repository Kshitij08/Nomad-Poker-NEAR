/**
 * Bit-exact parity with the Unity C# tournament core. `golden/tournament-golden.json` is produced by `golden/gen`, a
 * .NET console app that compiles the real Assets/Scripts/Core (+ Tournament, Bots) sources:
 *
 *   cd packages/engine/src/tournament/__tests__/golden/gen && dotnet run -c Release -p:UNITY_REPO=<Unity Poker checkout> -- ../tournament-golden.json
 */
import { describe, expect, it } from 'vitest';
import golden from './golden/tournament-golden.json';
import { SeededRandom } from '../../cards/random';
import { PokerEngine } from '../../engine/pokerEngine';
import { HeuristicBot } from '../../bots/heuristicBot';
import type { IPokerBot } from '../../bots/botContext';
import {
  HighCardDraw, PayoutCalculator, RoundPlanner, TableClock, TableReferee, TableStage, TournamentDirector, TournamentRules,
  TournamentSpeed, blindLevelToString, compareNum, dotnetSort, seatResult, type TournamentCommand,
} from '..';
import { Script, describeCommand, ids } from './script';
import { playBotHand } from './simulate';

interface Golden {
  sort: { n: number; keys: number; seed: number; out: string }[];
  highCard: { seed: number; n: number; out: string }[];
  firstRound: { n: number; seed: number; tables: number; out: string }[];
  nextRound: { seed: number; out: string }[];
  referee: { seed: number; stage: number; out: string[]; rem: string[]; closed: boolean; champ: string | null; draws: string }[];
  payout: number[][];
  clock: { levelMs: number; start: number; speedAt: number; startedBefore: boolean; out: string }[];
  scripted: { players: number; seed: number; order: number[]; log: string }[];
  multiBust: { seed: number; log: string }[];
  simulation: { players: number; seed: number; log: string }[];
}
const G = golden as unknown as Golden;

describe('parity with the C# tournament core', () => {
  it('dotnetSort leaves ties exactly where List<T>.Sort does', () => {
    for (const c of G.sort) {
      const rng = new SeededRandom(c.seed);
      const list = Array.from({ length: c.n }, (_, idx) => ({ key: rng.next(c.keys), idx }));
      dotnetSort(list, (a, b) => compareNum(a.key, b.key));
      expect(list.map((x) => `${x.key}.${x.idx}`).join(','), `n=${c.n} keys=${c.keys} seed=${c.seed}`).toBe(c.out);
    }
  });

  it('high-card draws', () => {
    for (const c of G.highCard) {
      const who = ['a', 'b', 'c', 'd', 'e'].slice(0, c.n);
      const d = HighCardDraw.draw(who, new SeededRandom(c.seed));
      expect(d.map((x) => x.entrantId + x.card.short).join(','), `seed ${c.seed}`).toBe(c.out);
    }
  });

  it('first-round and next-round draws', () => {
    for (const c of G.firstRound) {
      const t = RoundPlanner.drawFirstRound(ids(c.n), c.tables, new SeededRandom(c.seed));
      expect(t.map((x) => x.map((s) => `${s.entrantId}@${s.seat}`).join(',')).join('|')).toBe(c.out);
    }
    for (const c of G.nextRound) {
      const groups = c.seed % 2 === 0 ? [['a1', 'a2'], ['b1', 'b2']] : [['a1', 'a2'], ['b1', 'b2', 'b3']];
      expect(RoundPlanner.drawNextRound(groups, new SeededRandom(c.seed)).map((s) => `${s.entrantId}@${s.seat}`).join(',')).toBe(c.out);
    }
  });

  it('referee with tied busts', () => {
    for (const c of G.referee) {
      const results = [
        seatResult('a', 2000, 0), seatResult('b', 2000, 0), seatResult('c', 1000, 0), seatResult('d', 2000, 0),
        seatResult('e', 1000, 0), seatResult('f', 5000, 13000), seatResult('g', 4000, 4000),
      ];
      const o = TableReferee.resolve(c.stage as TableStage, results, new SeededRandom(c.seed));
      expect(o.eliminatedWorstFirst, `seed ${c.seed}`).toEqual(c.out);
      expect(o.remaining).toEqual(c.rem);
      expect(o.tableClosed).toBe(c.closed);
      expect(o.champion).toBe(c.champ);
      expect(o.draws.map((x) => x.entrantId + x.card.short).join(',')).toBe(c.draws);
    }
  });

  it('payouts', () => {
    for (const [prize, fee, players, bps, pool, platform, first, second] of G.payout) {
      const p = PayoutCalculator.compute(prize!, fee!, players!, bps!);
      expect([p.pool, p.fee, p.first, p.second]).toEqual([pool, platform, first, second]);
    }
  });

  it('table clocks', () => {
    for (const c of G.clock) {
      const clock = new TableClock(c.levelMs);
      if (c.startedBefore) clock.start(c.start);
      if (c.speedAt >= 0) clock.enableSpeedUp(c.speedAt);
      if (!c.startedBefore) clock.start(c.start);
      for (const sample of c.out.split(',')) {
        const [t, level, ms] = sample.split(':').map(Number);
        expect([clock.levelAt(t!), clock.msToNextLevel(t!)]).toEqual([level, ms]);
      }
    }
  });

  it('scripted directors (every command, blinds and the final snapshot)', () => {
    for (const c of G.scripted) {
      const s = new Script(c.players, c.seed, true);
      s.start();
      for (const t of c.order) s.playDown(t, s.d.snapshot(s.now).tables[t]!.isFinal ? 1 : 2);
      const snap = s.d.snapshot(s.now);
      s.log.push(`snap ${snap.entrants} ${snap.playersRemaining} ${snap.isFinished ? 1 : 0} ` + snap.tables.map((t) =>
        `${t.tableId}:${t.round}:${+t.isFinal}${+t.isClosed}${+t.isDealing}${+t.isSpedUp}:${t.playersLeft}:${t.dealAtMs}:${blindLevelToString(t.blinds)}:${t.msToNextLevel}`).join(';'));
      expect(s.log.join('\n'), `players ${c.players} seed ${c.seed}`).toBe(c.log);
    }
  });

  it('multi-player busts settled by high card through the director', () => {
    for (const c of G.multiBust) {
      const s = new Script(8, c.seed);
      s.apply(s.d.start(0));
      s.multiBust(0, 2);
      s.multiBust(1, 3);
      expect(s.log.join('\n'), `seed ${c.seed}`).toBe(c.log);
    }
  });

  it('whole tournaments with HeuristicBots on real engines', () => {
    for (const c of G.simulation) {
      const log: string[] = [];
      const entrants = ids(c.players);
      const director = new TournamentDirector(entrants, TournamentSpeed.Regular, new SeededRandom(c.seed));
      const bots = new Map<string, IPokerBot>(entrants.map((id, i) => [id, new HeuristicBot(c.seed * 1000 + i)]));
      const tables = new Map<number, { engine: PokerEngine; seatOf: Map<string, number> }>();
      const order: number[] = [];
      let now = 0;
      let hands = 0;
      const apply = (commands: readonly TournamentCommand[]) => {
        for (const cmd of commands) {
          log.push(describeCommand(cmd));
          if (cmd.kind === 'TableOpened') {
            const engine = new PokerEngine({ seatCount: TournamentRules.SeatsPerTable, smallBlind: 25, bigBlind: 50, startingStack: 5000 }, new SeededRandom(c.seed * 31 + cmd.tableId));
            const seatOf = new Map<string, number>();
            for (const st of cmd.seats) {
              engine.seatPlayer(st.seat, st.entrantId, st.entrantId, true, cmd.startingStack);
              seatOf.set(st.entrantId, st.seat);
            }
            tables.set(cmd.tableId, { engine, seatOf });
            order.push(cmd.tableId);
          } else if (cmd.kind === 'PlayersEliminated') {
            const at = tables.get(cmd.tableId)!;
            for (const id of cmd.entrantIds) {
              at.engine.vacateSeat(at.seatOf.get(id)!);
              at.seatOf.delete(id);
            }
          } else if (cmd.kind === 'TableClosed') {
            tables.delete(cmd.tableId);
            order.splice(order.indexOf(cmd.tableId), 1);
          }
        }
      };
      apply(director.start(now));
      while (!director.isFinished) {
        now += 20_000;
        apply(director.tick(now));
        for (const id of [...order]) {
          if (director.isFinished) break;
          const t = tables.get(id);
          if (!t || !director.canDeal(id, now)) continue;
          const blinds = director.blindsForNextHand(id, now);
          t.engine.setBlinds(blinds.smallBlind, blinds.bigBlind);
          const dealtIn = [...director.playersAt(id)];
          const start = new Map(dealtIn.map((x) => [x, t.engine.table.seats[t.seatOf.get(x)!]!.stack]));
          playBotHand(t.engine, bots, true);
          const results = dealtIn.map((x) => seatResult(x, start.get(x)!, t.engine.table.seats[t.seatOf.get(x)!]!.stack));
          hands++;
          apply(director.reportHand(id, results, now));
        }
      }
      log.push(`hands ${hands} now ${now}`);
      expect(log.join('\n'), `players ${c.players} seed ${c.seed}`).toBe(c.log);
    }
  });
});
