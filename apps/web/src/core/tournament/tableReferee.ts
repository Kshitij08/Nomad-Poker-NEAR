import type { IRandom } from '../cards/random';
import { ArgumentError } from './errors';
import { compareNum, dotnetSort } from './dotnetSort';
import { HighCardDraw, type DrawnCard } from './highCardDraw';
import { TournamentRules } from './tournamentRules';

export enum TableStage {
  /** A Round 1 or Round 2 table: stops when two are left. */
  Qualifier = 0,
  /** The final (or the only table): plays down to one winner. */
  Final = 1,
}

/** One player's chips either side of a hand. The server reads them off the engine. */
export interface SeatResult {
  readonly entrantId: string;
  readonly startStack: number;
  readonly endStack: number;
}

export const seatResult = (entrantId: string, startStack: number, endStack: number): SeatResult =>
  Object.freeze({ entrantId, startStack, endStack });

/** What a finished hand means for the table. */
export interface TableHandOutcome {
  /** Players out this hand, worst finish first. */
  eliminatedWorstFirst: string[];
  /** Players still at the table — or, when a qualifier closes, the two who go through. */
  remaining: string[];
  /** A qualifier got down to two (or fewer, topped up from this hand's busts). */
  tableClosed: boolean;
  /** The final's winner, once one player holds every chip. */
  champion: string | null;
  /** High-card draws used to break equal start stacks, if any. */
  draws: DrawnCard[];
}

/**
 * The table-level rules: who is out after a hand, in what order, and who goes through. Several players busting on
 * one hand finish in order of the chips they started that hand with (more chips, better finish); equal stacks go to
 * a high-card draw. Port of Core/Tournament/TableReferee.cs.
 */
export const TableReferee = {
  resolve(stage: TableStage, results: readonly SeatResult[], rng: IRandom): TableHandOutcome {
    if (!results) throw new TypeError('results is required.');
    if (!rng) throw new TypeError('rng is required.');

    const alive: string[] = [];
    const busted: SeatResult[] = [];
    for (const r of results) {
      if (r.startStack <= 0) throw new ArgumentError(`${r.entrantId} was dealt in with no chips.`);
      if (r.endStack < 0) throw new ArgumentError(`${r.entrantId} ended with a negative stack.`);
      if (r.endStack > 0) alive.push(r.entrantId);
      else busted.push(r);
    }
    if (alive.length === 0) throw new ArgumentError('Every player ended the hand with no chips.');

    const draws: DrawnCard[] = [];
    const worstFirst = orderBusts(busted, rng, draws);

    if (stage === TableStage.Final) {
      return {
        eliminatedWorstFirst: worstFirst,
        remaining: alive,
        champion: alive.length === 1 ? alive[0]! : null,
        tableClosed: alive.length === 1,
        draws,
      };
    }

    const survivors = TournamentRules.SurvivorsPerTable;
    if (alive.length > survivors) {
      return { eliminatedWorstFirst: worstFirst, remaining: alive, tableClosed: false, champion: null, draws };
    }

    // Down to two (or fewer): the table is done. Short of two, the best of this hand's busts goes through too.
    const topUp = Math.min(survivors - alive.length, worstFirst.length);
    const through = [...alive];
    for (let i = 0; i < topUp; i++) through.push(worstFirst[worstFirst.length - 1 - i]!);
    return {
      eliminatedWorstFirst: worstFirst.slice(0, worstFirst.length - topUp),
      remaining: through,
      tableClosed: true,
      champion: null,
      draws,
    };
  },
} as const;

/** Same-hand busts, worst finish first: smaller start stack first, ties by high card. */
function orderBusts(busted: SeatResult[], rng: IRandom, draws: DrawnCard[]): string[] {
  dotnetSort(busted, (a, b) => compareNum(a.startStack, b.startStack));
  const order: string[] = [];
  let i = 0;
  while (i < busted.length) {
    let j = i + 1;
    while (j < busted.length && busted[j]!.startStack === busted[i]!.startStack) j++;
    if (j - i === 1) {
      order.push(busted[i]!.entrantId);
    } else {
      const tied: string[] = [];
      for (let k = i; k < j; k++) tied.push(busted[k]!.entrantId);
      const bestFirst = HighCardDraw.draw(tied, rng);
      draws.push(...bestFirst);
      for (let k = bestFirst.length - 1; k >= 0; k--) order.push(bestFirst[k]!.entrantId);
    }
    i = j;
  }
  return order;
}
