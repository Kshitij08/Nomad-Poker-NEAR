/**
 * Phase 5 exit gate (tournaments), against the deployed servers: a host and eight fresh staging guests. The host
 * creates a tournament (host prize + entry fee) on the API, all eight register (fees leave through the ledger), the
 * game server's cron opens the TRN room before the start, eight real web clients (ClientGame + NetConnection in
 * game-server mode) connect with their Nomad tokens and play it out, and 1st and 2nd are paid through the ledger.
 *
 *   npx tsx scripts/tournament-check.ts [stage=staging]
 *
 * Creates test players only. Writes results/tournament-<time>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PlayerAction, type LegalActions } from '@nomad/engine/actions/actions';
import type { LedgerResponse, SessionResponse } from '@nomad/contract';
import { connectTable } from '../../web/src/net/matchmaking';
import { headlessClient, type Headless } from '../../web/server/__tests__/headlessClient';

const stage = process.argv[2] ?? 'staging';
const API = { staging: 'https://nomad-poker-api-staging.kshitijiitgn.workers.dev' }[stage]!;
const GAME = { staging: 'https://nomad-poker-game-staging.kshitijiitgn.workers.dev' }[stage]!;
const ENTRY = 500;
const PRIZE = 2000;
const CLIENT_SPEED = 4; // client-side animation waits only; the room runs in real time
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface View {
  id: string;
  name: string;
  status: string;
  players: number;
  joinCode: string;
  sessionName: string;
  serverReady: boolean;
  firstPrize: number;
  secondPrize: number;
  myStatus: string;
  myPlace: number;
  myPrize: number;
  cancelReason: string;
}

async function api<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5180', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

/** Shoves often (so eight players finish in minutes), else checks or calls. */
function gambler(legal: LegalActions): PlayerAction {
  if (legal.canAllIn && Math.random() < 0.35) return PlayerAction.allIn();
  if (legal.canCheck) return PlayerAction.check();
  if (legal.canCall) return PlayerAction.call();
  return PlayerAction.fold();
}

async function main(): Promise<void> {
  const host = await api<SessionResponse>('POST', '/v1/auth/guest', undefined, { displayName: 'TrnHost' });
  const players: { name: string; token: string; id: string; code: string }[] = [];
  for (let i = 1; i <= 8; i++) {
    const s = await api<SessionResponse>('POST', '/v1/auth/guest', undefined, { displayName: `TrnP${i}` });
    players.push({ name: `TrnP${i}`, token: s.token, id: s.player.id, code: s.player.friendCode });
  }
  const startsAtUnix = Math.floor(Date.now() / 1000) + 75;
  const made = await api<{ tournament: View }>('POST', '/v1/tournaments', host.token, {
    name: `QA Cup ${new Date().toISOString().slice(11, 16)}`, entryFee: ENTRY, hostPrize: PRIZE, maxPlayers: 8, speed: 'turbo', visibility: 'private', startsAtUnix,
  });
  const id = made.tournament.id;
  log(`created ${id} (code ${made.tournament.joinCode}), starts in 75 s`);
  for (const p of players) {
    const byCode = await api<{ tournament: View }>('GET', `/v1/tournaments/code/${made.tournament.joinCode}`, p.token);
    await api('POST', `/v1/tournaments/${byCode.tournament.id}/register`, p.token, {});
  }
  const balancesAfterEntry = await Promise.all(players.map(async (p) => (await api<LedgerResponse>('GET', '/v1/ledger?limit=5', p.token)).balances.coins));
  log(`8 registered; balances ${balancesAfterEntry.join(', ')}`);

  // Where to connect (shown to registered players a few minutes before the start).
  let v = (await api<{ tournament: View }>('GET', `/v1/tournaments/${id}`, players[0]!.token)).tournament;
  for (let i = 0; i < 30 && !v.serverReady; i++) {
    await sleep(2000);
    v = (await api<{ tournament: View }>('GET', `/v1/tournaments/${id}`, players[0]!.token)).tournament;
  }
  if (!v.serverReady) throw new Error('the tournament room never became ready');
  log(`room ${v.sessionName}; prizes ${v.firstPrize} / ${v.secondPrize}`);

  const clients: Headless[] = [];
  for (const p of players) {
    const r = await connectTable({ kind: 'join', code: v.sessionName }, { url: GAME, delay: (ms) => sleep(ms / CLIENT_SPEED) });
    if (!r.ok) throw new Error(`${p.name} could not join ${v.sessionName}: ${r.message}`);
    const h = headlessClient(r.conn!, { name: p.name, token: `trn-${p.name}`, playerId: p.name, coins: 10_000, speed: CLIENT_SPEED, ticket: () => p.token });
    h.panel.policy = gambler;
    h.game.start();
    clients.push(h);
  }
  log('8 clients connected');

  let last = '';
  for (;;) {
    v = (await api<{ tournament: View }>('GET', `/v1/tournaments/${id}`, players[0]!.token)).tournament;
    const hands = clients.reduce((n, c) => n + c.game.handsSeen, 0);
    const line = `${v.status}${v.cancelReason ? ` (${v.cancelReason})` : ''}, hands seen ${hands}`;
    if (line.split(',')[0] !== last.split(',')[0] || Date.now() % 30_000 < 3000) log(line);
    last = line;
    if (['finished', 'cancelled', 'aborted'].includes(v.status)) break;
    if (Date.now() - t0 > 40 * 60_000) throw new Error('the tournament took over 40 minutes');
    await sleep(3000);
  }
  for (const c of clients) {
    c.game.stop();
    c.conn.close();
  }

  const results = [];
  for (const p of players) {
    const mine = (await api<{ tournament: View }>('GET', `/v1/tournaments/${id}`, p.token)).tournament;
    const l = await api<LedgerResponse>('GET', '/v1/ledger?limit=20', p.token);
    const entries = l.entries.filter((e) => e.ref === id).map((e) => ({ reason: e.reason, delta: e.delta }));
    results.push({ name: p.name, place: mine.myPlace, prize: mine.myPrize, status: mine.myStatus, balance: l.balances.coins, entries });
  }
  results.sort((a, b) => a.place - b.place);
  const hostLedger = await api<LedgerResponse>('GET', '/v1/ledger?limit=20', host.token);
  const hostEntries = hostLedger.entries.filter((e) => e.ref === id).map((e) => ({ reason: e.reason, delta: e.delta }));
  const net = [...results.flatMap((r) => r.entries), ...hostEntries].reduce((s, e) => s + e.delta, 0);
  for (const r of results) log(`#${r.place} ${r.name}: prize ${r.prize}, balance ${r.balance}, ledger ${JSON.stringify(r.entries)}`);

  const pool = PRIZE + 8 * ENTRY;
  const second = Math.floor(pool * 0.4);
  const pass =
    v.status === 'finished' &&
    results.map((r) => r.place).join() === '1,2,3,4,5,6,7,8' &&
    results[0]!.prize === pool - second && results[1]!.prize === second &&
    results[0]!.balance === 10_000 - ENTRY + (pool - second) && results[1]!.balance === 10_000 - ENTRY + second &&
    results.slice(2).every((r) => r.balance === 10_000 - ENTRY) &&
    net === 0;
  const report = { stage, at: new Date().toISOString(), tournament: id, session: v.sessionName, status: v.status, pool, results, host: hostEntries, ledgerNet: net, pass };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  const file = new URL(`../results/tournament-${Date.now()}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(report, null, 2));
  log(`${pass ? 'PASS' : 'FAIL'}: ledger net ${net}; report ${file.pathname}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
