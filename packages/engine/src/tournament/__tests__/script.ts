/** Test helpers shared by the tournament specs: the C# tests' Script driver and command descriptions. */
import { SeededRandom } from '../../cards/random';
import {
  TournamentDirector, TournamentSpeed, blindLevelToString, seatResult, type SeatResult, type TournamentCommand,
} from '..';

/** RoundPlannerTests.Ids: "p01".."pNN". */
export const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);

/** The golden generator's Describe (a superset of TournamentDirectorTests.Describe). */
export function describeCommand(c: TournamentCommand): string {
  switch (c.kind) {
    case 'TableOpened':
      return `open T${c.tableId} R${c.round}${c.isFinal ? ' final' : ''} @${c.dealAtMs}: ` + c.seats.map((s) => `${s.entrantId}@${s.seat}`).join(',');
    case 'BlindsUp': return `blinds T${c.tableId} ${blindLevelToString(c.blinds)}`;
    case 'SpeedUpStarted': return `fast T${c.tableId}`;
    case 'HighCardDraw': return `draw T${c.tableId} ` + c.cards.map((x) => x.entrantId + x.card.short).join(',');
    case 'PlayersEliminated': return `out T${c.tableId} R${c.round} ` + c.entrantIds.join(',');
    case 'TableClosed': return `close T${c.tableId} ` + c.survivors.join(',');
    case 'TournamentFinished':
      return `won ${c.championId} ` + c.standings.map((s) => `${s.place}:${s.entrantId}:${s.roundReached}${s.isChampion ? '*' : ''}`).join(',');
    case 'TournamentCancelled': return 'cancelled ' + c.reason;
  }
}

export function only<K extends TournamentCommand['kind']>(commands: readonly TournamentCommand[], kind: K): Extract<TournamentCommand, { kind: K }> {
  const found = commands.filter((c) => c.kind === kind);
  if (found.length !== 1) throw new Error(`Expected exactly one ${kind}, got ${found.length}.`);
  return found[0] as Extract<TournamentCommand, { kind: K }>;
}

export function ofKind<K extends TournamentCommand['kind']>(commands: readonly TournamentCommand[], kind: K): Extract<TournamentCommand, { kind: K }>[] {
  return commands.filter((c) => c.kind === kind) as Extract<TournamentCommand, { kind: K }>[];
}

/**
 * TournamentDirectorTests.Script: drives a director with scripted hands in which a chosen player loses every chip
 * to another. Keeps everyone's tournament stack so the reports conserve chips like a real table.
 */
export class Script {
  readonly d: TournamentDirector;
  readonly stack = new Map<string, number>();
  readonly log: string[] = [];
  now = 0;
  /** When true, Tick() and the blinds are logged like the golden generator's script. */
  constructor(players: number, seed: number, private readonly goldenLog = false) {
    this.d = new TournamentDirector(ids(players), TournamentSpeed.Regular, new SeededRandom(seed));
  }

  apply(commands: readonly TournamentCommand[]): readonly TournamentCommand[] {
    for (const c of commands) {
      this.log.push(describeCommand(c));
      if (c.kind === 'TableOpened') for (const s of c.seats) this.stack.set(s.entrantId, c.startingStack);
    }
    return commands;
  }

  start(): readonly TournamentCommand[] {
    return this.apply(this.d.start(this.now));
  }

  dealAt(table: number): number {
    return this.d.snapshot(this.now).tables[table]!.dealAtMs;
  }

  bust(table: number, loser: string, winner: string): readonly TournamentCommand[] {
    this.now = Math.max(this.now, this.dealAt(table));
    const blinds = this.d.blindsForNextHand(table, this.now);
    if (this.goldenLog) this.log.push('bl ' + blindLevelToString(blinds));
    const st = (id: string) => this.stack.get(id)!;
    const results: SeatResult[] = this.d.playersAt(table).map((id) =>
      id === loser ? seatResult(id, st(id), 0) : id === winner ? seatResult(id, st(id), st(id) + st(loser)) : seatResult(id, st(id), st(id)));
    this.stack.set(winner, st(winner) + st(loser));
    this.stack.set(loser, 0);
    return this.apply(this.d.reportHand(table, results, this.now));
  }

  playDown(table: number, left: number): TournamentCommand[] {
    const all: TournamentCommand[] = [];
    while (this.d.playersAt(table).length > left) {
      this.now += 30_000;
      if (this.goldenLog) this.apply(this.d.tick(this.now));
      const players = this.d.playersAt(table);
      all.push(...this.bust(table, players[players.length - 1]!, players[0]!));
    }
    return all;
  }

  /** The golden generator's MultiBust: the last `count` players at the table lose everything on one hand. */
  multiBust(table: number, count: number): void {
    this.now = Math.max(this.now + 30_000, this.dealAt(table));
    this.d.blindsForNextHand(table, this.now);
    const players = [...this.d.playersAt(table)];
    const winner = players[0]!;
    const losers = players.slice(players.length - count);
    const pot = losers.reduce((a, l) => a + this.stack.get(l)!, 0);
    const results = players.map((id) => {
      const start = this.stack.get(id)!;
      return seatResult(id, start, losers.includes(id) ? 0 : id === winner ? start + pot : start);
    });
    for (const l of losers) this.stack.set(l, 0);
    this.stack.set(winner, this.stack.get(winner)! + pot);
    this.apply(this.d.reportHand(table, results, this.now));
  }
}
