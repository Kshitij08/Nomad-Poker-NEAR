#!/usr/bin/env node
// End-to-end check of a deployed API: health and CORS, guest sign-in, /me, the ledger and sign-out. Creates test
// players only; touches no real account or funds. (NEAR sign-in needs a real testnet account's key: see near.test.ts.)
//   node scripts/smoke.mjs https://nomad-poker-near-api-staging.kshitijiitgn.workers.dev [origin]

const base = (process.argv[2] ?? 'http://localhost:8788').replace(/\/$/, '');
const origin = process.argv[3] ?? 'http://localhost:5180';

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function call(method, path, body, token) {
  const headers = { origin };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cors: res.headers.get('access-control-allow-origin') };
}

const health = await call('GET', '/v1/health');
check('health', health.status === 200 && health.body.ok, health);
check('CORS echoes the app origin', health.cors === origin, health.cors);

const guest = await call('POST', '/v1/auth/guest', {});
check('guest sign-in', guest.status === 201 && guest.body.player.kind === 'guest', guest);
const token = guest.body.token;
const gMe = await call('GET', '/v1/me', undefined, token);
check('guest sees the 10,000 coin starter balance', gMe.body?.balances?.coins === 10000, gMe);

const ledger = await call('GET', '/v1/ledger', undefined, token);
check('ledger lists the starter entry', ledger.body?.entries?.[0]?.reason === 'starter' && ledger.body.balances.coins === 10000, ledger);

const out = await call('POST', '/v1/auth/sign-out', undefined, token);
const after = await call('GET', '/v1/me', undefined, token);
check('sign-out ends the session', out.status === 204 && after.status === 401, { out: out.status, after: after.status });

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
