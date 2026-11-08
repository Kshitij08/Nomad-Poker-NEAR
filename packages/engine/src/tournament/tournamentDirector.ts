import type { IRandom } from '../cards/random';
import { InvalidOperationError, ArgumentOutOfRangeError } from '../errors';
import { BlindSchedule, type BlindLevel } from './blindSchedule';
import { compareNum, dotnetSort } from './dotnetSort';
import { ArgumentError } from './errors';
import { RoundPlanner, TournamentFormat, type SeatAssignment } from './roundPlanner';
import { TableClock } from './tableClock';
import { TableReferee, TableStage, type SeatResult } from './tableReferee';
import type { TournamentCommand, TournamentStanding } from './tournamentCommand';
import { TournamentRules, speedLevelMs, type TournamentSpeed } from './tournamentRules';
import { EntrantState, type TournamentSnapshot, type TournamentTableSummary } from './tournamentSnapshot';

interface Table {
  id: number;
  roundIndex: number;
  isFinal: boolean;
  readonly players: string[];
  clock: TableClock;
  dealAtMs: number;
  closed: boolean;
  announcedLevel: number;
}

interface Entrant {
  id: string;
  roundReached: number;
  eliminated: boolean;
  eliminationSeq: number;
  champion: boolean;
  tableId: number;
}

/**
 * Runs one hosted round-format tournament (design doc v0.5) as a deterministic state machine.
 *
 * It never deals a card or reads a clock. The server calls in with the time and each finished hand's stacks; the
 * director answers with TournamentCommands (open a table, players out, close a table, speed up, finished) and the
 * server carries them out. Given the same entrants, seed and calls it produces the same commands.
 *
 * Flow: start() draws Round 1. Before every hand the server asks blindsForNextHand() (which starts that table's
 * clock on its first hand), plays it, then reports it with reportHand(). tick() announces level changes for the HUD.
 * Port of Core/Tournament/TournamentDirector.cs.
 */
export class TournamentDirector {
  private readonly rng: IRandom;
  private readonly levelMs: number;
  private readonly entrantOrder: string[] = [];
  private readonly entrants = new Map<string, Entrant>();
  private readonly tablesPerRound: number[];
  private readonly closedPerRound: number[];
  /** Survivor groups of finished tables, per round they are waiting to play in, oldest first. */
  private readonly waiting: string[][][];
  private readonly tables: Table[] = [];
  private eliminationSeq = 0;
  private started = false;

  readonly format: TournamentFormat;
  private _isFinished = false;
  private _championId: string | null = null;

  /** @param levelMsOverride Level length in ms instead of the speed's. For practice runs only. */
  constructor(entrantIds: readonly string[], readonly speed: TournamentSpeed, rng: IRandom, levelMsOverride = 0) {
    if (!entrantIds) throw new TypeError('entrantIds is required.');
    if (!rng) throw new TypeError('rng is required.');
    this.rng = rng;
    this.levelMs = levelMsOverride > 0 ? levelMsOverride : speedLevelMs(speed); // also validates the enum

    for (const id of entrantIds) {
      if (!id) throw new ArgumentError('Entrant ids must be non-empty.');
      if (this.entrants.has(id)) throw new ArgumentError(`Duplicate entrant '${id}'.`);
      this.entrants.set(id, { id, roundReached: 1, eliminated: false, eliminationSeq: 0, champion: false, tableId: -1 });
      this.entrantOrder.push(id);
    }

    this.format = RoundPlanner.formatFor(this.entrantOrder.length);
    this.tablesPerRound = RoundPlanner.tablesPerRound(this.format);
    this.closedPerRound = this.tablesPerRound.map(() => 0);
    this.waiting = this.tablesPerRound.map(() => []);
  }

  get roundCount(): number {
    return this.tablesPerRound.length;
  }
  get entrantCount(): number {
    return this.entrantOrder.length;
  }
  get isFinished(): boolean {
    return this._isFinished;
  }
  get championId(): string | null {
    return this._championId;
  }

  // ---- Calls from the server ----------------------------------------

  /** The start time has come: draw Round 1, or cancel if there are too few players. */
  start(nowMs: number): TournamentCommand[] {
    if (this.started) throw new InvalidOperationError('The tournament has already started.');
    this.started = true;
    const commands: TournamentCommand[] = [];

    if (this.format === TournamentFormat.Cancelled) {
      this._isFinished = true;
      commands.push({
        kind: 'TournamentCancelled',
        reason: `Only ${this.entrantOrder.length} registered; at least ${TournamentRules.MinEntrants} are needed.`,
      });
      return commands;
    }

    const tables = RoundPlanner.drawFirstRound(this.entrantOrder, this.tablesPerRound[0]!, this.rng);
    for (const seats of tables) this.openTable(0, seats, nowMs + TournamentRules.FirstDealDelayMs, nowMs, commands);
    return commands;
  }

  /** Announces level changes on playing tables. Call it often; it is cheap. */
  tick(nowMs: number): TournamentCommand[] {
    const commands: TournamentCommand[] = [];
    for (const t of this.tables) {
      if (t.closed || !t.clock.isStarted) continue;
      const level = t.clock.levelAt(nowMs);
      if (level <= t.announcedLevel) continue;
      t.announcedLevel = level;
      commands.push({ kind: 'BlindsUp', tableId: t.id, blinds: BlindSchedule.forLevel(level) });
    }
    return commands;
  }

  /** True once the table's countdown is over and it still has a game to play. */
  canDeal(tableId: number, nowMs: number): boolean {
    if (this._isFinished || tableId < 0 || tableId >= this.tables.length) return false;
    const t = this.tables[tableId]!;
    return !t.closed && nowMs >= t.dealAtMs && t.players.length >= 2;
  }

  /** The blinds for the hand about to be dealt. The table's first call starts its clock. */
  blindsForNextHand(tableId: number, nowMs: number): BlindLevel {
    const t = this.openTableById(tableId);
    if (nowMs < t.dealAtMs) throw new InvalidOperationError(`Table ${tableId} is still counting down.`);
    if (t.players.length < 2) throw new InvalidOperationError(`Table ${tableId} has nobody left to play.`);
    if (!t.clock.isStarted) {
      t.clock.start(nowMs);
      t.announcedLevel = 1;
    }
    return BlindSchedule.forLevel(t.clock.levelAt(nowMs));
  }

  /**
   * A hand finished at `tableId`. `results` holds every player dealt in, with their stack before the blinds and
   * after the pot was paid.
   */
  reportHand(tableId: number, results: readonly SeatResult[], nowMs: number): TournamentCommand[] {
    const t = this.openTableById(tableId);
    if (!t.clock.isStarted) throw new InvalidOperationError(`Table ${tableId} hasn't dealt a hand.`);
    validateResults(t, results);

    const commands: TournamentCommand[] = [];
    const outcome = TableReferee.resolve(t.isFinal ? TableStage.Final : TableStage.Qualifier, results, this.rng);

    if (outcome.draws.length > 0) commands.push({ kind: 'HighCardDraw', tableId: t.id, cards: outcome.draws });

    if (outcome.eliminatedWorstFirst.length > 0) {
      for (const id of outcome.eliminatedWorstFirst) {
        const e = this.entrants.get(id)!;
        e.eliminated = true;
        e.eliminationSeq = ++this.eliminationSeq;
        e.tableId = -1;
        const at = t.players.indexOf(id);
        if (at >= 0) t.players.splice(at, 1);
      }
      commands.push({ kind: 'PlayersEliminated', tableId: t.id, round: t.roundIndex + 1, entrantIds: outcome.eliminatedWorstFirst });
    }

    if (t.isFinal) {
      if (outcome.champion !== null) this.finish(t, outcome.champion, commands);
      return commands;
    }

    if (outcome.tableClosed) this.closeQualifier(t, outcome.remaining, nowMs, commands);
    this.checkSpeedUps(nowMs, commands);
    return commands;
  }

  // ---- Queries ----------------------------------------------------------

  /** C# `StateOf(id, out tableId)`. */
  stateOf(entrantId: string): { state: EntrantState; tableId: number } {
    const e = this.entrants.get(entrantId);
    if (!e) throw new ArgumentError(`Unknown entrant '${entrantId}'.`);
    const state = e.champion ? EntrantState.Champion : e.eliminated ? EntrantState.Eliminated : e.tableId >= 0 ? EntrantState.Seated : EntrantState.Waiting;
    return { state, tableId: e.tableId };
  }

  playersAt(tableId: number): readonly string[] {
    if (tableId < 0 || tableId >= this.tables.length) throw new ArgumentOutOfRangeError(`tableId: ${tableId}`);
    return this.tables[tableId]!.players;
  }

  snapshot(nowMs: number): TournamentSnapshot {
    const tables: TournamentTableSummary[] = this.tables.map((t) => ({
      tableId: t.id,
      round: t.roundIndex + 1,
      isFinal: t.isFinal,
      isClosed: t.closed,
      playersLeft: t.players.length,
      isDealing: t.clock.isStarted,
      dealAtMs: t.dealAtMs,
      blinds: BlindSchedule.forLevel(t.clock.levelAt(nowMs)),
      msToNextLevel: t.clock.msToNextLevel(nowMs),
      isSpedUp: t.clock.isSpedUp,
    }));
    let remaining = 0;
    for (const e of this.entrants.values()) if (!e.eliminated) remaining++;
    return { entrants: this.entrantOrder.length, playersRemaining: remaining, isFinished: this._isFinished, tables };
  }

  // ---- Internals --------------------------------------------------------

  private openTable(roundIndex: number, seats: SeatAssignment[], dealAtMs: number, nowMs: number, commands: TournamentCommand[]): void {
    const t: Table = {
      id: this.tables.length,
      roundIndex,
      isFinal: roundIndex === this.tablesPerRound.length - 1,
      players: [],
      clock: new TableClock(this.levelMs),
      dealAtMs,
      closed: false,
      announcedLevel: 0,
    };
    for (const s of seats) {
      t.players.push(s.entrantId);
      const e = this.entrants.get(s.entrantId)!;
      e.tableId = t.id;
      e.roundReached = roundIndex + 1;
    }
    this.tables.push(t);

    commands.push({
      kind: 'TableOpened',
      tableId: t.id,
      round: roundIndex + 1,
      isFinal: t.isFinal,
      seats,
      startingStack: TournamentRules.StartingStack,
      dealAtMs,
    });

    // A table can open with players already waiting on it (Round 2's second table after the first has finished),
    // in which case it plays fast levels from its first hand.
    this.checkSpeedUps(nowMs, commands);
  }

  private closeQualifier(t: Table, survivors: readonly string[], nowMs: number, commands: TournamentCommand[]): void {
    t.closed = true;
    this.closedPerRound[t.roundIndex]!++;
    t.players.length = 0;

    const group = [...survivors];
    for (const id of group) {
      const e = this.entrants.get(id)!;
      e.tableId = -1;
      e.roundReached = t.roundIndex + 2;
    }
    commands.push({ kind: 'TableClosed', tableId: t.id, survivors: group });

    // Pair finished tables in the order they finish: every two groups make one next-round table.
    const next = t.roundIndex + 1;
    const queue = this.waiting[next]!;
    queue.push(group);
    const groupsPerTable = Math.trunc(this.tablesPerRound[t.roundIndex]! / this.tablesPerRound[next]!);
    if (queue.length < groupsPerTable) return;

    const groups: string[][] = queue.splice(0, groupsPerTable);
    this.openTable(next, RoundPlanner.drawNextRound(groups, this.rng), nowMs + TournamentRules.NextTableCountdownMs, nowMs, commands);
  }

  private finish(t: Table, championId: string, commands: TournamentCommand[]): void {
    t.closed = true;
    this.closedPerRound[t.roundIndex]!++;
    t.players.length = 0;

    const champion = this.entrants.get(championId)!;
    champion.champion = true;
    champion.tableId = -1;
    this._championId = championId;
    this._isFinished = true;

    commands.push({ kind: 'TournamentFinished', championId, standings: this.computeStandings() });
  }

  /**
   * The last table still playing in a round speeds up once a finished group is waiting on it. A table that hasn't
   * opened yet is picked up when it does.
   */
  private checkSpeedUps(nowMs: number, commands: TournamentCommand[]): void {
    for (let r = 0; r < this.tablesPerRound.length - 1; r++) {
      if (this.tablesPerRound[r]! < 2) continue;
      if (this.tablesPerRound[r]! - this.closedPerRound[r]! !== 1) continue;
      if (this.waiting[r + 1]!.length === 0) continue;
      for (const t of this.tables) {
        if (t.roundIndex !== r || t.closed || t.clock.isSpedUp) continue;
        t.clock.enableSpeedUp(nowMs);
        commands.push({ kind: 'SpeedUpStarted', tableId: t.id });
      }
    }
  }

  /** Champion first, then everyone by the round they reached, and within a round the later elimination finishes higher. */
  private computeStandings(): TournamentStanding[] {
    const all = dotnetSort([...this.entrants.values()], (a, b) => {
      if (a.champion !== b.champion) return a.champion ? -1 : 1;
      if (a.roundReached !== b.roundReached) return compareNum(b.roundReached, a.roundReached);
      return compareNum(b.eliminationSeq, a.eliminationSeq);
    });
    return all.map((e, i) => Object.freeze({ entrantId: e.id, place: i + 1, roundReached: e.roundReached, isChampion: e.champion }));
  }

  private openTableById(tableId: number): Table {
    if (this._isFinished) throw new InvalidOperationError('The tournament is over.');
    if (tableId < 0 || tableId >= this.tables.length) throw new InvalidOperationError(`Unknown table ${tableId}.`);
    const t = this.tables[tableId]!;
    if (t.closed) throw new InvalidOperationError(`Table ${tableId} is closed.`);
    return t;
  }
}

function validateResults(t: Table, results: readonly SeatResult[]): void {
  if (!results) throw new TypeError('results is required.');
  if (results.length !== t.players.length)
    throw new ArgumentError(`Table ${t.id} has ${t.players.length} players but ${results.length} results were reported.`);
  const seen = new Set<string>();
  let before = 0;
  let after = 0;
  for (const r of results) {
    if (!t.players.includes(r.entrantId)) throw new ArgumentError(`${r.entrantId} is not playing at table ${t.id}.`);
    if (seen.has(r.entrantId)) throw new ArgumentError(`${r.entrantId} was reported twice.`);
    seen.add(r.entrantId);
    before += r.startStack;
    after += r.endStack;
  }
  if (before !== after) throw new ArgumentError(`Table ${t.id} chips not conserved: ${before} before the hand, ${after} after.`);
}
