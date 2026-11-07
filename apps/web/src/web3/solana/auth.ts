/**
 * Connect wallet → request SIWS nonce → signMessage → verify → store the JWT on PokerClientIdentity. Port of
 * Auth/WalletAuthService.cs against the same backend contract (backend/src: POST /api/auth/nonce, POST
 * /api/auth/verify, GET /api/me, PUT /api/me/email). Network only when the player presses a button; the backend URL
 * comes from config (not configured = a clear error, never the live Railway server unless ?web3deployed=1).
 */
import bs58 from 'bs58';
import { requireBackend } from '../config';
import { utf8 } from '../lib/bytes';
import type { HttpResult, PerHttp } from '../lib/http';
import { PokerClientIdentity } from './identity';

export interface AuthResult {
  ok: boolean;
  error?: string;
  pubkey?: string;
  token?: string;
  email?: string | null;
  marketingOptIn?: boolean;
}

interface PlayerDto {
  pubkey?: string;
  display_name?: string;
  email?: string | null;
  marketing_opt_in?: boolean;
}

/** What the auth flow needs from the wallet layer. */
export interface AuthWallet {
  /** Connects (showing the picker if needed); null when cancelled. */
  ensureConnected(): Promise<string | null>;
  /** Silent reconnect of the remembered wallet; null when there is none or it declined. */
  reconnectSilently(): Promise<string | null>;
  readonly address: string | null;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  logout(): Promise<void>;
}

const fail = (error: string): AuthResult => ({ ok: false, error });

export class WalletAuthService {
  constructor(
    private readonly http: PerHttp,
    private readonly backendUrl: () => string,
    private readonly wallet: AuthWallet,
    private readonly onNameFromServer: (name: string) => void = () => {},
  ) {}

  private base(): string {
    return requireBackend(this.backendUrl(), 'The game backend (wallet sign-in)').replace(/\/+$/, '');
  }

  async login(displayName?: string): Promise<AuthResult> {
    try {
      const base = this.base();
      const pubkey = await this.wallet.ensureConnected();
      if (!pubkey) return fail('Wallet connection cancelled or failed.');

      const nonceBody = await this.postJson(base + '/api/auth/nonce', { pubkey });
      if (!nonceBody.ok) return fail(nonceBody.error!);
      const nonce = safeJson<{ message?: string }>(nonceBody.body);
      if (!nonce?.message) return fail('Invalid nonce response from server.');

      const signatureBytes = await this.wallet.signMessage(utf8(nonce.message));
      if (!signatureBytes || signatureBytes.length === 0) return fail('Message signing cancelled or failed.');

      const verifyBody = await this.postJson(base + '/api/auth/verify', {
        pubkey,
        message: nonce.message,
        signature: bs58.encode(signatureBytes),
        displayName: displayName?.trim() ? displayName.trim() : PokerClientIdentity.playerName,
      });
      if (!verifyBody.ok) return fail(verifyBody.error!);
      const verified = safeJson<{ token?: string; player?: PlayerDto }>(verifyBody.body);
      if (!verified?.token) return fail('Invalid verify response from server.');

      PokerClientIdentity.setWalletSession(pubkey, verified.token);
      if (verified.player?.display_name?.trim()) this.onNameFromServer(verified.player.display_name);
      return { ok: true, pubkey, token: verified.token, email: verified.player?.email ?? null, marketingOptIn: !!verified.player?.marketing_opt_in };
    } catch (e) {
      console.error('[WalletAuthService] Login failed:', e);
      return fail((e as Error).message ?? String(e));
    }
  }

  /**
   * Brings a saved session back without troubling the player: checks the stored JWT still works and reconnects the
   * wallet they last used, silently. Nothing here signs. An outright rejected token is cleared on the way out.
   */
  async restoreSession(): Promise<AuthResult> {
    if (!PokerClientIdentity.isLoggedIn) return fail('No saved session.');
    const saved = PokerClientIdentity.walletPubkey;
    try {
      const me = await this.fetchMe();
      if (!me.ok) {
        if (me.error?.startsWith('401')) {
          console.log('[WalletAuthService] Saved session expired — signing in again is needed.');
          PokerClientIdentity.clearWalletSession();
        }
        return me;
      }
      const account = this.wallet.address ?? (await this.wallet.reconnectSilently());
      if (!account) return fail('Saved session found, but the wallet did not reconnect.');
      if (account !== saved) {
        // A different wallet is active than the one the token was issued to: drop the session.
        PokerClientIdentity.clearWalletSession();
        return fail('A different wallet is connected. Sign in again.');
      }
      return me;
    } catch (e) {
      console.warn('[WalletAuthService] Could not restore the saved session:', (e as Error).message);
      return fail((e as Error).message);
    }
  }

  async fetchMe(): Promise<AuthResult> {
    if (!PokerClientIdentity.isLoggedIn) return fail('Not logged in.');
    const base = this.base();
    const r = await this.result(base + '/api/me', await this.http.get(base + '/api/me', bearer()));
    if (!r.ok) return fail(r.error!);
    const me = safeJson<{ player?: PlayerDto }>(r.body);
    return {
      ok: true,
      pubkey: me?.player?.pubkey ?? PokerClientIdentity.walletPubkey,
      token: PokerClientIdentity.sessionToken,
      email: me?.player?.email ?? null,
      marketingOptIn: !!me?.player?.marketing_opt_in,
    };
  }

  async saveEmail(email: string, marketingOptIn: boolean): Promise<AuthResult> {
    if (!PokerClientIdentity.isLoggedIn) return fail('Not logged in.');
    const base = this.base();
    if (!this.http.put) return fail('PUT unsupported');
    const url = base + '/api/me/email';
    const r = await this.result(url, await this.http.put(url, JSON.stringify({ email: email ?? '', marketingOptIn }), bearer()));
    if (!r.ok) return fail(r.error!);
    const player = safeJson<{ player?: PlayerDto }>(r.body)?.player;
    return {
      ok: true,
      pubkey: player?.pubkey ?? PokerClientIdentity.walletPubkey,
      token: PokerClientIdentity.sessionToken,
      email: player?.email ?? email,
      marketingOptIn: player ? !!player.marketing_opt_in : marketingOptIn,
    };
  }

  /** Forget the wallet too: a deliberate logout has to survive the next page load. */
  async logout(): Promise<void> {
    PokerClientIdentity.clearWalletSession(true);
    await this.wallet.logout();
  }

  private async postJson(url: string, payload: unknown): Promise<{ ok: boolean; body: string; error?: string }> {
    return this.result(url, await this.http.post(url, JSON.stringify(payload)));
  }

  private async result(url: string, r: HttpResult): Promise<{ ok: boolean; body: string; error?: string }> {
    if (r.status >= 200 && r.status < 300) return { ok: true, body: r.body };
    const error = formatHttpError(url, r.status, r.body);
    console.error(`[WalletAuthService] request failed: ${error}`);
    return { ok: false, body: r.body, error };
  }
}

function bearer(): Record<string, string> {
  const t = PokerClientIdentity.sessionToken;
  return t ? { Authorization: 'Bearer ' + t } : {};
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** WalletAuthService.FormatHttpError (the 404 hint names the web flag instead of the Unity inspector field). */
export function formatHttpError(url: string, code: number, body: string): string {
  const detail = body?.trim() ? body.trim() : 'request failed';
  if (code === 404)
    return `404 at ${url} — auth API missing on this server. Run the backend locally (\`cd backend && npm run dev\`) and open the game with ?web3backend=http://localhost:8787.`;
  return `${code}: ${detail} (${url})`;
}
