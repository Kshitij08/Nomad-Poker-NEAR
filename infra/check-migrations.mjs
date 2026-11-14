#!/usr/bin/env node
// Refuses to continue while a stage's D1 has migrations not applied yet (run before every Worker deploy: new code may
// write columns the database doesn't have, and the table bookkeeping would retry those writes for minutes).
//   node infra/check-migrations.mjs <stage>
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DBS = { staging: '50f75a10-aabe-4ffc-874a-30e2565d2934', production: 'no-near-production-db-yet' };
const stage = process.argv[2];
if (!DBS[stage]) {
  console.error('usage: node infra/check-migrations.mjs <staging|production>');
  process.exit(2);
}
const cf = fileURLToPath(new URL('../node_modules/cf/bin/cf', import.meta.url));
const dir = fileURLToPath(new URL('../packages/db/migrations', import.meta.url));
const pending = JSON.parse(execFileSync(process.execPath, [cf, 'd1', 'migrations', 'list', '--dir', dir, DBS[stage]], { encoding: 'utf8' }));
if (pending.length) {
  console.error(`${stage} D1 has ${pending.length} migration(s) not applied: ${pending.map((m) => m.name ?? m).join(', ')}`);
  console.error(`apply them first: (cd apps/api && npm run db:migrate:${stage})`);
  process.exit(1);
}
console.log(`${stage} D1: every migration applied`);
