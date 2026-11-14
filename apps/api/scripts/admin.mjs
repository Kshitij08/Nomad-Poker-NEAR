#!/usr/bin/env node
// Support tools from a terminal (Phase 7). Your own session token must belong to an admin_users player.
//   NOMAD_TOKEN=np_… node scripts/admin.mjs [--stage staging] search <name | Friend ID | id>
//   NOMAD_TOKEN=np_… node scripts/admin.mjs show <playerId>
//   NOMAD_TOKEN=np_… node scripts/admin.mjs adjust <playerId> <delta> "<reason>" [currency=coins]
//   NOMAD_TOKEN=np_… node scripts/admin.mjs ban <playerId> "<reason>"
//   NOMAD_TOKEN=np_… node scripts/admin.mjs unban <playerId>
//   NOMAD_TOKEN=np_… node scripts/admin.mjs audit [limit]
// Get a token by signing in on the web app and copying `nomad.session:<api>` from localStorage.
// Adding an admin is an operator step in D1, never an API call:
//   cf d1 query <db-id> --sql "INSERT INTO admin_users (player_id, role, added_at) VALUES ('p_…', 'admin', unixepoch()*1000)"
import { randomUUID } from 'node:crypto';

const APIS = { staging: 'https://nomad-poker-near-api-staging.kshitijiitgn.workers.dev', production: 'https://nomad-poker-near-api.kshitijiitgn.workers.dev', local: 'http://localhost:8788' };
const args = process.argv.slice(2);
const stageAt = args.indexOf('--stage');
const stage = stageAt >= 0 ? args.splice(stageAt, 2)[1] : 'staging';
const api = APIS[stage];
const token = process.env.NOMAD_TOKEN;
if (!api || !token) {
  console.error('usage: NOMAD_TOKEN=np_… node scripts/admin.mjs [--stage staging|production|local] <command> …');
  process.exit(2);
}

async function call(method, path, body) {
  const res = await fetch(api + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'https://nomad-poker-near.vercel.app' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${res.status}: ${json?.error?.message ?? 'request failed'}`);
  return json;
}

const [cmd, a, b, c, d] = args;
const out = await (async () => {
  switch (cmd) {
    case 'search':
      return call('GET', `/v1/admin/players?q=${encodeURIComponent(a ?? '')}`);
    case 'show':
      return call('GET', `/v1/admin/players/${a}`);
    case 'adjust':
      return call('POST', `/v1/admin/players/${a}/adjust`, { delta: Number(b), reason: c, currency: d ?? 'coins', requestId: randomUUID() });
    case 'ban':
      return call('POST', `/v1/admin/players/${a}/ban`, { reason: b });
    case 'unban':
      return call('POST', `/v1/admin/players/${a}/unban`, {});
    case 'audit':
      return call('GET', `/v1/admin/audit?limit=${Number(a) || 50}`);
    default:
      throw new Error(`unknown command ${cmd ?? ''}`);
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
console.log(JSON.stringify(out, null, 2));
