import { Container, ContainerProxy } from '@cloudflare/containers';
import { bridgeResponse } from './bridge';
import { lobbyRoute } from './lobby';

export { ContainerProxy }; // needed for the container's outbound handlers (the D1 bridge)

/**
 * The PER service on Cloudflare (Phase 6, the hybrid plan):
 * - the lobby reads (`/tables…`) are answered here from D1;
 * - everything else (verify, tournaments, SOL Agents and strategies, payouts, health, audit) goes to the PER
 *   container: the Railway service, ported, running the keeper. One instance, named "per";
 * - the container reaches D1 only through this Worker (`http://d1.per/query`, an outbound handler);
 * - the minute cron keeps it running (a container sleeps without requests; the keeper must not).
 */

export interface Env {
  DB: D1Database;
  PER: DurableObjectNamespace<PerService>;
  STAGE: string;
  /** Per-address limit for the routes (120 a minute, as the Railway service). */
  LIMITER?: RateLimit;
  // Secrets handed to the container when it starts (never to clients).
  KEEPER_SECRET_KEY: string;
  AUDITOR_SECRET_KEY: string;
  ARCHIVE_KEY_HEX: string;
  ADMIN_TOKEN: string;
  SOLANA_RPC_URL: string;
  TEE_URL?: string;
}

export class PerService extends Container<Env> {
  defaultPort = 8080;
  // The cron pings every minute; this only matters if the cron stops.
  sleepAfter = '30m';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      PORT: '8080',
      KEEPER_SECRET_KEY: env.KEEPER_SECRET_KEY,
      AUDITOR_SECRET_KEY: env.AUDITOR_SECRET_KEY,
      ARCHIVE_KEY_HEX: env.ARCHIVE_KEY_HEX,
      ADMIN_TOKEN: env.ADMIN_TOKEN,
      SOLANA_RPC_URL: env.SOLANA_RPC_URL,
      TEE_URL: env.TEE_URL ?? 'https://devnet-tee.magicblock.app',
      D1_BRIDGE_URL: 'http://d1.per/query',
    };
  }

  override onStart(): void {
    console.log('[per] container started');
  }

  override onStop(p: { exitCode: number; reason: string }): void {
    console.warn(`[per] container stopped: exit ${p.exitCode} (${p.reason})`);
  }

  override onError(error: unknown): void {
    console.error('[per] container error', error);
  }
}

// The D1 bridge: only this container's own requests to d1.per reach it.
PerService.outboundByHost = {
  'd1.per': (request: Request, env: Env) => bridgeResponse(env.DB, request),
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};

const service = (env: Env) => env.PER.get(env.PER.idFromName('per'));

function withCors(res: Response, audit: boolean): Response {
  if (audit) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The audit routes are for the operator's tools only: no CORS (as the Railway service).
    const audit = url.pathname.toLowerCase().startsWith('/audit');
    if (request.method === 'OPTIONS' && !audit) return new Response(null, { status: 204, headers: CORS });
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (env.LIMITER && !(await env.LIMITER.limit({ key: ip })).success)
      return withCors(Response.json({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '60' } }), audit);
    if (request.method === 'GET') {
      const lobby = await lobbyRoute(env.DB, url);
      if (lobby) return withCors(lobby, false);
    }
    // Everything else: the container, told who the client is (and nothing the client claimed about that).
    const fwd = new Request(request);
    fwd.headers.delete('x-client-ip');
    fwd.headers.set('x-client-ip', ip);
    try {
      return withCors(await service(env).fetch(fwd), audit);
    } catch (e) {
      console.error('[per] container unreachable', e);
      return withCors(Response.json({ error: 'the PER service is starting; try again in a moment' }, { status: 503, headers: { 'retry-after': '10' } }), audit);
    }
  },

  /** Every minute: keep the container (and so the keeper) running; a stopped one starts again here. */
  async scheduled(_c: ScheduledController, env: Env): Promise<void> {
    try {
      const res = await service(env).fetch(new Request('http://per/health', { headers: { 'x-client-ip': 'cron' } }));
      if (!res.ok) console.warn(`[per] health ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } catch (e) {
      console.error('[per] health check failed', e);
    }
  },
} satisfies ExportedHandler<Env>;
