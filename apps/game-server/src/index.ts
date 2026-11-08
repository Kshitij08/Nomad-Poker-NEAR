import { StakeSessionNames, PartyCodes } from '@nomad/table-server/sessions';
import type { Env } from './env';
import { auditTable } from '@nomad/db/seatLocks';
import { canonicalSession } from './roomSpec';

export { TableRoom } from './tableRoom';

/**
 * The game server Worker: routes table sockets to their Durable Object and answers the session-layer requests the
 * local server took over its one socket.
 *
 *   GET  /v1/health
 *   GET  /v1/tables/ws?session=<name>   WebSocket to that table (then `join`, `hello`, …: the local server's protocol)
 *   POST /v1/tables/spawn     { code, money }               → { code } | { error }
 *   POST /v1/tables/overflow  { money, failed, minBuyIn }   → { session } | { error }
 *   POST /v1/admin/drain      (Bearer DRAIN_TOKEN)          finish hands, pay out, close every open table
 *   GET  /v1/admin/audit?room= (Bearer DRAIN_TOKEN)         where every chip of that room's tables went (drift)
 */

const VERSION = '0.1.0';
const MAX_OVERFLOW = 20;

const origins = (env: Env) => env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

function originOk(request: Request, env: Env): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return env.ALLOW_NO_ORIGIN === '1';
  return origins(env).includes(origin);
}

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin || !origins(env).includes(origin)) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'origin' };
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) => Response.json(body, { status, headers });

const table = (env: Env, session: string) => env.TABLES.get(env.TABLES.idFromName(session));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const h = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...h, 'access-control-max-age': '86400' } });

    if (url.pathname === '/v1/health') return json({ ok: true, stage: env.STAGE, version: VERSION }, 200, h);

    if (url.pathname === '/v1/tables/ws') {
      if (!originOk(request, env)) return new Response('origin not allowed', { status: 403 });
      const session = canonicalSession(url.searchParams.get('session'));
      if (!session) return new Response('bad session', { status: 400 });
      return table(env, session).fetch(`https://table/ws?session=${encodeURIComponent(session)}`, request);
    }

    if (url.pathname === '/v1/tables/spawn' && request.method === 'POST') {
      if (!originOk(request, env)) return json({ error: 'Origin not allowed.' }, 403);
      const body = (await request.json().catch(() => ({}))) as { code?: string; money?: boolean };
      if (body.money) return json({ error: 'Money tables are not available yet.' }, 200, h);
      const code = String(body.code ?? '').trim().toUpperCase();
      if (!PartyCodes.isValid(code)) return json({ error: 'Party Create did not generate a valid room code.' }, 200, h);
      await table(env, code).fetch(`https://table/spawn?session=${code}`, { method: 'POST' });
      return json({ code }, 200, h);
    }

    if (url.pathname === '/v1/tables/overflow' && request.method === 'POST') {
      if (!originOk(request, env)) return json({ error: 'Origin not allowed.' }, 403);
      const body = (await request.json().catch(() => ({}))) as { money?: boolean; failed?: string; minBuyIn?: number };
      if (body.money) return json({ error: 'Money tables are not available yet.' }, 200, h);
      const stake = Number(body.minBuyIn) > 0 ? Number(body.minBuyIn) : StakeSessionNames.parseMinBuyIn(String(body.failed ?? ''));
      for (let n = 2; n <= MAX_OVERFLOW; n++) {
        const name = StakeSessionNames.overflow(false, stake, n);
        const occ = (await (await table(env, name).fetch(`https://table/occupancy?session=${name}`)).json()) as { full: boolean };
        if (!occ.full) return json({ session: name }, 200, h);
      }
      return json({ error: 'Every overflow table is full.' }, 200, h);
    }

    if (url.pathname === '/v1/admin/drain' && request.method === 'POST') {
      if (!env.DRAIN_TOKEN || request.headers.get('authorization') !== `Bearer ${env.DRAIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
      const open = await env.DB.prepare('SELECT DISTINCT room FROM table_sessions WHERE closed_at IS NULL').all<{ room: string }>();
      const rooms = open.results.map((r) => r.room);
      const startedAt = Date.now();
      await Promise.all(rooms.map((room) => table(env, room).fetch(`https://table/drain?session=${encodeURIComponent(room)}`, { method: 'POST' })));
      // A drained room has no live table. Rows still open for it belong to tables that died without closing (an
      // eviction or a deploy before drains existed): mark them closed so they stop being listed. Their seat locks are
      // untouched and pay back at the players' next sit-down.
      if (rooms.length) {
        await env.DB.batch(rooms.map((room) => env.DB.prepare('UPDATE table_sessions SET closed_at = ?2 WHERE room = ?1 AND closed_at IS NULL').bind(room, startedAt)));
      }
      return json({ drained: rooms }, 200);
    }

    if (url.pathname === '/v1/admin/audit' && request.method === 'GET') {
      if (!env.DRAIN_TOKEN || request.headers.get('authorization') !== `Bearer ${env.DRAIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
      const room = canonicalSession(url.searchParams.get('room'));
      if (!room) return json({ error: 'room?' }, 400);
      const tables = await env.DB.prepare('SELECT id FROM table_sessions WHERE room = ?1 ORDER BY opened_at').bind(room).all<{ id: string }>();
      const audits = await Promise.all(tables.results.map((t) => auditTable(env.DB, t.id)));
      return json({ room, tables: audits }, 200);
    }

    return json({ error: 'not found' }, 404, h);
  },
} satisfies ExportedHandler<Env>;
