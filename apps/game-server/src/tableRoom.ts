import { DurableObject } from 'cloudflare:workers';
import { realClock } from '@nomad/table-server/clock';
import type { AgentRow } from '@nomad/db/agents';
import type { Env } from './env';
import { HandRecorder } from './handRecorder';
import { tournamentBySession } from '@nomad/db/tournaments';
import { TableHost, type HostSocket, type LogFn } from './tableHost';
import { TournamentHost } from './tournamentHost';
import { TableSlot } from './tableSlot';
import { escrowClient, moneyTablesOn } from './chain';

/**
 * One table, as a Durable Object named by its session ('poker-free', 'poker-free-st50-2', a party code…). The logic
 * is TableSlot / TableHost; this class only adapts Durable Object requests and WebSockets to it.
 *
 * Internal routes (the Worker calls them; never exposed directly):
 *   GET  /ws?session=           WebSocket: the client sends `join`, then the table RPCs (the local server's protocol)
 *   POST /spawn?session=        mark a party room as created (PokerDedicatedPartySpawner)
 *   GET  /occupancy             { open, players, full } for overflow placement
 *   GET  /holds?player=&table=  does this table still hold that seat? (before paying a stranded stack back)
 *   GET  /hosts?table=          is that table session (a SOL table) still running here? (the escrow sweep)
 *   POST /drain                 finish the hand, pay everyone out, close (before a deploy)
 *   POST /open?session=         open the room now (the cron, a few minutes before a tournament starts)
 *   POST /agents/seat?session=  body: an agent_deployments row → { seated } (opens the table if needed)
 *   POST /agents/stop?id=       the owner pressed Stop → { ok }
 *   GET  /agents/holds?id=      is that Agent still playing here? (before the stale sweep pays it back)
 *
 * Sockets use the standard (non-hibernating) API: a table runs timers the whole time it has players, and the object
 * goes idle, and can be evicted, only after the room has closed. A table with only Agents has no sockets, so while
 * anything is seated an alarm wakes the object every 30 s (and refreshes the Agents' rows).
 */
export class TableRoom extends DurableObject<Env> {
  private slot: TableSlot | null = null;
  private sweep: ReturnType<typeof setInterval> | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const slot = this.slotFor(url.searchParams.get('session'));
    switch (url.pathname) {
      case '/ws':
        if (!slot) return new Response('no session', { status: 400 });
        return this.acceptSocket(request, slot);
      case '/spawn':
        await this.ctx.storage.put('spawned', true);
        return Response.json({ ok: true });
      case '/occupancy':
        return Response.json(slot?.occupancy() ?? { open: false, players: 0, full: false });
      case '/hosts':
        return Response.json({ hosts: slot?.hostsTable(url.searchParams.get('table') ?? '') ?? false });
      case '/holds':
        return Response.json({ holds: slot?.holds(url.searchParams.get('player') ?? '', url.searchParams.get('table') ?? '') ?? false });
      case '/drain':
        await slot?.drain();
        this.stopSweep();
        return Response.json({ ok: true });
      case '/open': {
        if (!slot) return new Response('no session', { status: 400 });
        const r = await slot.ensureOpen();
        if (r.ok && slot.busy) await this.keepAwake();
        return Response.json(r);
      }
      case '/agents/seat': {
        if (!slot) return new Response('no session', { status: 400 });
        const row = (await request.json()) as AgentRow;
        const r = await slot.seatAgent(row);
        if (r.seated) await this.keepAwake();
        return Response.json(r);
      }
      case '/agents/stop':
        return Response.json({ ok: slot?.stopAgent(url.searchParams.get('id') ?? '') ?? false });
      case '/agents/holds':
        return Response.json({ holds: slot?.holdsAgent(url.searchParams.get('id') ?? '') ?? false });
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private slotFor(session: string | null): TableSlot | null {
    if (this.slot) return this.slot;
    if (!session) return null;
    const env = this.env;
    const log: LogFn = (level, m) => console[level === 'info' ? 'log' : level](`[${session}] ${m}`);
    this.slot = new TableSlot({
      session,
      isSpawned: async () => (await this.ctx.storage.get<boolean>('spawned')) === true,
      qaRooms: env.QA_ROOMS === '1',
      moneyTables: moneyTablesOn(env),
      qaSpeed: Number(env.QA_ROOM_SPEED) || 1,
      log,
      createHost: async (spec, speed) => {
        this.startSweep();
        if (spec.kind === 'tournament') {
          const t = await tournamentBySession(env.DB, spec.name);
          if (!t) throw new Error(`Tournament '${spec.name}' was not found.`);
          return new TournamentHost({ spec, db: env.DB, tournamentId: t.id, clock: realClock(speed), log });
        }
        const escrow = spec.properties.mode === 'chain' ? await escrowClient(env, log) : undefined;
        return new TableHost({
          spec,
          escrow: escrow ?? undefined,
          db: env.DB,
          clock: realClock(speed),
          log,
          recorder: new HandRecorder(session, (key, body) => env.HANDS.put(key, body, { httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' } }).then(() => undefined), log),
          stillSeatedElsewhere: async (lock) => {
            const res = await env.TABLES.get(env.TABLES.idFromName(lock.room)).fetch(
              `https://table/holds?session=${encodeURIComponent(lock.room)}&player=${encodeURIComponent(lock.player_id)}&table=${encodeURIComponent(lock.table_id)}`,
            );
            return ((await res.json()) as { holds: boolean }).holds;
          },
        });
      },
    });
    return this.slot;
  }

  private acceptSocket(request: Request, slot: TableSlot): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    void this.keepAwake();
    const sock: HostSocket = {
      send: (data) => {
        try {
          server.send(data);
        } catch {
          /* closing */
        }
      },
      close: (code, reason) => {
        try {
          server.close(code ?? 1000, reason ?? '');
        } catch {
          /* already closed */
        }
      },
    };
    server.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') void slot.message(sock, ev.data); // clients send JSON control frames only
    });
    server.addEventListener('close', () => slot.disconnect(sock));
    server.addEventListener('error', () => slot.disconnect(sock));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** While the table has players or Agents, an alarm keeps waking the object (timers alone don't keep it resident). */
  private async keepAwake(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  async alarm(): Promise<void> {
    const slot = this.slot;
    if (!slot?.busy) return; // a fresh object (evicted meanwhile) or an empty table: let it sleep
    slot.touchAgents();
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  /** PokerDedicatedIdleQuit: close the table once it has idled empty; stop ticking so the object can be evicted. */
  private startSweep(): void {
    this.sweep ??= setInterval(() => {
      void this.slot?.sweepIdle().then((closed) => {
        if (closed) this.stopSweep();
      });
    }, 5000);
  }

  private stopSweep(): void {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }
}
