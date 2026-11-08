# Cloudflare resources

Account: `Kshitijiitgn@gmail.com's Account` (`a5e26389a89c0c84a7b4939e38574714`). Managed with the `cf` CLI; the
Worker is described by `apps/api/cloudflare.config.ts` (no Wrangler config). Primary location Asia-Pacific (`apac`).

| Resource | Staging | Production |
|---|---|---|
| API Worker | `nomad-poker-api-staging` · https://nomad-poker-api-staging.kshitijiitgn.workers.dev | `nomad-poker-api` · not deployed yet |
| D1 (players, sessions, ledger) | `nomad-poker-staging` · `c9570cef-7f57-4845-b503-03da7893d36d` · migration `0001_init` applied 2026-11-08 | `nomad-poker-production` · `e630e086-697c-47c7-84c3-8ad467005c34` · empty |
| R2 (hand histories, replays) | `nomad-poker-hands-staging` | `nomad-poker-hands-production` |
| Rate limiter (sign-in, 30/min per IP) | namespace `7102` | namespace `7103` |

`cf dev` (mode `development`, namespace `7101`) uses local D1/R2 simulations, not the resources above.

Not created yet: the table Durable Object class (Phase 3) and a production deploy. The web app stays on Vercel
(`nomad-poker-web`) until a Cloudflare Pages move is decided.

Secrets: none yet. Google sign-in will need `GOOGLE_CLIENT_IDS` (a public value, set in the config), and email links
a mail provider; neither is configured, so those routes answer `not_configured` (staging echoes email links instead).
