/**
 * HTTP as the browser provides it: the IPerHttp seam of Per/Core/PerRpc.cs and the UnityWebRequest helpers of
 * Auth/WalletAuthService.cs. Every request is checked against the network policy (config.assertAllowedUrl) and
 * times out (UnityWebRequest.timeout = 30 / 20 s), so a backend that never answers can't freeze a button.
 */
import { assertAllowedUrl, type Web3Config } from '../config';

export interface HttpResult {
  status: number;
  body: string;
}

export interface PerHttp {
  get(url: string, headers?: Record<string, string>): Promise<HttpResult>;
  post(url: string, json: string, headers?: Record<string, string>): Promise<HttpResult>;
  put?(url: string, json: string, headers?: Record<string, string>): Promise<HttpResult>;
  /** A wait (Unity drives it from frames on WebGL; here setTimeout is fine). */
  delay(ms: number): Promise<void>;
}

export class FetchHttp implements PerHttp {
  constructor(
    private readonly cfg: Web3Config,
    private readonly timeoutSeconds = 30,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  get(url: string, headers?: Record<string, string>): Promise<HttpResult> {
    return this.send(url, { method: 'GET', headers });
  }

  post(url: string, json: string, headers?: Record<string, string>): Promise<HttpResult> {
    return this.send(url, { method: 'POST', body: json, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  put(url: string, json: string, headers?: Record<string, string>): Promise<HttpResult> {
    return this.send(url, { method: 'PUT', body: json, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async send(url: string, init: RequestInit): Promise<HttpResult> {
    assertAllowedUrl(this.cfg, url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutSeconds * 1000);
    try {
      const r = await this.fetchImpl(url, { ...init, signal: ctl.signal });
      return { status: r.status, body: await r.text() };
    } catch (e) {
      // UnityWebRequest reports a dead connection as responseCode 0.
      if ((e as Error).name === 'AbortError') return { status: 0, body: `request timed out after ${this.timeoutSeconds} s` };
      return { status: 0, body: String((e as Error).message ?? e) };
    } finally {
      clearTimeout(timer);
    }
  }
}
