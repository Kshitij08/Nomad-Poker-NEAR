/**
 * The admin page's client for the API's support routes (`/v1/admin/*`, apps/api). It signs in with the game's own
 * session: the token the game keeps in localStorage for this API (`nomad.session:<api>`, account/session.ts), so the
 * page needs no login of its own. Non-admins get 404 from every admin route, which this reports as `not_admin`.
 */
import { AdminRoutes, CURRENCIES, Routes, type Currency, type LedgerEntry, type MeResponse } from '@nomad/contract';

export type AdminRole = 'admin' | 'support';

export interface PlayerHit {
  id: string;
  name: string;
  friendCode: string | null;
  kind: string;
  banned: boolean;
  lastSeen: string;
}

export interface PlayerDetail {
  player: { id: string; name: string; kind: string; friendCode: string | null; createdAt: string; lastSeen: string; banned: boolean; banReason: string | null };
  identities: { provider: string; subject: string; created_at: number }[];
  balances: Record<Currency, number>;
  ledger: LedgerEntry[];
  seat: { room: string; table_id: string; stack: number; buy_in: number; updated_at: number } | null;
  agents: { id: string; phase: string; room: string; stack: number; bankroll: number; hands_played: number }[];
  tournaments: { tournament_id: string; status: string; paid_amount: number; place: number | null; prize: number | null }[];
  audit: { admin_id: string; action: string; details: string; created_at: number }[];
}

export interface AuditEntry {
  id: number;
  admin_id: string;
  action: string;
  target_id: string | null;
  details: unknown;
  at: string;
}

export interface ReconcileReport {
  ok: boolean;
  at: string;
  checks: { name: string; ok: boolean; checked: number; problems: unknown[]; note: string }[];
}

export interface IntegrityReport {
  at: string;
  since: string;
  rules: Record<string, number>;
  chipDumping: { from: string; to: string; coins: number; oneWay: number; handsTogether: number }[];
  marathons: { player: string; hoursInLastDay: number; hands: number }[];
  robotic: { player: string; decisions: number; avgMs: number; sdMs: number }[];
  winRateOutliers: { player: string; hands: number; bb100: number }[];
}

export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The session key the game uses for an API base (account/session.ts localTokenStore). */
export const sessionKey = (base: string) => `nomad.session:${base}`;

export class AdminApi {
  constructor(
    readonly base: string,
    private readonly token: string | null,
    private readonly fetcher: Fetch = (u, i) => fetch(u, i),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) throw new AdminError(401, 'unauthorized', 'Sign in to the game first.');
    let res: { status: number; json(): Promise<unknown> };
    try {
      res = await this.fetcher(this.base + path, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AdminError(0, 'network', "Couldn't reach the server. Check your connection.");
    }
    const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (res.status >= 200 && res.status < 300) return json as T;
    // Every admin route answers 404 to a signed-in player who isn't an admin; the page asks /v1/admin/me first.
    if (res.status === 404 && path === AdminRoutes.me) throw new AdminError(404, 'not_admin', 'This account is not an admin.');
    throw new AdminError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? `The server answered ${res.status}.`);
  }

  me(): Promise<MeResponse> {
    return this.call('GET', Routes.me);
  }
  whoAmI(): Promise<{ player_id: string; role: AdminRole }> {
    return this.call('GET', AdminRoutes.me);
  }
  search(q: string): Promise<{ players: PlayerHit[] }> {
    return this.call('GET', `${AdminRoutes.players}?q=${encodeURIComponent(q)}`);
  }
  player(id: string): Promise<PlayerDetail> {
    return this.call('GET', `${AdminRoutes.player}/${encodeURIComponent(id)}`);
  }
  adjust(id: string, currency: Currency, delta: number, reason: string, requestId = newRequestId()): Promise<{ balances: Record<Currency, number> }> {
    return this.call('POST', `${AdminRoutes.player}/${encodeURIComponent(id)}/adjust`, { currency, delta, reason, requestId });
  }
  ban(id: string, reason: string): Promise<{ banned: boolean }> {
    return this.call('POST', `${AdminRoutes.player}/${encodeURIComponent(id)}/ban`, { reason });
  }
  unban(id: string): Promise<{ banned: boolean }> {
    return this.call('POST', `${AdminRoutes.player}/${encodeURIComponent(id)}/unban`, {});
  }
  audit(before?: number): Promise<{ entries: AuditEntry[]; nextBefore?: number }> {
    return this.call('GET', `${AdminRoutes.audit}?limit=50${before ? `&before=${before}` : ''}`);
  }
  reconcile(): Promise<ReconcileReport> {
    return this.call('GET', AdminRoutes.reconcile);
  }
  integrity(): Promise<IntegrityReport> {
    return this.call('GET', AdminRoutes.integrity);
  }
}

/** One id per adjustment the admin confirms: a retried request (a slow network) then adjusts once. */
export function newRequestId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 'web-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** "+1,250" / "−300": the sign always shown, a real minus. */
export function signed(n: number): string {
  return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toLocaleString('en-US');
}

/** Checks an adjustment before it is sent; the server checks the same rules. Returns an error message or null. */
export function adjustProblem(currency: string, delta: number, reason: string): string | null {
  if (!CURRENCIES.includes(currency as Currency)) return 'Pick a currency.';
  if (!Number.isSafeInteger(delta) || delta === 0) return 'Enter a whole number, not zero (negative takes away).';
  if (Math.abs(delta) > 100_000_000) return 'At most 100,000,000 at a time.';
  if (reason.trim().length < 3) return 'Say why (at least 3 characters). It is recorded.';
  return null;
}
