#!/usr/bin/env node
// End-to-end check of a deployed API: guest sign-in, wallet sign-in (throwaway ed25519 key), guest → wallet link,
// /me and the ledger. Creates test players only; touches no real wallet or funds.
//   node scripts/smoke.mjs https://nomad-poker-api-staging.kshitijiitgn.workers.dev [origin]

const base = (process.argv[2] ?? 'http://localhost:8788').replace(/\/$/, '');
const origin = process.argv[3] ?? 'http://localhost:5180';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  const d = [];
  for (const b of bytes) {
    let c = b;
    for (let i = 0; i < d.length; i++) {
      c += d[i] << 8;
      d[i] = c % 58;
      c = (c / 58) | 0;
    }
    while (c) {
      d.push(c % 58);
      c = (c / 58) | 0;
    }
  }
  let s = '';
  for (const b of bytes) {
    if (b) break;
    s += '1';
  }
  for (let i = d.length - 1; i >= 0; i--) s += B58[d[i]];
  return s;
}

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

async function wallet() {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const address = b58(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  return { address, sign: async (m) => b58(new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(m)))) };
}

async function walletSignIn(w, token) {
  const ch = await call('POST', '/v1/auth/wallet/challenge', { address: w.address });
  check('wallet challenge', ch.status === 200 && ch.body.message.includes(w.address), ch);
  return call('POST', '/v1/auth/wallet/verify', { address: w.address, nonce: ch.body.nonce, signature: await w.sign(ch.body.message) }, token);
}

const health = await call('GET', '/v1/health');
check('health', health.status === 200 && health.body.ok, health);
check('CORS echoes the app origin', health.cors === origin, health.cors);

const guest = await call('POST', '/v1/auth/guest', {});
check('guest sign-in', guest.status === 201 && guest.body.player.kind === 'guest', guest);
const gMe = await call('GET', '/v1/me', undefined, guest.body.token);
check('guest sees the 10,000 coin starter balance', gMe.body?.balances?.coins === 10000, gMe);

const w = await wallet();
const ws = await walletSignIn(w);
check('new wallet → registered player', ws.status === 201 && ws.body.player.kind === 'registered', ws);
const wMe = await call('GET', '/v1/me', undefined, ws.body.token);
check('wallet player sees its balance and identity', wMe.body?.balances?.coins === 10000 && wMe.body.identities[0]?.label === w.address, wMe);
const again = await walletSignIn(w);
check('same wallet signs in to the same player', again.status === 200 && again.body.player.id === ws.body.player.id, again);

const w2 = await wallet();
const linked = await walletSignIn(w2, guest.body.token);
check('guest links a wallet and keeps its id', linked.body?.linked === true && linked.body.player.id === guest.body.player.id, linked);

const ledger = await call('GET', '/v1/ledger', undefined, ws.body.token);
check('ledger lists the starter entry', ledger.body?.entries?.[0]?.reason === 'starter' && ledger.body.balances.coins === 10000, ledger);

const out = await call('POST', '/v1/auth/sign-out', undefined, ws.body.token);
const after = await call('GET', '/v1/me', undefined, ws.body.token);
check('sign-out ends the session', out.status === 204 && after.status === 401, { out: out.status, after: after.status });

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
