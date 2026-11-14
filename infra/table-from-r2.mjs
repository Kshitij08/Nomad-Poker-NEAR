#!/usr/bin/env node
// Recomputes a table session's house result from its R2 hand records (every settled hand's botDelta) and compares it
// with table_sessions.bot_net in D1. The hand records are written by the game server independently of the D1
// bookkeeping, so they settle "which side is wrong" when a table shows drift.
//   node infra/table-from-r2.mjs <stage> <room> <tableId> [--fix]
// --fix sets bot_net to the R2 total (only when the hand numbers in R2 are complete: 1..last with no gaps).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const STAGES = {
  staging: { db: '50f75a10-aabe-4ffc-874a-30e2565d2934', bucket: 'nomad-poker-near-hands-staging' },
  production: { db: 'no-near-production-db-yet', bucket: 'nomad-poker-near-hands-production' },
};
const [stage, room, tableId] = process.argv.slice(2);
const fix = process.argv.includes('--fix');
const s = STAGES[stage];
if (!s || !room || !tableId) {
  console.error('usage: node infra/table-from-r2.mjs <stage> <room> <tableId> [--fix]');
  process.exit(2);
}
const cfScript = fileURLToPath(new URL('../node_modules/cf/bin/cf', import.meta.url));
const cf = (args, opts = {}) => execFileSync(process.execPath, [cfScript, ...args], { maxBuffer: 256 * 1024 * 1024, ...opts });

// Hand batches live under hands/<yyyy>/<mm>/<dd>/<room>/<tableId>/; the day is unknown here, so list by day prefixes.
const keys = [];
for (const day of [0, 1, 2].map((d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '/'))) {
  const out = JSON.parse(cf(['r2', 'buckets', 'objects', 'list', '--bucket-name', s.bucket, '--prefix', `hands/${day}/${room}/${tableId}/`], { encoding: 'utf8' }));
  const list = Array.isArray(out) ? out : out.result ?? out.objects ?? [];
  for (const o of list) keys.push(o.key);
}
const hands = new Map();
for (const key of keys) {
  const gz = cf(['r2', 'buckets', 'objects', 'get', key, '--bucket-name', s.bucket]);
  // Stored with Content-Encoding: gzip, so the download may already be decompressed.
  let text;
  try {
    text = gunzipSync(gz).toString();
  } catch {
    text = gz.toString();
  }
  for (const line of text.split('\n').filter(Boolean)) {
    const h = JSON.parse(line);
    hands.set(h.hand, h.botDelta);
  }
}
const numbers = [...hands.keys()].sort((a, b) => a - b);
const last = numbers[numbers.length - 1] ?? 0;
const complete = numbers.length === last && numbers.every((n, i) => n === i + 1);
const r2Total = [...hands.values()].reduce((a, b) => a + b, 0);
const d1 = JSON.parse(cf(['d1', 'query', s.db, '--sql', `SELECT hands, bot_net FROM table_sessions WHERE id = '${tableId.replace(/'/g, '')}'`], { encoding: 'utf8' }));
const row = (d1[0]?.results ?? d1.result?.[0]?.results ?? [])[0] ?? null;
const report = { room, tableId, r2: { objects: keys.length, hands: numbers.length, last, complete, botNet: r2Total }, d1: row, difference: row ? r2Total - row.bot_net : null };
if (fix && row && complete && r2Total !== row.bot_net) {
  cf(['d1', 'query', s.db, '--sql', `UPDATE table_sessions SET bot_net = ${r2Total}, hands = ${last} WHERE id = '${tableId.replace(/'/g, '')}'`], { encoding: 'utf8' });
  report.fixed = true;
}
console.log(JSON.stringify(report));
