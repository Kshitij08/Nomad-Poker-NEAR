/**
 * Phase 5 exit gate (Agents), against the deployed servers: a fresh staging guest deploys an Agent; the game server
 * seats it at a Quick Play table by itself (no farm, no claims), it plays to its hand limit, and its stack comes back
 * through the ledger. A second Agent is stopped by its owner mid-session and pays back too.
 *
 *   npx tsx scripts/agent-check.ts [hands=8] [stage=staging]
 *
 * Creates test players only. Writes results/agents-<time>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { LedgerResponse, SessionResponse } from '@nomad/contract';
import type { AgentDeploymentProgress, AgentDeploymentSummary, AgentHandHistory } from '@nomad/engine/agents';

const HANDS = Number(process.argv[2] ?? 8);
const stage = process.argv[3] ?? 'staging';
const API = { staging: 'https://nomad-poker-api-staging.kshitijiitgn.workers.dev' }[stage]!;
const GAME = { staging: 'https://nomad-poker-game-staging.kshitijiitgn.workers.dev' }[stage]!;
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T>(base: string, method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5180', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

const code = () => 'QA' + Math.random().toString(36).slice(2, 10).toUpperCase();

async function main(): Promise<void> {
  const me = await http<SessionResponse>(API, 'POST', '/v1/auth/guest', undefined, { displayName: 'AgentCheck' });
  const token = me.token;
  const coins = async () => (await http<LedgerResponse>(API, 'GET', '/v1/ledger?limit=20', token)).balances.coins;
  const before = await coins();
  log(`guest ${me.player.id} with ${before} coins`);

  // 1. An Agent that plays to its hand limit.
  const a = code();
  const start = await http<{ session: string; status: string }>(GAME, 'POST', '/v1/agents/start', token, {
    session: a, agentName: 'Check Bot', profile: 'daredevil', strategyVersion: 'v1', bankroll: 2000, stake: 100, maxHands: HANDS, maxRuntime: 1800,
  });
  log(`started ${start.session}: ${start.status}; coins now ${await coins()}`);
  let p: AgentDeploymentProgress | null = null;
  const seen: string[] = [];
  for (;;) {
    p = await http<AgentDeploymentProgress>(GAME, 'GET', `/v1/agents/progress?session=${a}`, token);
    const line = `${p.phase} at ${p.AssignedTable || '-'}: hand ${p.HandsPlayed}/${p.MaxHands}, stack ${p.Stack}`;
    if (seen[seen.length - 1] !== line) {
      seen.push(line);
      log(line);
    }
    if (!p.running) break;
    if (Date.now() - t0 > 15 * 60_000) throw new Error('the Agent took over 15 minutes');
    await sleep(3000);
  }
  const result = await http<AgentDeploymentSummary | null>(GAME, 'GET', `/v1/agents/result?session=${a}`, token);
  const hands = await http<AgentHandHistory>(GAME, 'GET', `/v1/agents/hands?deploymentId=${a}&limit=100`, token);
  const ledger1 = await http<LedgerResponse>(API, 'GET', '/v1/ledger?limit=20', token);
  const agentEntries = ledger1.entries.filter((e) => e.ref === a).map((e) => ({ reason: e.reason, delta: e.delta }));
  log(`result: ${result?.StopReason}, ${result?.HandsPlayed} hands, ending ${result?.EndingStack}; ledger ${JSON.stringify(agentEntries)}`);

  // 2. An Agent its owner stops mid-session.
  const b = code();
  await http(GAME, 'POST', '/v1/agents/start', token, { session: b, agentName: 'Stop Bot', bankroll: 1500, stake: 100, maxHands: 500, maxRuntime: 1800 });
  for (let i = 0; i < 120; i++) {
    const q = await http<AgentDeploymentProgress>(GAME, 'GET', `/v1/agents/progress?session=${b}`, token);
    if (q.HandsPlayed >= 1) break;
    await sleep(2000);
  }
  const stopping = await http<AgentDeploymentProgress>(GAME, 'POST', '/v1/agents/stop', token, { session: b });
  log(`stop pressed: ${stopping.phase}`);
  let stopped: AgentDeploymentSummary | null = null;
  for (let i = 0; i < 60 && !stopped; i++) {
    await sleep(2000);
    stopped = await http<AgentDeploymentSummary | null>(GAME, 'GET', `/v1/agents/result?session=${b}`, token);
  }
  const ledger2 = await http<LedgerResponse>(API, 'GET', '/v1/ledger?limit=20', token);
  const stopEntries = ledger2.entries.filter((e) => e.ref === b).map((e) => ({ reason: e.reason, delta: e.delta }));
  const history = await http<{ Total: number }>(GAME, 'GET', '/v1/agents/history?limit=5', token);
  const after = ledger2.balances.coins;
  log(`stopped: ${stopped?.StopReason}, ${stopped?.HandsPlayed} hands, ending ${stopped?.EndingStack}; balance ${before} → ${after}`);

  const expected = before + (result!.EndingStack - 2000) + (stopped!.EndingStack - 1500);
  const report = {
    stage, at: new Date().toISOString(), player: me.player.id,
    limit: {
      session: a, stopReason: result?.StopReason, handsPlayed: result?.HandsPlayed, endingStack: result?.EndingStack, table: result?.SessionName,
      handRecords: hands.Total, withReplay: hands.Hands?.filter((h) => h.HasReplay).length ?? 0, ledger: agentEntries,
    },
    ownerStop: { session: b, stopReason: stopped?.StopReason, handsPlayed: stopped?.HandsPlayed, endingStack: stopped?.EndingStack, ledger: stopEntries },
    history: history.Total,
    balance: { before, after, expected, matches: after === expected },
    progress: seen,
  };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  const file = new URL(`../results/agents-${Date.now()}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(report, null, 2));
  const pass =
    result?.StopReason === 'max_hands' && result.HandsPlayed === HANDS && hands.Total === HANDS && stopped?.StopReason === 'owner_stop' &&
    report.balance.matches && agentEntries.length === 2 && stopEntries.length === 2;
  log(`${pass ? 'PASS' : 'FAIL'}: report ${file.pathname}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
