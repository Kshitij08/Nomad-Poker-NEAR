import type { BlindLevel } from './blindSchedule';
import type { DrawnCard } from './highCardDraw';
import type { SeatAssignment } from './roundPlanner';

/**
 * What TournamentDirector tells the server to do. The director only decides; the server owns the engines and the
 * network and carries each command out in the order given. Port of Core/Tournament/TournamentCommand.cs: the C#
 * class hierarchy becomes a union discriminated on `kind` (the class name without "Command").
 */
export type TournamentCommand =
  | TableOpenedCommand
  | BlindsUpCommand
  | SpeedUpStartedCommand
  | HighCardDrawCommand
  | PlayersEliminatedCommand
  | TableClosedCommand
  | TournamentFinishedCommand
  | TournamentCancelledCommand;

/** Seat these players with fresh stacks and deal the table's first hand at `dealAtMs`. */
export interface TableOpenedCommand {
  readonly kind: 'TableOpened';
  tableId: number;
  /** 1-based round. The last round is the final. */
  round: number;
  isFinal: boolean;
  seats: readonly SeatAssignment[];
  startingStack: number;
  dealAtMs: number;
}

/** A table's clock moved to a new level. The new blinds apply from its next hand. */
export interface BlindsUpCommand {
  readonly kind: 'BlindsUp';
  tableId: number;
  blinds: BlindLevel;
}

/** Players are waiting on this table, so its levels now run at half length. */
export interface SpeedUpStartedCommand {
  readonly kind: 'SpeedUpStarted';
  tableId: number;
}

/** A high card settled equal stacks. Shown to the table before the result it decided. */
export interface HighCardDrawCommand {
  readonly kind: 'HighCardDraw';
  tableId: number;
  /** Best card first. */
  cards: readonly DrawnCard[];
}

/** These players are out of the tournament. Take them off the table. */
export interface PlayersEliminatedCommand {
  readonly kind: 'PlayersEliminated';
  tableId: number;
  round: number;
  /** Worst finish first. */
  entrantIds: readonly string[];
}

/** A qualifier is down to two. They wait for the next round; close the table. */
export interface TableClosedCommand {
  readonly kind: 'TableClosed';
  tableId: number;
  survivors: readonly string[];
}

/** Port of the TournamentStanding struct. */
export interface TournamentStanding {
  readonly entrantId: string;
  readonly place: number;
  /** 1-based round the player reached; the final is the last round. */
  readonly roundReached: number;
  readonly isChampion: boolean;
}

/** Rounds the player got through (what round XP is paid on). */
export const roundsPassed = (s: TournamentStanding): number => s.roundReached - 1;

/** One player holds every chip at the final. Places run 1..N. */
export interface TournamentFinishedCommand {
  readonly kind: 'TournamentFinished';
  championId: string;
  /** Best place first. */
  standings: readonly TournamentStanding[];
}

/** Too few players at the start time. Nothing is dealt; the backend refunds. */
export interface TournamentCancelledCommand {
  readonly kind: 'TournamentCancelled';
  reason: string;
}
