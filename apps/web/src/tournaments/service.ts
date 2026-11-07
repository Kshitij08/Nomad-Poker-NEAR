import type { AppContext } from '../app/app';
import type { TableScreenParams } from '../table/tableScreen';
import { TournamentApiClient, type TournamentApiConfig } from './api/apiClient';
import { isDemo, type CreateRequest, type ListResult, type MineResult, type Reply, type TournamentInfo } from './api/tournamentInfo';
import { tournamentClientState, type TournamentClientState } from './clientState';
import { isReadyToJoin } from './format';
import { PRACTICE_FIELDS, practiceTournamentSession } from './offline/practiceSession';
import { isTournamentSession } from './runtime/tournamentServerGame';

/** TournamentsHud.MinePollSeconds / AutoJoinSeconds. */
const MINE_POLL_SECONDS = 10;
const AUTO_JOIN_SECONDS = 30;

/**
 * Joins a live tournament's table by session name (TRN…). The net module sets this: Unity connects the Fusion menu
 * to the session (TournamentsHud.JoinAsync → controller.Connection.ConnectAsync). Resolves to an error message, or
 * null on success.
 */
export type TournamentJoinHandler = (sessionName: string, info: TournamentInfo) => Promise<string | null>;

/**
 * The tournaments service: browse / my tournaments / host / join by code / register (TournamentApiClient, demo data
 * unless live mode is configured), live state at the table (TournamentClientState), joining a tournament's table,
 * and the offline practice tournament. Registered as ctx.services.tournaments.
 */
export class TournamentsService {
  readonly api: TournamentApiClient;
  readonly state: TournamentClientState = tournamentClientState;
  readonly practiceFields = PRACTICE_FIELDS;
  /** Set by the net module to connect to a live tournament session. */
  joinHandler: TournamentJoinHandler | null = null;
  /** The registered tournament whose table is ready (TournamentsHud._ready), for the "your table is ready" banner. */
  ready: TournamentInfo | null = null;
  bannerDismissedId: string | null = null;
  private joining = false;
  private readonly autoJoined = new Set<string>();
  private pollTimer = 0;

  constructor(private readonly ctx: AppContext, apiConfig: Partial<TournamentApiConfig> = {}) {
    this.api = new TournamentApiClient({
      live: false,
      backendUrl: '',
      sessionTicket: () => null,
      playFabId: () => null,
      ...apiConfig,
    });
  }

  get isJoining(): boolean {
    return this.joining;
  }

  // ---- The backend API (or its demo stand-in) ----------------------------------------------

  list(filter = 'upcoming'): Promise<Reply<ListResult>> { return this.api.list(filter); }
  mine(): Promise<Reply<MineResult>> { return this.api.mine(); }
  get(id: string): Promise<Reply<TournamentInfo>> { return this.api.get(id); }
  byCode(code: string): Promise<Reply<TournamentInfo>> { return this.api.byCode(code); }
  create(request: CreateRequest): Promise<Reply<TournamentInfo>> { return this.api.create(request); }
  register(id: string): Promise<Reply<TournamentInfo>> { return this.api.register(id); }
  unregister(id: string): Promise<Reply<TournamentInfo>> { return this.api.unregister(id); }
  cancel(id: string): Promise<Reply<TournamentInfo>> { return this.api.cancel(id); }
  raisePrize(id: string, amount: number): Promise<Reply<TournamentInfo>> { return this.api.raisePrize(id, amount); }

  // ---- Playing -------------------------------------------------------------------------------

  /** The offline practice tournament: you plus bots, one-minute levels. Navigates to the table. */
  async startPractice(players: number, params: Omit<TableScreenParams, 'session'> = {}, info?: Pick<TournamentInfo, 'name' | 'firstPrize' | 'secondPrize'>): Promise<void> {
    const session = practiceTournamentSession({ players, name: info?.name, firstPrize: info?.firstPrize, secondPrize: info?.secondPrize });
    await this.ctx.router.navigate('table', { ...params, session } satisfies TableScreenParams);
  }

  /**
   * TournamentsHud.JoinAsync: connect to the tournament's table. Resolves to a message for the player, or null when
   * the join went through.
   */
  async join(t: TournamentInfo | null): Promise<string | null> {
    // Unity: "That's a demo tournament with no server behind it" (it has none). Here a demo tournament whose table
    // is ready plays offline: this browser hosts it as a practice run with bots in the other seats.
    if (t && isDemo(t)) {
      if (!t.serverReady) return "The tournament server isn't ready yet.";
      if (this.ctx.router.current === 'table') return 'Leave your table first, then join.';
      await this.startPractice(Math.max(2, Math.min(30, t.players)), {}, t);
      return null;
    }
    if (!t || !t.sessionName) return "The tournament server isn't ready yet.";
    if (this.ctx.router.current === 'table') return 'Leave your table first, then join.';
    if (!this.joinHandler) return 'Multiplayer tournaments need the table server. Try a practice tournament.';
    this.joining = true;
    try {
      this.state.begin(t.sessionName);
      return await this.joinHandler(t.sessionName, t);
    } finally {
      this.joining = false;
    }
  }

  /** Enter code with a TRN… session name (testing): joins that tournament server directly. */
  async joinSession(code: string): Promise<string | null> {
    return this.join({ id: code, name: code, sessionName: code } as TournamentInfo);
  }

  isTournamentSession(code: string): boolean {
    return isTournamentSession(code) && code.length > 6;
  }

  // ---- The "your table is ready" poll (TournamentsHud.PollMineAsync) -----------------------

  startPolling(): void {
    if (this.pollTimer) return;
    const tick = () => void this.pollMine();
    this.pollTimer = window.setInterval(tick, MINE_POLL_SECONDS * 1000);
    tick();
  }

  stopPolling(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = 0;
  }

  async pollMine(): Promise<void> {
    if (!this.api.signedIn) return;
    const mine = await this.api.mine();
    if (mine.error !== null || !mine.value) return;
    let ready: TournamentInfo | null = null;
    for (const t of mine.value.entries ?? []) if (isReadyToJoin(t)) ready = t;
    this.ready = ready;
    this.ctx.events.emit('tournaments:ready', ready);

    // In the menu at the start: take them straight to their table rather than leave them blinded off.
    if (ready && ready.id !== this.bannerDismissedId && !isDemo(ready) && this.ctx.router.current !== 'table' && !this.joining
      && !this.autoJoined.has(ready.id) && ready.startsAtUnix - this.api.serverNowUnix <= AUTO_JOIN_SECONDS) {
      this.autoJoined.add(ready.id);
      await this.join(ready);
    }
  }
}

declare module '../app/app' {
  interface Services {
    tournaments?: TournamentsService;
  }
}
