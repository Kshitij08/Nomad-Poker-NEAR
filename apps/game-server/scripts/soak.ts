/**
 * Phase 2 exit gate, against a deployed game server: two signed-in players (fresh staging guests) play HANDS hands
 * with bots at a QA table (run 20× faster), leave, and the ledger must balance with zero drift.
 *
 *   npx tsx scripts/soak.ts [hands=1000] [stage=staging]
 *
 * Uses the real web client (ClientGame + NetConnection). Creates test players only. Reads DRAIN_TOKEN from
 * .secrets.<stage>.json for the admin audit route. Writes the report to results/soak-<room>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PlayerAction, type LegalActions } from '@nomad/engine/actions/actions';
import type { LedgerResponse, SessionResponse } from '@nomad/contract';
import { connectTable } from '../../web/src/net/matchmaking';
import { headlessClient, until, type Headless } from '../../web/server/__tests__/headlessClient';

const HANDS = Number(process.argv[2] ?? 1000);
const stage = process.argv[3] ?? 'staging';
const API = { staging: 'https://nomad-poker-api-staging.kshitijiitgn.workers.dev' }[stage]!;
const GAME = { staging: 'https://nomad-poker-game-staging.kshitijiitgn.workers.dev' }[stage]!;
const SPEED = 20; // QA_ROOM_SPEED on staging
const BUY_IN = 5000;
const { DRAIN_TOKEN } = JSON.parse(readFileSync(new URL(`../.secrets.${stage}.json`, import.meta.url), 'utf8')) as { DRAIN_TOKEN: string };
const room = `qa-soak-${Date.now().toString(36)}`;
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${m}`);

async function api<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5180', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Check when free, call only tiny bets, fold the rest: bleeds about the blinds, so 1,000 hands fit one buy-in. */
function steady(legal: LegalActions): PlayerAction {
  if (legal.canCheck) return PlayerAction.check();
  if (legal.canCall && legal.callAmount <= 10) return PlayerAction.call();
  return PlayerAction.fold();
}

interface Seat {
  name: string;
  token: string;
  playerId: string;
  client: Headless;
  hands: number;
  rejoins: number;
}

async function sit(name: string, token: string): Promise<Headless> {
  const r = await connectTable({ kind: 'join', code: room }, { url: GAME, delay: (ms) => new Promise((res) => setTimeout(res, ms / SPEED)) });
  if (!r.ok) throw new Error(`${name} could not join ${room}: ${r.message}`);
  const h = headlessClient(r.conn!, { name, token: `soak-${name}`, playerId: name, coins: 10_000, speed: SPEED, buyIn: BUY_IN, ticket: () => token });
  h.panel.policy = steady;
  h.game.start();
  await until(() => h.game.localSeat >= 0, 20_000, `${name} seated`);
  return h;
}

async function main(): Promise<void> {
  log(`room ${room}, target ${HANDS} hands, game server ${GAME}`);
  const seats: Seat[] = [];
  for (const name of ['SoakA', 'SoakB']) {
    const s = await api<SessionResponse>('POST', '/v1/auth/guest', undefined, { displayName: name });
    seats.push({ name, token: s.token, playerId: s.player.id, client: await sit(name, s.token), hands: 0, rejoins: 0 });
    log(`${name} (${s.player.id}) seated`);
  }

  let lastReport = 0;
  while (seats.some((s) => s.hands + s.client.game.handsSeen < HANDS)) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const s of seats) {
      if (s.client.game.localSeat < 0 && s.hands + s.client.game.handsSeen < HANDS) {
        // Busted (or dropped): sit down again with a fresh buy-in, as a player would.
        s.hands += s.client.game.handsSeen;
        s.client.game.stop();
        s.client.conn.close();
        s.rejoins++;
        log(`${s.name} lost the seat after ${s.hands} hands; rejoining (${s.rejoins})`);
        s.client = await sit(s.name, s.token);
      }
    }
    if (Date.now() - lastReport > 30_000) {
      lastReport = Date.now();
      log(seats.map((s) => `${s.name} ${s.hands + s.client.game.handsSeen} hands, stack ${s.client.view.seats[s.client.game.localSeat]?.stack ?? '-'}`).join(' | '));
    }
    if (Date.now() - t0 > 3 * 3600_000) throw new Error('soak took over 3 hours');
  }

  log('target reached; leaving');
  for (const s of seats) {
    s.hands += s.client.game.handsSeen;
    s.client.game.requestLeaveTable();
  }
  for (const s of seats) {
    await until(() => s.client.game.localSeat < 0, 20_000, `${s.name} left`);
    s.client.game.stop();
    s.client.conn.close();
  }

  // Cash-outs land at the hand boundary; wait until no seat is held at this room.
  type Audit = { tableId: string; hands: number; buyIns: number; cashOuts: number; botNet: number; seatedStacks: number; seatedPlayers: number; drift: number };
  let audit: { tables: Audit[] } = { tables: [] };
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${GAME}/v1/admin/audit?room=${room}`, { headers: { authorization: `Bearer ${DRAIN_TOKEN}` } });
    audit = (await res.json()) as { tables: Audit[] };
    if (audit.tables.length && audit.tables.every((t) => t.seatedPlayers === 0)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  const players = [];
  for (const s of seats) {
    const l = await api<LedgerResponse>('GET', '/v1/ledger?limit=100', s.token);
    const sum = l.entries.reduce((acc, e) => acc + (e.currency === 'coins' ? e.delta : 0), 0);
    const table = l.entries.filter((e) => e.reason.startsWith('table:')).reduce((acc, e) => acc + e.delta, 0);
    players.push({ name: s.name, playerId: s.playerId, hands: s.hands, rejoins: s.rejoins, balance: l.balances.coins, ledgerSum: sum, tableNet: table, entries: l.entries.length, balanceMatchesEntries: sum === l.balances.coins });
  }
  const totals = audit.tables.reduce(
    (acc, t) => ({ hands: acc.hands + t.hands, buyIns: acc.buyIns + t.buyIns, cashOuts: acc.cashOuts + t.cashOuts, botNet: acc.botNet + t.botNet, drift: acc.drift + t.drift, seated: acc.seated + t.seatedPlayers }),
    { hands: 0, buyIns: 0, cashOuts: 0, botNet: 0, drift: 0, seated: 0 },
  );
  const humansNet = players.reduce((a, p) => a + p.tableNet, 0);
  const pass = totals.drift === 0 && totals.seated === 0 && humansNet + totals.botNet === 0 && players.every((p) => p.balanceMatchesEntries && p.hands >= HANDS);
  const report = { room, stage, target: HANDS, minutes: +((Date.now() - t0) / 60000).toFixed(1), pass, totals, humansNet, players, tables: audit.tables };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`../results/soak-${room}.json`, import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  log(pass ? 'PASS: zero drift' : 'FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
