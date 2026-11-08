import type { TournamentResultEvent, TournamentStatusEvent, TournamentViewEvent } from '@nomad/engine/tournament';

/**
 * The client's picture of the tournament it is playing: the latest status, what it is looking at, and its result.
 * Whatever client mirrors a tournament table (the offline practice client here, or the network client) feeds it from
 * the server's tournament events; the table overlay reads it. Cleared when the player leaves the tournament's
 * session. Port of Net/Tournament/TournamentClientState.cs (a static class there; one shared instance here).
 *
 * Network client contract: call `begin(sessionName)` when joining a TRN… session, route TournamentStatus /
 * TournamentView / TournamentResult events to onStatus / onView / onResult, set `watchHandler` to send the
 * "watch table" request (PokerClientGame.RequestTournamentWatch), set `leaveHandler`, and `clear()` on leaving.
 */
export class TournamentClientState {
  status: TournamentStatusEvent | null = null;
  view: TournamentViewEvent | null = null;
  result: TournamentResultEvent | null = null;
  /** The session these belong to, so a stale picture never shows at the next tournament. */
  session: string | null = null;
  /** Sends "watch this table" (-1 stops watching) to whichever server runs the tournament. */
  watchHandler: ((tableId: number) => void) | null = null;
  /** Leaves the tournament's table ("Back to lobby"). */
  leaveHandler: (() => void) | null = null;

  private readonly listeners = new Set<() => void>();
  private readonly xpPaid = new Set<string>();

  get active(): boolean {
    return this.status !== null || this.view !== null;
  }

  onChanged(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of [...this.listeners]) fn();
  }

  begin(session: string | null): void {
    if (this.session === session) return;
    this.session = session;
    this.status = null;
    this.view = null;
    this.result = null;
    this.changed();
  }

  clear(): void {
    this.watchHandler = null;
    this.leaveHandler = null;
    this.begin(null);
  }

  onStatus(e: TournamentStatusEvent): void {
    this.status = e;
    this.changed();
  }

  onView(e: TournamentViewEvent): void {
    this.view = e;
    this.changed();
  }

  onResult(e: TournamentResultEvent): void {
    // A knockout result is replaced by the final standings, never the other way round.
    if (this.result && this.result.finished && !e.finished) return;
    this.result = e;
    this.changed();
  }

  /** True the first time this session's XP for this kind of result is claimed. */
  tryClaimXp(session: string | null, finished: boolean): boolean {
    const key = `${session}|${finished ? 'final' : 'out'}`;
    if (this.xpPaid.has(key)) return false;
    this.xpPaid.add(key);
    return true;
  }

  requestWatch(tableId: number): void {
    this.watchHandler?.(tableId);
  }
}

export const tournamentClientState = new TournamentClientState();
