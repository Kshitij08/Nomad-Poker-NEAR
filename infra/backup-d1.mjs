#!/usr/bin/env node
// Off-site copy of a stage's D1 database (Phase 7). D1 already keeps point-in-time history (Time Travel, restore to any
// minute in the retention window); this adds a dated SQL dump in R2 that outlives it and can be imported anywhere.
//   node infra/backup-d1.mjs staging          # export, gzip, upload to R2: backups/d1/<date>/<bookmark>.sql.gz
//   node infra/backup-d1.mjs staging --keep   # also keep the .sql.gz under infra/backups/ (git-ignored)
// Restore options (see infra/cloudflare.md): `cf d1 time-travel restore <db> --timestamp <iso>` for a recent minute,
// or `cf d1 import <db>` with a dump into a fresh database.
// Note: an export makes the database briefly unavailable while it runs (seconds at today's size).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const STAGES = {
  staging: { db: '50f75a10-aabe-4ffc-874a-30e2565d2934', bucket: 'nomad-poker-near-hands-staging' },
  production: { db: 'no-near-production-db-yet', bucket: 'nomad-poker-near-hands-production' },
};
const stage = process.argv[2] ?? 'staging';
const s = STAGES[stage];
if (!s) throw new Error(`unknown stage ${stage}`);
const keep = process.argv.includes('--keep');
const shell = process.platform === 'win32';
const cf = (...args) => JSON.parse(execFileSync('cf', args, { encoding: 'utf8', shell }));

let r = cf('d1', 'export', s.db, '--output-format', 'polling');
for (let i = 0; r.status !== 'complete'; i++) {
  if (r.status === 'error' || i > 120) throw new Error(`export failed: ${JSON.stringify(r)}`);
  await new Promise((res) => setTimeout(res, 1000));
  r = cf('d1', 'export', s.db, '--output-format', 'polling', '--current-bookmark', r.at_bookmark);
}
const sql = Buffer.from(await (await fetch(r.result.signed_url)).arrayBuffer());
const gz = gzipSync(sql);
const date = new Date().toISOString().slice(0, 10);
const key = `backups/d1/${date}/${r.at_bookmark}.sql.gz`;
const dir = new URL('./backups/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`${stage}-${date}-${r.at_bookmark}.sql.gz`, dir);
writeFileSync(file, gz);
execFileSync('cf', ['r2', 'buckets', 'objects', 'upload', key, '--bucket-name', s.bucket, '--file', file.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--content-type', 'application/gzip'], { stdio: 'ignore', shell });
if (!keep) rmSync(file);
console.log(JSON.stringify({ stage, bookmark: r.at_bookmark, sqlBytes: sql.length, gzBytes: gz.length, r2: `${s.bucket}/${key}`, kept: keep ? file.pathname : null }));
