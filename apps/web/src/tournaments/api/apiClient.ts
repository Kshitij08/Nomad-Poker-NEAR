import { TournamentDemoData } from './demoData';
import { DEMO_ME, fail, isOk, ok, type CreateRequest, type ListResult, type MineResult, type Reply, type TournamentInfo } from './tournamentInfo';

export interface TournamentApiConfig {
  /**
   * Live mode: talk to the backend's /api/tournaments (backend/src/tournaments). OFF by default — the client shows
   * the demo tournaments, like the Unity Editor. Never point this at a deployed backend without an explicit OK.
   */
  live: boolean;
  /** Backend base URL for live mode (TournamentLaunch.BackendUrl), e.g. a local `npm run dev` of backend/. */
  backendUrl: string;
  /** The signed-in PlayFab session ticket, or null when signed out (PokerClientIdentity.PlayFabSessionTicket). */
  sessionTicket: () => string | null;
  /** The PlayFab id when signed in (PokerClientIdentity.PlayFabId). */
  playFabId: () => string | null;
  /**
   * The Nomad API (Phase 5): its /v1/tournaments routes, signed in with the Nomad session (no PlayFab ticket swap).
   * When set, live mode is on and `backendUrl` / `sessionTicket` are unused.
   */
  nomad?: NomadTournamentLink | null;
  /** Injected for tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

interface ErrorBody { error?: string; code?: string }

/** What the client needs from the Nomad session (account/session.ts NomadSession fits). */
export interface NomadTournamentLink {
  readonly signedIn: boolean;
  readonly token: string | null;
  /** Throws an error with `status`, `code` and a player-facing message on a failed call. */
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** The old backend's paths, as the Nomad API names them. */
const nomadPath = (path: string): string => path.replace(/^\/api\/me\/tournaments/, '/v1/me/tournaments').replace(/^\/api\/tournaments/, '/v1/tournaments');
interface AuthReply { token?: string; playFabId?: string; expiresIn?: number }

/**
 * The game's side of /api/tournaments. Port of Tournaments/TournamentApiClient.cs: signs in once with the PlayFab
 * session ticket (the backend checks it with PlayFab and hands back an hour-long token), then makes plain JSON calls.
 * Every call resolves; failures come back as Reply.error in words a player can read. With `live` off (the default)
 * every call is answered by TournamentDemoData and nothing leaves the browser.
 */
export class TournamentApiClient {
  readonly demo: TournamentDemoData;
  private token: string | null = null;
  private tokenFor: string | null = null;
  private tokenExpires = 0;
  /** Server time minus this device's clock, in seconds — countdowns use the server's clock. */
  serverSkewSeconds = 0;

  constructor(private readonly config: TournamentApiConfig) {
    this.demo = new TournamentDemoData(() => this.deviceNowUnix);
  }

  /** DemoMode: sample tournaments instead of the backend. */
  get demoMode(): boolean {
    return !this.config.live && !this.config.nomad;
  }

  private get deviceNowUnix(): number {
    return Math.floor((this.config.now?.() ?? Date.now()) / 1000);
  }

  get serverNowUnix(): number {
    return this.deviceNowUnix + this.serverSkewSeconds;
  }

  /** Who "you" are: the PlayFab id, or a stand-in when signed out in demo mode. */
  get currentPlayerId(): string {
    const id = this.config.playFabId();
    return id ? id : this.demoMode ? DEMO_ME : '';
  }

  get signedIn(): boolean {
    if (this.config.nomad) return this.config.nomad.signedIn;
    return this.demoMode || !!this.config.sessionTicket();
  }

  async list(filter = 'upcoming'): Promise<Reply<ListResult>> {
    if (this.demoMode) return ok(this.demo.listTournaments(filter));
    const r = await this.send<ListResult>('GET', `/api/tournaments?filter=${encodeURIComponent(filter)}`, null, false);
    if (isOk(r)) this.skew(r.value.serverNowUnix);
    return r;
  }

  async mine(): Promise<Reply<MineResult>> {
    if (this.demoMode) return ok(this.demo.mine());
    const r = await this.send<MineResult>('GET', '/api/me/tournaments', null, true);
    if (isOk(r)) this.skew(r.value.serverNowUnix);
    return r;
  }

  get(id: string): Promise<Reply<TournamentInfo>> {
    return this.demoMode ? Promise.resolve(this.demo.get(id)) : this.one('GET', `/api/tournaments/${id}`, null, true);
  }

  byCode(code: string): Promise<Reply<TournamentInfo>> {
    return this.demoMode ? Promise.resolve(this.demo.byCode(code))
      : this.one('GET', `/api/tournaments/code/${encodeURIComponent(code.trim().toUpperCase())}`, null, true);
  }

  create(request: CreateRequest): Promise<Reply<TournamentInfo>> {
    return this.demoMode ? Promise.resolve(this.demo.create(request)) : this.one('POST', '/api/tournaments', JSON.stringify(request), true);
  }

  register(id: string): Promise<Reply<TournamentInfo>> {
    return this.demoMode ? Promise.resolve(this.demo.register(id)) : this.one('POST', `/api/tournaments/${id}/register`, '{}', true);
  }

  unregister(id: string): Promise<Reply<TournamentInfo>> {
    return this.demoMode ? Promise.resolve(this.demo.unregister(id)) : this.one('POST', `/api/tournaments/${id}/unregister`, '{}', true);
  }

  cancel(id: string): Promise<Reply<TournamentInfo>> {
    return this.demoMode ? Promise.resolve(this.demo.cancel(id)) : this.one('POST', `/api/tournaments/${id}/cancel`, '{}', true);
  }

  raisePrize(id: string, amount: number): Promise<Reply<TournamentInfo>> {
    return this.demoMode ? Promise.resolve(this.demo.raisePrize(id, amount))
      : this.one('POST', `/api/tournaments/${id}/raise-prize`, JSON.stringify({ amount }), true);
  }

  private async one(method: string, path: string, json: string | null, auth: boolean): Promise<Reply<TournamentInfo>> {
    const r = await this.send<{ serverNowUnix: number; tournament: TournamentInfo }>(method, path, json, auth);
    if (!isOk(r)) return fail(r.error!, r.code);
    this.skew(r.value.serverNowUnix);
    return ok(r.value.tournament);
  }

  private skew(serverNowUnix: number): void {
    if (serverNowUnix > 0) this.serverSkewSeconds = serverNowUnix - this.deviceNowUnix;
  }

  /** The backend sign-in token for the signed-in PlayFab player (null when not signed in). */
  async signInToken(): Promise<string | null> {
    if (this.config.nomad) return this.config.nomad.token;
    const ticket = this.config.sessionTicket();
    const playFabId = this.config.playFabId();
    if (!ticket) return null;
    const nowS = (this.config.now?.() ?? Date.now()) / 1000;
    if (this.token && this.tokenFor === playFabId && nowS < this.tokenExpires) return this.token;
    const r = await this.raw('POST', '/api/auth/playfab', JSON.stringify({ sessionTicket: ticket }), null);
    if (!r.ok) {
      console.warn(`[Tournaments] Sign-in to the tournament service failed: ${r.error}`);
      return null;
    }
    const reply = parse<AuthReply>(r.body);
    if (!reply?.token) return null;
    this.token = reply.token;
    this.tokenFor = playFabId;
    this.tokenExpires = nowS + Math.max(60, (reply.expiresIn ?? 0) - 300);
    return this.token;
  }

  private async send<T>(method: string, path: string, json: string | null, auth: boolean): Promise<Reply<T>> {
    const nomad = this.config.nomad;
    if (nomad) {
      if (auth && !nomad.signedIn && (path.startsWith('/api/me') || method === 'POST')) return fail('Sign in to take part in tournaments.', 'sign_in');
      try {
        return ok(await nomad.call<T>(method, nomadPath(path), json ? JSON.parse(json) : undefined));
      } catch (e) {
        const err = e as { status?: number; code?: string; message?: string };
        if (err.status === undefined) return fail("Couldn't reach the tournament service. Check your connection.");
        return fail(err.message || 'Something went wrong. Try again.', err.code ?? null);
      }
    }
    let token: string | null = null;
    if (auth) {
      token = await this.signInToken();
      if (!token && path.startsWith('/api/me')) return fail('Sign in to see your tournaments.', 'sign_in');
      if (!token && method === 'POST') return fail('Sign in to take part in tournaments.', 'sign_in');
    }
    let r = await this.raw(method, path, json, token);
    if (r.status === 401 && token) {
      // The hour-long token ran out between calls: sign in again once.
      this.token = null;
      token = await this.signInToken();
      if (token) r = await this.raw(method, path, json, token);
    }
    if (!r.ok) {
      const err = parse<ErrorBody>(r.body);
      return fail(err?.error ? err.error
        : r.status === 0 ? "Couldn't reach the tournament service. Check your connection."
          : r.error ?? 'Something went wrong. Try again.', err?.code ?? null);
    }
    const value = parse<T>(r.body);
    return value !== null ? ok(value) : fail('The tournament service sent an unexpected reply.');
  }

  private async raw(method: string, path: string, json: string | null, token: string | null): Promise<{ ok: boolean; body: string | null; status: number; error: string | null }> {
    if (!this.config.live) return { ok: false, body: null, status: 0, error: 'Live tournaments are off.' };
    const doFetch = this.config.fetch ?? fetch;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await doFetch(this.config.backendUrl.replace(/\/+$/, '') + path, { method, headers, body: json ?? undefined, signal: ctrl.signal });
      const body = await res.text();
      return { ok: res.ok, body, status: res.status, error: res.ok ? null : `HTTP/1.1 ${res.status} ${res.statusText}` };
    } catch (ex) {
      return { ok: false, body: null, status: 0, error: (ex as Error).message };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parse<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
