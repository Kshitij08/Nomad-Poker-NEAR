import type { IRandom } from '../cards/random';
import { ArgumentOutOfRangeError } from '../errors';
import { TournamentRules } from './tournamentRules';

export enum TournamentFormat {
  /** 0–1 registered: nothing to play. */
  Cancelled = 0,
  /** 2–7: one table, straight to heads-up. */
  SingleTable = 1,
  /** 8–15: two Round 1 tables, then the final. */
  TwoTables = 2,
  /** 16–30: four Round 1 tables, two Round 2 tables, then the final. */
  FourTables = 3,
}

/** Port of the SeatAssignment struct. */
export interface SeatAssignment {
  readonly entrantId: string;
  readonly seat: number;
}

/** How many tables each round has, and who sits where. Port of Core/Tournament/RoundPlanner.cs. */
export const RoundPlanner = {
  formatFor(entrants: number): TournamentFormat {
    if (entrants > TournamentRules.MaxEntrants)
      throw new ArgumentOutOfRangeError(`entrants: ${entrants}. At most ${TournamentRules.MaxEntrants} players.`);
    if (entrants < TournamentRules.MinEntrants) return TournamentFormat.Cancelled;
    if (entrants <= TournamentRules.SingleTableMaxEntrants) return TournamentFormat.SingleTable;
    if (entrants <= TournamentRules.TwoTableMaxEntrants) return TournamentFormat.TwoTables;
    return TournamentFormat.FourTables;
  },

  /** Tables in each round, first round first. The last round is always the one final table. */
  tablesPerRound(format: TournamentFormat): number[] {
    switch (format) {
      case TournamentFormat.Cancelled: return [];
      case TournamentFormat.SingleTable: return [1];
      case TournamentFormat.TwoTables: return [2, 1];
      case TournamentFormat.FourTables: return [4, 2, 1];
      default: throw new ArgumentOutOfRangeError(`format: ${String(format)}`);
    }
  },

  /** Table sizes for `players` over `tables`, never more than one apart, bigger tables first. */
  splitSeats(players: number, tables: number): number[] {
    if (tables < 1) throw new ArgumentOutOfRangeError(`tables: ${tables}. Need at least one table.`);
    if (players < 0) throw new ArgumentOutOfRangeError(`players: ${players}`);
    const sizes: number[] = [];
    for (let i = 0; i < tables; i++) sizes.push(Math.trunc(players / tables) + (i < players % tables ? 1 : 0));
    return sizes;
  },

  /** Seat indices for `players` people at a table of `seatCount` chairs, spread round the table. */
  spreadSeats(players: number, seatCount: number): number[] {
    if (players < 0 || players > seatCount)
      throw new ArgumentOutOfRangeError(`players: ${players}. 0..${seatCount} players fit.`);
    const seats: number[] = [];
    for (let i = 0; i < players; i++) seats.push(Math.trunc((i * seatCount) / players));
    return seats;
  },

  /** The opening draw: shuffles everyone and deals them round-robin into `tables` tables. */
  drawFirstRound(entrantIds: readonly string[], tables: number, rng: IRandom): SeatAssignment[][] {
    if (!entrantIds) throw new TypeError('entrantIds is required.');
    if (!rng) throw new TypeError('rng is required.');
    const order = [...entrantIds];
    shuffle(order, rng);
    const groups: string[][] = [];
    for (let t = 0; t < tables; t++) groups.push([]);
    for (let i = 0; i < order.length; i++) groups[i % tables]!.push(order[i]!);
    return groups.map(seat);
  },

  /**
   * A next-round table from finished tables' survivors. Each group is shuffled, then the groups are interleaved
   * (A, B, A, B) so two players from the same table never sit side by side, and the whole table is turned a random
   * amount so nobody can predict their chair.
   */
  drawNextRound(groups: readonly (readonly string[])[], rng: IRandom): SeatAssignment[] {
    if (!groups) throw new TypeError('groups is required.');
    if (!rng) throw new TypeError('rng is required.');
    const shuffled: string[][] = [];
    for (const g of groups) {
      const copy = [...g];
      shuffle(copy, rng);
      shuffled.push(copy);
    }
    shuffle(shuffled, rng); // which table's players go first

    const order: string[] = [];
    for (let i = 0; ; i++) {
      let any = false;
      for (const g of shuffled) {
        if (i >= g.length) continue;
        order.push(g[i]!);
        any = true;
      }
      if (!any) break;
    }
    if (order.length === 0) return [];
    const turn = rng.next(order.length);
    const rotated: string[] = [];
    for (let i = 0; i < order.length; i++) rotated.push(order[(i + turn) % order.length]!);
    return seat(rotated);
  },
} as const;

function seat(playersInOrder: readonly string[]): SeatAssignment[] {
  const seats = RoundPlanner.spreadSeats(playersInOrder.length, TournamentRules.SeatsPerTable);
  return playersInOrder.map((entrantId, i) => Object.freeze({ entrantId, seat: seats[i]! }));
}

function shuffle<T>(list: T[], rng: IRandom): void {
  for (let i = list.length - 1; i > 0; i--) {
    const j = rng.next(i + 1);
    const t = list[i]!;
    list[i] = list[j]!;
    list[j] = t;
  }
}
