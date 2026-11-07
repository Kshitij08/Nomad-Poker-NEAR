import type { BlindLevel } from './blindSchedule';

/** Port of Core/Tournament/TournamentSnapshot.cs. */
export enum EntrantState {
  /** At a table that is playing or counting down. */
  Seated = 0,
  /** Through to the next round; their table isn't ready yet. */
  Waiting = 1,
  Eliminated = 2,
  Champion = 3,
}

/** One table as the HUD and the backend progress report see it. */
export interface TournamentTableSummary {
  tableId: number;
  round: number;
  isFinal: boolean;
  isClosed: boolean;
  playersLeft: number;
  /** False while the table counts down to its first hand. */
  isDealing: boolean;
  dealAtMs: number;
  blinds: BlindLevel;
  msToNextLevel: number;
  isSpedUp: boolean;
}

export interface TournamentSnapshot {
  entrants: number;
  playersRemaining: number;
  isFinished: boolean;
  tables: TournamentTableSummary[];
}
