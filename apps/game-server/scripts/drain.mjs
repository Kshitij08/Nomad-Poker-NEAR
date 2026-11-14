#!/usr/bin/env node
// Before a deploy: ask every open table to finish its hand, pay everyone out and close (POST /v1/admin/drain).
// A deploy restarts every Durable Object, so without this a hand in progress would end at its last checkpoint.
//   node scripts/drain.mjs staging|production
// Reads DRAIN_TOKEN from .secrets.<stage>.json (git-ignored). Skips quietly when the Worker is not deployed yet.
import { existsSync, readFileSync } from 'node:fs';

const stage = process.argv[2] ?? 'staging';
const urls = {
  staging: 'https://nomad-poker-game-staging.kshitijiitgn.workers.dev',
  production: 'https://nomad-poker-game.kshitijiitgn.workers.dev',
};
const base = urls[stage];
if (!base) {
  console.error(`unknown stage ${stage}`);
  process.exit(2);
}
const file = new URL(`../.secrets.${stage}.json`, import.meta.url);
if (!existsSync(file)) {
  console.error(`missing ${file.pathname}: create it with {"DRAIN_TOKEN": "<random>"} (see apps/game-server/README.md)`);
  process.exit(1);
}
const { DRAIN_TOKEN } = JSON.parse(readFileSync(file, 'utf8'));

// No process.exit() after a fetch: on Windows, Node's forced exit while a just-used socket is still closing aborts with
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", which made `npm run deploy:*` stop after the drain. Set the
// exit code and let the script end on its own instead.
async function drain() {
  try {
    const health = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(10_000) });
    if (!health.ok) {
      console.log(`[drain] ${base} is not serving yet (${health.status}); nothing to drain.`);
      return 0;
    }
  } catch {
    console.log(`[drain] ${base} is not reachable; nothing to drain.`);
    return 0;
  }
  const res = await fetch(`${base}/v1/admin/drain`, { method: 'POST', headers: { authorization: `Bearer ${DRAIN_TOKEN}` }, signal: AbortSignal.timeout(150_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[drain] failed: ${res.status} ${JSON.stringify(body)}`);
    return 1;
  }
  console.log(`[drain] closed ${body.drained?.length ?? 0} table(s): ${(body.drained ?? []).join(', ') || 'none open'}`);
  return 0;
}

process.exitCode = await drain();
