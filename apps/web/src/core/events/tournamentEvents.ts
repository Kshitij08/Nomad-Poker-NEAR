/**
 * Port of Core/Events/TournamentEvents.cs: the three tournament payloads the cash-table codec also carries
 * (wire types 19–21). Typed here, next to the codec, so the server and every client decode them the same way.
 */

/** What a tournament player is doing right now, as the HUD shows it. */
export enum TournamentPlayerState {
  Seated = 0,
  Waiting = 1,
  Eliminated = 2,
  Champion = 3,
  /** Not in this tournament — railing it. */
  Spectator = 4,
}

export enum TournamentPhase {
  /** Players are arriving; the start time hasn't come. */
  BeforeStart = 0,
  Running = 1,
  Finished = 2,
  /** Cancelled or aborted: nothing more will be dealt and the backend refunds. */
  Cancelled = 3,
}

/** One table, as the tournament HUD lists it. */
export interface TournamentTableLine {
  tableId: number;
  round: number;
  isFinal: boolean;
  isClosed: boolean;
  isDealing: boolean;
  isSpedUp: boolean;
  playersLeft: number;
  level: number;
  smallBlind: number;
  bigBlind: number;
  secondsToNextLevel: number;
  /** Countdown to the table's first hand; 0 once it is dealing. */
  dealInSeconds: number;
}

/** The tournament as one player sees it (per recipient, outside the table sequence, about once a second). */
export interface TournamentStatusEvent {
  readonly type: 'TournamentStatus';
  name: string;
  phase: TournamentPhase;
  myState: TournamentPlayerState;
  /** -1 when not seated. */
  myTableId: number;
  entrants: number;
  playersRemaining: number;
  /** Seconds until the start time, while phase is BeforeStart. */
  startsInSeconds: number;
  firstPrize: number;
  secondPrize: number;
  tables: TournamentTableLine[];
}

export enum TournamentViewReason {
  /** The first table of the tournament. */
  Seated = 0,
  /** A new round's table. */
  Moved = 1,
  /** Watching a table you don't play at. */
  Watching = 2,
  /** Through to the next round; no table yet. */
  Waiting = 3,
  /** The start time hasn't come. */
  BeforeStart = 4,
}

/** "You are now looking at this table." The client clears the felt and its event sequence when it arrives. */
export interface TournamentViewEvent {
  readonly type: 'TournamentView';
  /** -1 when there is no table to show (waiting, or before the start). */
  tableId: number;
  round: number;
  isFinal: boolean;
  /** Your chair at this table, or -1 when watching. */
  yourSeat: number;
  countdownSeconds: number;
  reason: TournamentViewReason;
}

/** A player's own result: knocked out (finished false) or the final standings (finished true). */
export interface TournamentResultEvent {
  readonly type: 'TournamentResult';
  finished: boolean;
  youWon: boolean;
  /** Your place once the tournament is over; 0 while it is still being played. */
  yourPlace: number;
  /** The round you went out in (or reached). */
  yourRound: number;
  entrants: number;
  xpEarned: number;
  yourPrize: number;
  championName: string;
  runnerUpName: string;
  firstPrize: number;
  secondPrize: number;
}

export type TournamentEvent = TournamentStatusEvent | TournamentViewEvent | TournamentResultEvent;
