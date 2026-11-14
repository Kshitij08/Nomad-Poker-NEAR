#!/usr/bin/env node
// Searches a Worker's logs (Workers Logs / observability) for a phrase, newest first.
//   node infra/logs.mjs <worker> "<needle>" [minutes=60] [limit=100]
//   node infra/logs.mjs nomad-poker-near-game-staging "failed after" 120
//   node infra/logs.mjs nomad-poker-near-game-staging "[reconcile] PROBLEMS" 1440
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run the cf CLI's script with node directly: on Windows a shell would mangle the JSON body's quotes.
const cfScript = fileURLToPath(new URL('../node_modules/cf/bin/cf', import.meta.url));

const [worker, needle, minutes = '60', limit = '100'] = process.argv.slice(2);
if (!worker || !needle) {
  console.error('usage: node infra/logs.mjs <worker> "<needle>" [minutes] [limit]');
  process.exit(2);
}
const now = Date.now();
const body = {
  queryId: 'adhoc-logs',
  timeframe: { from: now - Number(minutes) * 60_000, to: now },
  view: 'events',
  limit: Number(limit),
  parameters: {
    datasets: ['cloudflare-workers'],
    filters: [{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: worker }],
    needle: { value: needle, isRegex: false, matchCase: false },
  },
};
const out = execFileSync(process.execPath, [cfScript, 'observability', 'telemetry', 'query', '--body', JSON.stringify(body)], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const j = JSON.parse(out);
const events = j.result?.events?.events ?? j.events?.events ?? [];
for (const e of events) {
  const at = new Date(e.timestamp ?? e.$metadata?.startTime ?? 0).toISOString();
  const msg = e.$metadata?.message ?? e.source?.message ?? JSON.stringify(e.source ?? e).slice(0, 400);
  console.log(`${at}  ${String(msg).slice(0, 600)}`);
}
console.error(`${events.length} event(s)`);
