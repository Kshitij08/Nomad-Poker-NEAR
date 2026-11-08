/**
 * The tournament server's side of the backend: /internal/tournaments/:id/*, authenticated with the internal API key.
 * Port of Net/Tournament/TournamentBackendClient.cs. Every call resolves (never throws); a failed call returns
 * null / false / 0 and the caller decides whether to retry.
 *
 * Only constructed when POKER_TOURNAMENT_BACKEND_URL (+ POKER_INTERNAL_API_KEY) are set — point it at a LOCAL backend
 * (`backend/` dev server). Never at a deployed one without an explicit OK.
 */
import type { StandingBody, TournamentBackend, TournamentRoster, VerifiedPlayer } from '@nomad/table-server/tournament/wire';

export class TournamentBackendClient implements TournamentBackend {
  private readonly base: string;

  constructor(readonly tournamentId: string, backendUrl: string, private readonly apiKey: string, private readonly log: (m: string) => void = console.warn) {
    this.base = `${backendUrl.replace(/\/+$/, '')}/internal/tournaments`;
  }

  async getRoster(): Promise<TournamentRoster | null> {
    const r = await this.send('GET', `/${this.tournamentId}`, null);
    return r.ok ? parse<TournamentRoster>(r.body) : null;
  }

  async verify(sessionTicket: string): Promise<VerifiedPlayer> {
    const r = await this.send('POST', `/${this.tournamentId}/verify`, JSON.stringify({ sessionTicket: sessionTicket ?? '' }));
    return parse<VerifiedPlayer>(r.body) ?? { ok: false, playFabId: '', displayName: '', entrant: false, host: false, error: 'No answer from the tournament service.', code: '' };
  }

  async ready(ok: boolean, error: string): Promise<boolean> {
    return (await this.send('POST', `/${this.tournamentId}/ready`, JSON.stringify({ ok, error: error ?? '' }))).ok;
  }

  async started(): Promise<boolean> {
    return (await this.send('POST', `/${this.tournamentId}/started`, '{}')).ok;
  }

  async progress(seq: number, playersRemaining: number, tablesOpen: number, phase: string): Promise<boolean> {
    return (await this.send('POST', `/${this.tournamentId}/progress`, JSON.stringify({ seq, snapshot: { playersRemaining, tablesOpen, phase } }))).ok;
  }

  /** Returns the HTTP status (200 recorded, 409 already different, 0 unreachable). */
  async postResult(championId: string, standings: StandingBody[]): Promise<number> {
    return (await this.send('POST', `/${this.tournamentId}/result`, JSON.stringify({ championId, standings }))).status;
  }

  private async send(method: string, path: string, json: string | null): Promise<{ ok: boolean; body: string | null; status: number }> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['X-API-Key'] = this.apiKey;
      const res = await fetch(this.base + path, { method, headers, body: json ?? undefined, signal: ctrl.signal });
      const body = await res.text();
      if (!res.ok) this.log(`[Tournament] ${method} ${path} failed (${res.status}): ${body}`);
      return { ok: res.ok, body, status: res.status };
    } catch (ex) {
      this.log(`[Tournament] ${method} ${path} failed (0): ${(ex as Error).message}`);
      return { ok: false, body: null, status: 0 };
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
