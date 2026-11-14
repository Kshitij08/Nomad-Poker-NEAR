#!/usr/bin/env node
// Builds the web app against a stage's API and game server and deploys it to the Vercel project as a prebuilt
// output. (`vercel build` cannot run on this Windows machine — it fails creating symlinks — and a remote Vercel build
// of apps/web alone would not have the workspace packages.)
//   node scripts/deploy-vercel.mjs staging          # production deploy of nomad-poker-near-app, wired to staging
//   node scripts/deploy-vercel.mjs staging --preview # a preview URL instead
// Needs apps/web/.vercel/project.json (vercel link / pull); it is git-ignored.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { securityHeaders } from './securityHeaders.mjs';
import { STAGES } from './stages.mjs';

const stage = process.argv[2] ?? 'staging';
const env = STAGES[stage];
if (!env) throw new Error(`unknown stage ${stage}`);
const preview = process.argv.includes('--preview');
const web = new URL('..', import.meta.url);
const at = (p) => new URL(p, web);
if (!existsSync(at('.vercel/project.json'))) throw new Error('apps/web is not linked: run `npx vercel@latest link` (project nomad-poker-near-app) first');

const run = (cmd, extra = {}) => execSync(cmd, { cwd: web, stdio: 'inherit', env: { ...process.env, ...extra } });

rmSync(at('dist'), { recursive: true, force: true });
run('npm run build', env);

// Build Output API v3: the static site, cache headers, and the security headers (CSP etc.) on every response.
const out = at('.vercel/output/');
rmSync(out, { recursive: true, force: true });
mkdirSync(at('.vercel/output/static'), { recursive: true });
cpSync(at('dist'), at('.vercel/output/static'), { recursive: true });
writeFileSync(
  at('.vercel/output/config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/(.*)$', headers: securityHeaders({ api: env.VITE_API_URL, game: env.VITE_NET_SERVER, per: env.VITE_PER_BACKEND }), continue: true },
        { src: '^/assets/([^/]+)\\.(js|css)$', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, continue: true },
        { src: '^/assets/([^/]+)/(.*)$', headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=604800' }, continue: true },
        { handle: 'filesystem' },
      ],
    },
    null,
    2,
  ),
);
run(`npx -y vercel@latest deploy --prebuilt --yes${preview ? '' : ' --prod'}`);
