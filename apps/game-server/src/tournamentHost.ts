import { heartbeat, markStarted, postResult, roster, verifyEntrant } from '@nomad/db/tournaments';
import type { ServerClock } from '@nomad/table-server/clock';
import { Room, type RoomSpec } from '@nomad/table-server/rooms';
import { TournamentTableServer } from '@nomad/table-server/tournament/tournamentTableServer';
import type { StandingBody, TournamentBackend, TournamentPacing, TournamentRoster, VerifiedPlayer } from '@nomad/table-server/tournament/wire';
import { RoomHost, type LogFn } from './roomHost';

/**
 * The tournament room's side of the tournament records, straight on D1 (it was the backend's /internal/tournaments/:id
 * routes, called with an internal API key). Every call resolves; a failure is null / false / 0 and the runtime retries.
 */
export class D1TournamentBackend implements TournamentBackend {
  constructor(private readonly db: D1Database, readonly tournamentId: string, private readonly log: LogFn) {}

  private async attempt<T>(what: string, fn: () => Promise<T>, failed: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.log('warn', `[Tournament] ${what} failed: ${(e as Error).message}`);
      return failed;
    }
  }

  getRoster(): Promise<TournamentRoster | null> {
    return this.attempt('roster', () => roster(this.db, this.tournamentId), null);
  }

  verify(sessionTicket: string): Promise<VerifiedPlayer> {
    return this.attempt('verify', () => verifyEntrant(this.db, this.tournamentId, sessionTicket), {
      ok: false, playFabId: '', displayName: '', entrant: false, host: false, error: 'The tournament service did not answer.', code: '',
    });
  }

  async ready(): Promise<boolean> {
    return true; // the room is the server: it is ready when it is open
  }

  started(): Promise<boolean> {
    return this.attempt('started', () => markStarted(this.db, this.tournamentId), false);
  }

  progress(seq: number, playersRemaining: number, tablesOpen: number, phase: string): Promise<boolean> {
    return this.attempt('progress', () => heartbeat(this.db, this.tournamentId, seq, { playersRemaining, tablesOpen, phase }), false);
  }

  postResult(championId: string, standings: StandingBody[]): Promise<number> {
    return this.attempt('result', async () => {
      const r = await postResult(this.db, this.tournamentId, { championId, standings });
      if (r.error) this.log('warn', `[Tournament] result refused (${r.status}): ${r.error}`);
      return r.status;
    }, 0);
  }
}

export interface TournamentHostOptions {
  spec: RoomSpec;
  db: D1Database;
  tournamentId: string;
  clock: ServerClock;
  log: LogFn;
  pacing?: Partial<TournamentPacing>;
}

/**
 * One hosted tournament: every table of it runs inside this one room (TournamentServerGame), from the roster on D1 to
 * the standings it posts back, which pay the prizes. The room stays open until the tournament is over.
 */
export class TournamentHost extends RoomHost {
  readonly room: Room;
  readonly server: TournamentTableServer;
  private over = false;

  constructor(private readonly opts: TournamentHostOptions) {
    super(opts.spec);
    this.server = new TournamentTableServer({
      clock: opts.clock,
      backend: new D1TournamentBackend(opts.db, opts.tournamentId, opts.log),
      pacing: opts.pacing,
      log: (m) => opts.log('info', m),
      onQuit: () => {
        this.over = true;
      },
    });
    this.room = new Room(opts.spec, this.server, opts.clock, opts.log);
    this.server.activate(this.room);
  }

  get label(): string {
    return `tournament ${this.opts.tournamentId}`;
  }

  /** The tournament runs whether or not anyone is connected (absent players are blinded out). */
  get keepAwake(): boolean {
    return !this.closed && !this.over;
  }

  idleExpired(): boolean {
    return this.over;
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.room.close(reason);
  }

  async drain(): Promise<void> {
    // A tournament can't be paused: a deploy that closes it mid-way aborts it (the cron refunds once heartbeats stop).
    await this.close('server restarting');
  }
}
