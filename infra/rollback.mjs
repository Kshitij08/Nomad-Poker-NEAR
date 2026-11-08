#!/usr/bin/env node
// Rolls a Worker back (or forward) to another uploaded version: a new deployment sending 100 % of traffic to it.
// Takes seconds; no rebuild. Database migrations are not undone (they are additive, so older code keeps working).
//   node infra/rollback.mjs <worker>                 # list the recent deployments (newest first)
//   node infra/rollback.mjs <worker> previous        # deploy the version before the current one
//   node infra/rollback.mjs <worker> <version-id>    # deploy that version
// The game server: drain first (`node apps/game-server/scripts/drain.mjs <stage>`) so tables pay out before the switch.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cf = fileURLToPath(new URL('../node_modules/cf/bin/cf', import.meta.url));
const run = (...args) => JSON.parse(execFileSync(process.execPath, [cf, ...args], { encoding: 'utf8' }));
const [worker, target] = process.argv.slice(2);
if (!worker) {
  console.error('usage: node infra/rollback.mjs <worker> [previous | <version-id>]');
  process.exit(2);
}
const deployments = run('workers', 'deployments', 'list', '--script-name', worker).deployments ?? [];
const versionOf = (d) => d.versions?.[0]?.version_id;
if (!target) {
  for (const d of deployments.slice(0, 10)) console.log(`${d.created_on}  ${versionOf(d)}  ${d.versions.map((v) => v.percentage + '%').join(' ')}`);
  process.exit(0);
}
const current = versionOf(deployments[0]);
const version = target === 'previous' ? deployments.map(versionOf).find((v) => v && v !== current) : target;
if (!version) throw new Error('no earlier version to roll back to');
run('workers', 'deployments', 'create', '--script-name', worker, '--body', JSON.stringify({ strategy: 'percentage', versions: [{ version_id: version, percentage: 100 }] }));
console.log(JSON.stringify({ worker, from: current, to: version }));
