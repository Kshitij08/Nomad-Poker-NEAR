/**
 * A minimal PlayFab REST client — the parts of the Unity SDK's PlayFabClientAPI / PlayFabEconomyAPI /
 * PlayFabProgressionAPI the game calls, plus `PlayFabSettings.staticPlayer` (the signed-in context).
 *
 * CLIENT API ONLY. Server/Admin APIs need the title secret key and never exist in the browser.
 * The transport decides where calls go: `FetchTransport` → https://<title>.playfabapi.com (only when
 * config.backendMode() says 'live'), `LocalTitleTransport` (localTitle.ts) → an in-browser emulated title.
 */

/** A PlayFab REST envelope: `{ code, status, data }` or `{ code, status, error, errorCode, errorMessage }`. */
export interface RawEnvelope {
  code: number;
  status?: string;
  data?: unknown;
  error?: string;
  errorCode?: number;
  errorMessage?: string;
}

export interface Transport {
  readonly kind: 'live' | 'local';
  post(path: string, body: unknown, headers: Record<string, string>): Promise<RawEnvelope>;
}

export interface PlayFabError {
  readonly httpCode: number;
  /** The PlayFabErrorCode name ("PlayerCreationDisabled", "AccountNotFound"…). */
  readonly error: string;
  readonly errorCode: number;
  readonly errorMessage: string;
}

export type ApiResult<T> = { readonly data: T; readonly error: null } | { readonly data: null; readonly error: PlayFabError };

export function errorReport(e: PlayFabError): string {
  return `${e.error} (${e.errorCode}): ${e.errorMessage}`;
}

/** Talks to the real title over HTTPS (the jslib's PokerPlayFabGoogleRequest transport, generalised). */
export class FetchTransport implements Transport {
  readonly kind = 'live' as const;
  constructor(private readonly titleId: string, private readonly timeoutMs = 20_000) {}

  async post(path: string, body: unknown, headers: Record<string, string>): Promise<RawEnvelope> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`https://${this.titleId}.playfabapi.com/${path}`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'X-PlayFabSDK': 'Poker-Web/1.0', 'X-ReportErrorAsSuccess': 'true', ...headers },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!text) return { code: 0, error: 'EmptyResponse', errorMessage: 'PlayFab returned an empty response.' };
      try {
        return JSON.parse(text) as RawEnvelope;
      } catch {
        return { code: response.status, error: 'InvalidResponse', errorMessage: 'PlayFab returned an invalid response.' };
      }
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      return { code: 0, error: 'NetworkError', errorMessage: aborted ? 'PlayFab request timed out.' : 'Could not reach PlayFab.' };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class PlayFabClient {
  // PlayFabSettings.staticPlayer
  sessionTicket = '';
  entityToken = '';
  entityId = '';
  entityType = '';
  playFabId = '';

  constructor(readonly titleId: string, readonly transport: Transport) {}

  get isLive(): boolean {
    return this.transport.kind === 'live';
  }

  isClientLoggedIn(): boolean {
    return this.sessionTicket.length > 0;
  }

  /** PlayFabAuthenticationContext.CopyFrom. */
  adoptContext(c: { sessionTicket: string; entityToken: string; playFabId: string; entityId: string; entityType: string }): void {
    this.sessionTicket = c.sessionTicket ?? '';
    this.entityToken = c.entityToken ?? '';
    this.playFabId = c.playFabId ?? '';
    this.entityId = c.entityId ?? '';
    this.entityType = c.entityType ?? '';
  }

  forgetAllCredentials(): void {
    this.adoptContext({ sessionTicket: '', entityToken: '', playFabId: '', entityId: '', entityType: '' });
  }

  /** A Client API call. `auth: false` for the Login* calls. */
  client<T>(api: string, body: object, auth = true): Promise<ApiResult<T>> {
    if (auth && !this.sessionTicket) return Promise.resolve(notLoggedIn<T>('Must be logged in to call this method'));
    return this.call<T>(`Client/${api}`, body, auth ? { 'X-Authorization': this.sessionTicket } : {});
  }

  /** An entity-authenticated call (Economy v2, Progression). The SDK throws without a token; this returns an error. */
  entity<T>(path: string, body: object): Promise<ApiResult<T>> {
    if (!this.entityToken) return Promise.resolve(notLoggedIn<T>('Must call GetEntityToken before calling this method'));
    return this.call<T>(path, body, { 'X-EntityToken': this.entityToken });
  }

  private async call<T>(path: string, body: object, headers: Record<string, string>): Promise<ApiResult<T>> {
    let env: RawEnvelope;
    try {
      env = await this.transport.post(path, body, headers);
    } catch (e) {
      env = { code: 0, error: 'NetworkError', errorMessage: e instanceof Error ? e.message : String(e) };
    }
    if (env.code === 200 && !env.error) return { data: (env.data ?? {}) as T, error: null };
    return {
      data: null,
      error: { httpCode: env.code, error: env.error ?? 'Unknown', errorCode: env.errorCode ?? 0, errorMessage: env.errorMessage ?? '' },
    };
  }
}

function notLoggedIn<T>(message: string): ApiResult<T> {
  return { data: null, error: { httpCode: 0, error: 'NotLoggedIn', errorCode: 0, errorMessage: message } };
}

/** The entity token + entity on a LoginResult. */
export interface EntityTokenResponse {
  EntityToken?: string;
  TokenExpiration?: string;
  Entity?: { Id?: string; Type?: string };
}

export interface LoginResult {
  SessionTicket?: string;
  PlayFabId?: string;
  NewlyCreated?: boolean;
  EntityToken?: EntityTokenResponse;
  InfoResultPayload?: { PlayerProfile?: { DisplayName?: string } };
}
