# Cloudflare resources (NEAR fork)

This repository is the NEAR fork of Nomad Poker. It has its own Cloudflare resources, so nothing deployed from here
touches the live Nomad Poker app (`nomad-poker-api*`, `nomad-poker-game*`, the `nomad-poker-staging` and
`nomad-poker-production` databases, the `nomad-poker-hands-*` buckets, Vercel project `nomad-poker-web`).

Account: `Kshitijiitgn@gmail.com's Account` (`a5e26389a89c0c84a7b4939e38574714`). Managed with the `cf` CLI; the
Workers are described by `apps/api/cloudflare.config.ts` and `apps/game-server/cloudflare.config.ts` (no Wrangler config).

| Resource | Staging | Production |
|---|---|---|
| API Worker | `nomad-poker-near-api-staging` (not deployed yet) | `nomad-poker-near-api`: not set up |
| Game server Worker + `TableRoom` Durable Object | `nomad-poker-near-game-staging` (not deployed yet) | `nomad-poker-near-game`: not set up |
| D1 (players, sessions, ledger, seat locks) | `nomad-poker-near-staging` · `50f75a10-aabe-4ffc-874a-30e2565d2934` · created 14 Nov 2026, no migrations applied yet | not created |
| R2 (hand histories, replays) | `nomad-poker-near-hands-staging` · created 14 Nov 2026 | not created |
| Rate limiters | API `7202` (sign-in) and `7205` (writes); game server `7208` | API `7203` / `7206`; game server `7209` |
| Web front end | Vercel project `nomad-poker-near` (https://nomad-poker-near.vercel.app) serves `near/web` today | — |

`cf dev` (mode `development`; namespaces `7201`, `7204`, `7207`) uses local D1/R2 simulations, not the resources above.

Production refuses to deploy until it has a database: both configs throw while its id is empty. `apps/per` (the live
Solana private-table service) refuses to deploy from this fork at all.

Before the first staging deploy: apply the migrations (`npm run db:migrate:staging` in `apps/api`) and create
`.secrets.staging.json` for each Worker (git-ignored).

The sections below describe procedures inherited from the live app; their commands now point at the fork's resources.

Secrets: the game server's `DRAIN_TOKEN` (admin drain/audit), uploaded from `apps/game-server/.secrets.<stage>.json` (git-ignored). Google sign-in will need `GOOGLE_CLIENT_IDS` (a public value, set in the config), and email links
a mail provider; neither is configured, so those routes answer `not_configured` (staging echoes email links instead).

## Backups and restore (Phase 7)

- **Point in time (built in):** D1 Time Travel keeps every minute of the retention window (30 days on the paid plan,
  7 on free). Restore the whole database to a moment: `cf d1 time-travel restore <db-id> --timestamp <ISO time>`
  (`cf d1 time-travel get-bookmark <db-id>` names the current state first, so the restore itself can be undone).
- **Off-site dumps:** `node infra/backup-d1.mjs <stage>` exports the database to SQL, gzips it and uploads it to the
  stage's R2 bucket at `backups/d1/<date>/<bookmark>.sql.gz`. Restore into a fresh database with `cf d1 import`.
  First run on staging, 9 Nov: 2 MB of SQL (137 KB gzipped); restored into an empty SQLite with every balance equal
  to its ledger entries. Not scheduled yet: it needs a machine or CI job with a Cloudflare API token.
- **Hand histories** are already in R2 (`hands/…`) and are not in the database.
