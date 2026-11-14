/**
 * Phase 3 exit gate, against a deployed API: a scripted client cannot grant itself coins, XP or items, and every
 * reward the server pays matches the engine's catalogues. Creates one staging guest; touches nothing else.
 *
 *   npx tsx scripts/rewards-check.ts [api base]
 */
import { DailySpinCatalog, LoginRewardCatalog, MissionCatalog } from '@nomad/engine/retention';
import type { LedgerResponse, ProgressSnapshot, SessionResponse, SpinResponse, LoginClaimResponse, MissionClaimResponse } from '@nomad/contract';

const base = (process.argv[2] ?? 'https://nomad-poker-near-api-staging.kshitijiitgn.workers.dev').replace(/\/$/, '');
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5180', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const g = await call<SessionResponse>('POST', '/v1/auth/guest', undefined, { displayName: 'RewardsCheck' });
const t = g.body.token;
const p0 = (await call<ProgressSnapshot>('GET', '/v1/progress', t)).body;
check('new player: 10,000 coins, level 1, nothing else', p0.balances.coins === 10_000 && p0.balances.xp === 0 && p0.balances.gems === 0 && p0.items.length === 0 && p0.level === 1, p0.balances);

// 1. Forged grants: every plausible route and payload, none of which the server honours.
const forged = { amount: 1e6, chips: 1e6, coins: 1e6, xp: 1e6, gems: 500, delta: 1e6, itemId: 'frame_lv100', item: 'frame_lv100', key: 'daily_spin:x', reason: 'daily_spin', level: 100, day: 7 };
const forgedPaths = ['/v1/ledger', '/v1/ledger/grant', '/v1/rewards/grant', '/v1/rewards/level', '/v1/wallet/grant', '/v1/progress', '/v1/items', '/v1/me', '/v1/missions/progress', '/v1/xp'];
const statuses = new Set<number>();
for (const path of forgedPaths) statuses.add((await call('POST', path, t, forged)).status);
check(`${forgedPaths.length} forged grant routes all refused (status ${[...statuses].join('/')})`, [...statuses].every((s) => s >= 400));

// 2. The real routes ignore whatever a client says about amounts.
const s1 = (await call<SpinResponse>('POST', '/v1/rewards/spin', t, forged)).body;
check('spin pays a catalogue prize', s1.awarded && DailySpinCatalog.Prizes.some((p) => p.coins === s1.coins && p.label === s1.label), s1);
const s2 = (await call<SpinResponse>('POST', '/v1/rewards/spin', t, forged)).body;
check('second spin today refused', !s2.awarded && s2.coins === s1.coins, s2);
const l1 = (await call<LoginClaimResponse>('POST', '/v1/rewards/login', t, forged)).body;
check('login track pays day 1', l1.claimed && l1.day === 1, l1);
const l2 = (await call<LoginClaimResponse>('POST', '/v1/rewards/login', t, forged)).body;
check('second login claim today refused', !l2.claimed, l2);
for (const def of MissionCatalog.All) {
  const m = (await call<MissionClaimResponse>('POST', '/v1/missions/claim', t, { ...forged, id: def.id })).body;
  if (m.ok) check(`mission ${def.id} must not be claimable without hands`, false, m);
}
check('no mission claimable without hands the game server counted', true);
const bogus = (await call<MissionClaimResponse>('POST', '/v1/missions/claim', t, { id: 'mega_bonus' })).body;
check('unknown mission refused', !bogus.ok, bogus);

// 3. Where every coin came from.
const p1 = (await call<ProgressSnapshot>('GET', '/v1/progress', t)).body;
const day1 = LoginRewardCatalog.day(1).primary.amount;
check(`balance = 10,000 + spin ${s1.coins} + day-1 ${day1}; no XP, gems or items`, p1.balances.coins === 10_000 + s1.coins + day1 && p1.balances.xp === 0 && p1.balances.gems === 0 && p1.items.length === 0, p1.balances);
const ledger = (await call<LedgerResponse>('GET', '/v1/ledger?limit=100', t)).body;
check('ledger: starter, daily_spin, login_reward only', JSON.stringify(ledger.entries.map((e) => e.reason).sort()) === JSON.stringify(['daily_spin', 'login_reward', 'starter']), ledger.entries);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
