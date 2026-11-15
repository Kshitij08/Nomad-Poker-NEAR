/**
 * The player's Nomad API session (apps/api): sign-in (guest, NEAR, Google, email link), the signed-in profile and the
 * ledger balance. One instance per page as `ctx.services.nomadApi`; emits 'nomad:changed' whenever state moves.
 *
 * The token lives in localStorage per API base URL, so staging and local sessions never mix. Signing in with a
 * NEAR, Google or email while holding a guest token links that identity to the guest (the API keeps its balance).
 */
import {
  Routes,
  type ApiErrorBody,
  type EmailStartResponse,
  type LedgerResponse,
  type MeResponse,
  type NearChallengeResponse,
  type SessionResponse,
} from '@nomad/contract';
import type { NearSigner } from '../near/wallet';

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

  /** The bearer token (the game server's table ticket), or null when signed out. */
  get token(): string | null {
    return this.store.get();
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

  /**
   * NEAR sign-in: the API's challenge is signed by the wallet as a NEP-413 message, and the API checks the key is a
   * full-access key of the account. A guest signed in on this browser keeps its account: NEAR is linked to it.
   */
  near(signer: NearSigner): Promise<void> {
    return this.run(async () => {
      const accountId = await signer.connect();
      if (!accountId) throw new ApiRequestError(0, 'cancelled', 'Wallet connection cancelled.');
      const ch = await this.request<NearChallengeResponse>('POST', Routes.nearChallenge, { accountId });
      const nonce = Uint8Array.from(atob(ch.nonce), (c) => c.charCodeAt(0));
      const signed = await signer.signMessage({ message: ch.message, recipient: ch.recipient, nonce });
      await this.adopt(
        await this.request<SessionResponse>('POST', Routes.nearVerify, { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: ch.nonce }),
      );
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

  /** Google sign-in with an ID token from Google Identity Services (links Google when a guest is signed in). */
  google(idToken: string): Promise<void> {
    return this.run(async () => this.adopt(await this.request<SessionResponse>('POST', Routes.google, { idToken })));
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

  /** An authenticated API call (throws ApiRequestError). For the other account services (progress, rewards). */
  /** An uploaded picture's address (served by this API), or null for none. */
  pictureUrl(key: string | null | undefined): string | null {
    return key ? `${this.base.replace(/\/+$/, '')}/v1/pictures/${key}.webp` : null;
  }

  /** Sets your profile picture (an image the caller already cropped and shrunk). */
  async uploadPicture(image: Blob): Promise<void> {
    await this.run(async () => {
      const token = this.store.get();
      const res = await this.fetchImpl(`${this.base}/v1/me/picture`, {
        method: 'POST',
        headers: { 'content-type': image.type || 'image/webp', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: image,
      });
      const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      if (!res.ok) throw new ApiRequestError(res.status, (json?.error?.code as never) ?? 'internal', json?.error?.message ?? `Server error (${res.status}).`);
      await this.refreshMe();
    });
  }

  /** Back to the chosen avatar. */
  removePicture(): Promise<void> {
    return this.run(async () => {
      await this.request('DELETE', '/v1/me/picture');
      await this.refreshMe();
    });
  }

  call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, path, body);
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
