# Cloudflare resources

Account: `Kshitijiitgn@gmail.com's Account` (`a5e26389a89c0c84a7b4939e38574714`). Managed with the `cf` CLI; the
Worker is described by `apps/api/cloudflare.config.ts` (no Wrangler config). Primary location Asia-Pacific (`apac`).

| Resource | Staging | Production |
|---|---|---|
| API Worker | `nomad-poker-api-staging` · https://nomad-poker-api-staging.kshitijiitgn.workers.dev | `nomad-poker-api` · https://nomad-poker-api.kshitijiitgn.workers.dev (deployed 14 Nov 2026) |
| Game server Worker + `TableRoom` Durable Object | `nomad-poker-game-staging` · https://nomad-poker-game-staging.kshitijiitgn.workers.dev | `nomad-poker-game` · https://nomad-poker-game.kshitijiitgn.workers.dev (deployed 14 Nov 2026) |
| D1 (players, sessions, ledger, seat locks) | `nomad-poker-staging` · `c9570cef-7f57-4845-b503-03da7893d36d` · migrations `0001`–`0005` applied (`0005_agents_tournaments` on 2026-11-09) | `nomad-poker-production` · `e630e086-697c-47c7-84c3-8ad467005c34` · migrations `0001`–`0012` applied 14 Nov 2026 |
| R2 (hand histories, replays) | `nomad-poker-hands-staging` | `nomad-poker-hands-production` |
| Rate limiter (sign-in, 30/min per IP) | namespace `7102` | namespace `7103` |
| DNS zone `nomadpoker.fun` | — | Active on Cloudflare since 14 Nov 2026 (nameservers moved from Hostinger). Apex A `216.150.1.1` and `www` CNAME `cname.vercel-dns.com`, both DNS only (Vercel serves the site) |
| Email | Staging echoes sign-in links (`EMAIL_DEV_ECHO`) | Email Service sends sign-in links from `no-reply@nomadpoker.fun` (API binding `EMAIL`), 1,000/day quota to start. Email Routing forwards `support@nomadpoker.fun` to the owner's Gmail |
| Cron trigger on the game server (Agents sweep, tournament clock) | `* * * * *` | `* * * * *` (when deployed) |

`cf dev` (mode `development`, namespace `7101`) uses local D1/R2 simulations, not the resources above.

The web app is on Vercel (`nomad-poker-web`), deployed with `node apps/web/scripts/deploy-vercel.mjs production` and
wired to the production Workers. Since 14 Nov 2026 it serves https://www.nomadpoker.fun (the apex redirects to `www`,
308); the old Unity build's project (`poker-build-public`) no longer has the domain. `nomad-poker-web.vercel.app` is
the same production build, so the staging Workers have no deployed web front end: use the dev server with
`?api=staging&netServer=staging`, or a preview deploy (`deploy-vercel.mjs staging --preview`).

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
