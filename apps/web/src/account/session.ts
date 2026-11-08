/**
 * The player's Nomad API session (apps/api): sign-in (guest, wallet, email link), the signed-in profile and the
 * ledger balance. One instance per page as `ctx.services.nomadApi`; emits 'nomad:changed' whenever state moves.
 *
 * The token lives in localStorage per API base URL, so staging and local sessions never mix. Signing in with a
 * wallet or email while holding a guest token links that identity to the guest (the API keeps its balance).
 */
import {
  Routes,
  type ApiErrorBody,
  type EmailStartResponse,
  type LedgerResponse,
  type MeResponse,
  type SessionResponse,
  type WalletChallengeResponse,
} from '@nomad/contract';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

export function localTokenStore(base: string): TokenStore {
  const key = `nomad.session:${base}`;
  return {
    get: () => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (t) => {
      try {
        if (t) localStorage.setItem(key, t);
        else localStorage.removeItem(key);
      } catch {
        /* private mode: the session lasts for this page only */
      }
    },
  };
}

/** What wallet sign-in needs: the web3 module's SolanaService fits (connect + signMessage). */
export interface WalletSigner {
  /** Connects (showing the picker if needed); the base58 address, or null when cancelled. */
  connect(): Promise<string | null>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  const d: number[] = [];
  for (const b of bytes) {
    let c = b;
    for (let i = 0; i < d.length; i++) {
      c += d[i] << 8;
      d[i] = c % 58;
      c = (c / 58) | 0;
    }
    while (c) {
      d.push(c % 58);
      c = (c / 58) | 0;
    }
  }
  let s = '';
  for (const b of bytes) {
    if (b) break;
    s += '1';
  }
  for (let i = d.length - 1; i >= 0; i--) s += B58[d[i]];
  return s;
}

export interface NomadEvents {
  emit(event: string, payload?: unknown): void;
}

export class NomadSession {
  me: MeResponse | null = null;
  busy = false;
  error: string | null = null;

  constructor(
    readonly base: string,
    private readonly store: TokenStore,
    private readonly events: NomadEvents,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  get signedIn(): boolean {
    return this.me !== null;
  }

  /** Brings back a stored session (GET /me); clears it if the server no longer knows it. */
  async restore(): Promise<void> {
    if (!this.store.get()) return;
    await this.run(async () => {
      try {
        await this.refreshMe();
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 401) {
          this.store.set(null);
          this.me = null;
          return;
        }
        throw e;
      }
    });
  }

  guest(displayName?: string): Promise<void> {
    return this.run(async () => this.adopt(await this.request<SessionResponse>('POST', Routes.guest, displayName ? { displayName } : {})));
  }

  wallet(signer: WalletSigner): Promise<void> {
    return this.run(async () => {
      const address = await signer.connect();
      if (!address) throw new ApiRequestError(0, 'cancelled', 'Wallet connection cancelled.');
      const ch = await this.request<WalletChallengeResponse>('POST', Routes.walletChallenge, { address });
      const signature = await signer.signMessage(new TextEncoder().encode(ch.message));
      await this.adopt(await this.request<SessionResponse>('POST', Routes.walletVerify, { address, nonce: ch.nonce, signature: base58(signature) }));
    });
  }

  /** Asks for a sign-in link back to `returnTo`. On staging the API returns it as `devLink` (no mail provider yet). */
  async emailStart(email: string, returnTo = globalThis.location?.origin): Promise<EmailStartResponse | null> {
    let out: EmailStartResponse | null = null;
    await this.run(async () => {
      out = await this.request<EmailStartResponse>('POST', Routes.emailStart, { email, returnTo });
    });
    return out;
  }

  emailVerify(token: string): Promise<void> {
    return this.run(async () => this.adopt(await this.request<SessionResponse>('POST', Routes.emailVerify, { token })));
  }

  signOut(): Promise<void> {
    return this.run(async () => {
      try {
        if (this.store.get()) await this.request('POST', Routes.signOut);
      } finally {
        this.store.set(null);
        this.me = null;
      }
    });
  }

  refresh(): Promise<void> {
    return this.run(() => this.refreshMe());
  }

  ledger(before?: number): Promise<LedgerResponse> {
    return this.request<LedgerResponse>('GET', before ? `${Routes.ledger}?before=${before}` : Routes.ledger);
  }

  private async refreshMe(): Promise<void> {
    this.me = await this.request<MeResponse>('GET', Routes.me);
  }

  private async adopt(s: SessionResponse): Promise<void> {
    this.store.set(s.token);
    await this.refreshMe();
  }

  /** Runs one action: busy flag, error capture, change events before and after. */
  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.error = null;
    this.events.emit('nomad:changed');
    try {
      await fn();
    } catch (e) {
      this.error = e instanceof ApiRequestError ? e.message : 'Could not reach the Nomad server.';
      if (!(e instanceof ApiRequestError)) console.warn('[nomad] request failed', e);
    } finally {
      this.busy = false;
      this.events.emit('nomad:changed');
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = this.store.get();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await this.fetchImpl(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const err = (json as ApiErrorBody | null)?.error;
      throw new ApiRequestError(res.status, err?.code ?? 'internal', err?.message ?? `Server error (${res.status}).`);
    }
    return json as T;
  }
}
