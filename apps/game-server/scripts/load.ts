/**
 * Phase 7 load test, against a deployed game server: PLAYERS signed-in web clients (ClientGame + NetConnection, the
 * real client) spread over ROOMS QA tables (run 20× faster on staging), playing for MINUTES, then leaving. Reports
 * join times, hands, client errors and reconnects, and the ledger: every room's drift and the API's reconciliation.
 *
 *   npx tsx scripts/load.ts [players=40] [rooms=8] [minutes=5] [stage=staging] [speed=20]
 *
 * speed 1 runs the tables in real time (room names carry `-x1-`, roomSpec.qaSpeed): real players' traffic, for sizing.
 *
 * Guests are created once and reused (sign-in is limited to 30 a minute per address); their tokens are kept in
 * .load-guests.<stage>.json (git-ignored). Reads DRAIN_TOKEN from .secrets.<stage>.json for the audit route and, when
 * set, NOMAD_ADMIN_TOKEN for the reconciliation. Writes results/load-<time>.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PlayerAction, type LegalActions } from '@nomad/engine/actions/actions';
import type { SessionResponse } from '@nomad/contract';
import { connectTable } from '../../web/src/net/matchmaking';
import { headlessClient, until, type Headless } from '../../web/server/__tests__/headlessClient';

const PLAYERS = Number(process.argv[2] ?? 40);
const ROOMS = Number(process.argv[3] ?? 8);
const MINUTES = Number(process.argv[4] ?? 5);
const stage = process.argv[5] ?? 'staging';
const API = { staging: 'https://nomad-poker-near-api-staging.kshitijiitgn.workers.dev' }[stage]!;
const GAME = { staging: 'https://nomad-poker-near-game-staging.kshitijiitgn.workers.dev' }[stage]!;
const SPEED = Number(process.argv[6] ?? 20);
const STAKE = 100;
const BUY_IN = 500;
const { DRAIN_TOKEN } = JSON.parse(readFileSync(new URL(`../.secrets.${stage}.json`, import.meta.url), 'utf8')) as { DRAIN_TOKEN: string };
const guestsFile = new URL(`../.load-guests.${stage}.json`, import.meta.url);
const run = Date.now().toString(36);
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5180', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

async function guests(n: number): Promise<{ name: string; token: string; id: string }[]> {
  const have: { name: string; token: string; id: string }[] = existsSync(guestsFile) ? JSON.parse(readFileSync(guestsFile, 'utf8')) : [];
  const live: typeof have = [];
  for (const g of have) if ((await api('GET', '/v1/me', g.token)).status === 200) live.push(g);
  while (live.length < n) {
    const r = await api<SessionResponse>('POST', '/v1/auth/guest', undefined, { displayName: `Load${live.length + 1}` });
    if (r.status === 429) {
      log(`sign-in limit; ${live.length}/${n} guests, waiting`);
      await sleep(20_000);
      continue;
    }
    if (r.status !== 201) throw new Error(`guest: ${r.status}`);
    live.push({ name: `Load${live.length + 1}`, token: r.body.token, id: r.body.player.id });
    writeFileSync(guestsFile, JSON.stringify(live));
  }
  return live.slice(0, n);
}

/** A mix: mostly check / call, sometimes a raise, sometimes a fold: real betting traffic, few busts. */
function mixed(legal: LegalActions): PlayerAction {
  const r = Math.random();
  if (r < 0.1 && (legal.canBet || legal.canRaise)) return legal.canBet ? PlayerAction.bet(legal.minRaiseTo) : PlayerAction.raise(legal.minRaiseTo);
  if (r < 0.25 && legal.canFold && !legal.canCheck) return PlayerAction.fold();
  if (legal.canCheck) return PlayerAction.check();
  if (legal.canCall && legal.callAmount <= 50) return PlayerAction.call();
  return legal.canFold ? PlayerAction.fold() : PlayerAction.check();
}

interface Seat {
  g: { name: string; token: string; id: string };
  room: string;
  client: Headless | null;
  joinMs: number[];
  hands: number;
  rejoins: number;
  errors: string[];
}

async function sit(s: Seat): Promise<void> {
  const started = Date.now();
  const r = await connectTable({ kind: 'join', code: s.room }, { url: GAME, delay: (ms) => sleep(ms / SPEED) });
  if (!r.ok) throw new Error(`${s.g.name} could not join ${s.room}: ${r.message}`);
  const h = headlessClient(r.conn!, { name: s.g.name, token: `load-${s.g.name}`, playerId: s.g.name, coins: 10_000, speed: SPEED, buyIn: BUY_IN, ticket: () => s.g.token });
  h.panel.policy = mixed;
  h.game.start();
  await until(() => h.game.localSeat >= 0, 30_000, `${s.g.name} seated`);
  s.joinMs.push(Date.now() - started);
  s.client = h;
}

async function main(): Promise<void> {
  log(`${PLAYERS} players in ${ROOMS} rooms for ${MINUTES} min at ${SPEED}x against ${GAME}`);
  const gs = await guests(PLAYERS);
  const seats: Seat[] = gs.map((g, i) => ({ g, room: `qa-load-${run}-${i % ROOMS}${SPEED === 20 ? '' : `-x${SPEED}`}-st${STAKE}`, client: null, joinMs: [], hands: 0, rejoins: 0, errors: [] }));
  // Everyone joins at once (in waves of 10), the hard part for a cold Durable Object.
  for (let i = 0; i < seats.length; i += 10) {
    await Promise.all(seats.slice(i, i + 10).map((s) => sit(s).catch((e) => s.errors.push(String((e as Error).message)))));
  }
  log(`seated ${seats.filter((s) => s.client).length}/${seats.length}`);

  const end = Date.now() + MINUTES * 60_000;
  let last = 0;
  while (Date.now() < end) {
    await sleep(2000);
    for (const s of seats) {
      if (s.client && s.client.game.localSeat < 0) {
        s.hands += s.client.game.handsSeen;
        s.client.game.stop();
        s.client.conn.close();
        s.client = null;
        s.rejoins++;
        await sit(s).catch((e) => s.errors.push(String((e as Error).message)));
      }
    }
    if (Date.now() - last > 30_000) {
      last = Date.now();
      log(`hands so far ${seats.reduce((n, s) => n + s.hands + (s.client?.game.handsSeen ?? 0), 0)}, seated ${seats.filter((s) => s.client && s.client.game.localSeat >= 0).length}`);
    }
  }

  log('time up; leaving');
  for (const s of seats) if (s.client) s.client.game.requestLeaveTable();
  for (const s of seats) {
    if (!s.client) continue;
    await until(() => s.client!.game.localSeat < 0, 30_000, `${s.g.name} left`).catch((e) => s.errors.push(String((e as Error).message)));
    s.hands += s.client.game.handsSeen;
    s.client.game.stop();
    s.client.conn.close();
  }

  type Audit = { tableId: string; hands: number; seatedPlayers: number; drift: number };
  const rooms = [...new Set(seats.map((s) => s.room))];
  const audits: { room: string; tables: Audit[] }[] = [];
  for (const room of rooms) {
    let a: { tables: Audit[] } = { tables: [] };
    for (let i = 0; i < 30; i++) {
      // An overloaded stage can answer with an error page: try again rather than lose the run's report.
      const res = await fetch(`${GAME}/v1/admin/audit?room=${room}`, { headers: { authorization: `Bearer ${DRAIN_TOKEN}` } }).catch(() => null);
      const got = res ? ((await res.json().catch(() => null)) as { tables: Audit[] } | null) : null;
      if (got?.tables) a = got;
      else log(`audit of ${room}: ${res ? `HTTP ${res.status}` : 'no answer'}, retrying`);
      if (a.tables.length && a.tables.every((t) => t.seatedPlayers === 0)) break;
      await sleep(2000);
    }
    audits.push({ room, tables: a.tables });
  }
  const admin = process.env.NOMAD_ADMIN_TOKEN;
  const recon = admin ? (await api<{ ok: boolean; checks: { name: string; ok: boolean; checked: number }[] }>('GET', '/v1/admin/reconcile', admin)).body : null;

  const joins = seats.flatMap((s) => s.joinMs).sort((a, b) => a - b);
  const pct = (p: number) => joins[Math.min(joins.length - 1, Math.floor((p / 100) * joins.length))] ?? null;
  const totalHands = audits.reduce((n, a) => n + a.tables.reduce((m, t) => m + t.hands, 0), 0);
  const drift = audits.reduce((n, a) => n + a.tables.reduce((m, t) => m + Math.abs(t.drift), 0), 0);
  const errors = seats.flatMap((s) => s.errors.map((e) => `${s.g.name}: ${e}`));
  const report = {
    stage, at: new Date().toISOString(), players: PLAYERS, rooms: ROOMS, minutes: MINUTES, speed: SPEED,
    joinMs: { p50: pct(50), p95: pct(95), max: joins[joins.length - 1] ?? null, count: joins.length },
    tableHands: totalHands, handsPerMinute: Math.round(totalHands / MINUTES), clientHandsSeen: seats.reduce((n, s) => n + s.hands, 0),
    rejoins: seats.reduce((n, s) => n + s.rejoins, 0), sequenceErrors: seats.reduce((n, s) => n + (s.client?.game.sequenceErrors ?? 0), 0),
    errors, drift, audits, reconcile: recon,
  };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  const file = new URL(`../results/load-${Date.now()}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(report, null, 2));
  const pass = errors.length === 0 && drift === 0 && (recon?.ok ?? true);
  log(`${pass ? 'PASS' : 'FAIL'}: ${totalHands} table hands, join p50 ${report.joinMs.p50} ms / p95 ${report.joinMs.p95} ms, drift ${drift}, errors ${errors.length}; ${file.pathname}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
