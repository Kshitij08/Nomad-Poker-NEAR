/**
 * Hooks tournaments into the local table server. Call once after startPokerServer():
 *
 *   import { registerTournaments } from '../tournament';
 *   registerTournaments(server, { clock });
 *
 * Sessions it hosts (TournamentLaunch.IsTournamentSession: names starting "TRN"):
 * - `TRNDEV` + digits, e.g. `TRNDEV08`: an offline dev tournament for that many players (2..30, default 8). People who
 *   join within 10 s of the first one play; bots fill the rest (Unity: -tournamentDev n, the TRNDEV… session).
 * - any other `TRN…` session: a hosted tournament, only when POKER_TOURNAMENT_BACKEND_URL is configured and
 *   `tournamentIdFor(session)` resolves it (the backend's claim-spawn hands a spawner the id). Off by default.
 */
import type { ServerClock } from '../src/clock';
import type { IPokerTableServer } from '../src/tableNet';
import { TournamentBackendClient } from './tournamentBackendClient';
import { TournamentTableServer } from './tournamentTableServer';

/** The slice of PokerServer this needs (server/src/server.ts). */
export interface TournamentServerHost {
  registerServer(match: (session: string) => boolean, create: (spec: { name: string }) => IPokerTableServer): void;
}

export interface RegisterTournamentsOptions {
  clock: ServerClock;
  log?: (message: string) => void;
  /** Live tournaments (backend). Defaults read POKER_TOURNAMENT_BACKEND_URL / POKER_INTERNAL_API_KEY; unset = off. */
  backendUrl?: string;
  apiKey?: string;
  /** Maps a TRN… session to its backend tournament id (null: not one of ours). */
  tournamentIdFor?: (session: string) => string | null;
  devFillWaitSeconds?: number;
}

const DEV_PATTERN = /^TRNDEV(\d{0,4})$/;

export function devPlayersFor(session: string): number | null {
  const m = DEV_PATTERN.exec(session);
  if (!m) return null;
  const n = m[1] ? Number.parseInt(m[1], 10) : 8;
  return Math.max(2, Math.min(30, n || 8));
}

export function registerTournaments(server: TournamentServerHost, opts: RegisterTournamentsOptions): void {
  const env = typeof process !== 'undefined' ? process.env : {};
  const backendUrl = opts.backendUrl ?? env.POKER_TOURNAMENT_BACKEND_URL ?? '';
  const apiKey = opts.apiKey ?? env.POKER_INTERNAL_API_KEY ?? '';
  const log = opts.log ?? ((m: string) => console.log(m));

  server.registerServer(
    (session) => {
      if (devPlayersFor(session) !== null) return true;
      return !!backendUrl && session.startsWith('TRN') && !!opts.tournamentIdFor?.(session);
    },
    (spec) => {
      const session = spec.name;
      const dev = devPlayersFor(session);
      if (dev !== null) return new TournamentTableServer({ clock: opts.clock, devPlayers: dev, devFillWaitSeconds: opts.devFillWaitSeconds, log });
      const id = opts.tournamentIdFor!(session)!;
      return new TournamentTableServer({ clock: opts.clock, backend: new TournamentBackendClient(id, backendUrl, apiKey, log), log });
    },
  );
}

export { TournamentTableServer } from './tournamentTableServer';
export { TournamentBackendClient } from './tournamentBackendClient';
