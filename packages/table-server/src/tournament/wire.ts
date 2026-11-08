/**
 * The contract between the tournament runtime (TournamentServerGame / TournamentTableRunner ports) and whatever
 * carries its events: the in-browser practice loop (offline) or the local WebSocket table server (web/server).
 * No DOM, no Node APIs — both sides import this.
 */
import type { IRandom } from '@nomad/engine/cards/random';
import type { WireEvent } from '@nomad/engine/events/pokerEventCodec';

/** Everything a tournament player can receive (encoded by PokerEventCodec on the WebSocket server). */
export type { WireEvent };

/** PokerEventCodec.OutOfBandSequence: catch-up and per-player tournament events sit outside a table's numbering. */
export const OUT_OF_BAND = -1;

/** A connection. Fusion's PlayerRef in Unity; the WebSocket server's connection id here. */
export type PlayerRef = number;


/** How the runtime reaches players. Unity: PokerTableNet.SendEventTo / Runner.Disconnect. */
export interface TournamentTransport {
  /** Deliver one event to one connection, with the table's sequence number or OUT_OF_BAND. */
  sendEventTo(player: PlayerRef, sequence: number, event: WireEvent): void;
  /** Turn a connection away (not in this tournament). */
  disconnect(player: PlayerRef): void;
  /** The tournament is over and the quit delay has passed (a dedicated server process exits). Optional. */
  quit?(): void;
}

/** Time and randomness, injected so the browser runs on the animation ticker and Node on real time / tests on fake. */
export interface RuntimeTiming {
  /** A monotonic millisecond clock (Unity: Stopwatch.ElapsedMilliseconds). */
  nowMs(): number;
  /** Resolves after `seconds` (or immediately once `signal` aborts). */
  wait(seconds: number, signal: AbortSignal): Promise<void>;
  /** Uniform [0,1) for bot think times (Unity: UnityEngine.Random). */
  random(): number;
  /** A deck/draw RNG (Unity: new CryptoRandom()). */
  makeRandom(): IRandom;
}

/** The pacing TableSettings gives the table (TournamentServerGame.TurnSeconds, DealDelay, ...). Seconds. */
export interface TournamentPacing {
  turnTimer: number;
  dealDelay: number;
  dealSettleDelay: number;
  actionDelay: number;
  showdownDelay: number;
  betweenHands: number;
}

// ---- The backend's /internal/tournaments/:id API (TournamentBackendClient's types) -------------------------

export interface RosterEntrant {
  playFabId: string;
  displayName: string;
}

export interface TournamentRoster {
  serverNowUnix: number;
  tournamentId: string;
  name: string;
  hostPlayFabId: string;
  status: string;
  sessionName: string;
  speed: string;
  startsAtUnix: number;
  rosterFrozen: boolean;
  firstPrize: number;
  secondPrize: number;
  entrants: RosterEntrant[] | null;
}

export interface VerifiedPlayer {
  ok: boolean;
  playFabId: string;
  displayName: string;
  entrant: boolean;
  host: boolean;
  error: string;
  code: string;
}

export interface StandingBody {
  playFabId: string;
  place: number;
  roundReached: number;
}

/** What a hosted (non-practice) tournament needs from the backend. Every call resolves; failures are null/false/0. */
export interface TournamentBackend {
  getRoster(): Promise<TournamentRoster | null>;
  verify(sessionTicket: string): Promise<VerifiedPlayer>;
  ready(ok: boolean, error: string): Promise<boolean>;
  started(): Promise<boolean>;
  progress(seq: number, playersRemaining: number, tablesOpen: number, phase: string): Promise<boolean>;
  /** The HTTP status: 200 recorded, 409 already different, 0 unreachable. */
  postResult(championId: string, standings: StandingBody[]): Promise<number>;
}
