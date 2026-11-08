# Cloudflare resources

Account: `Kshitijiitgn@gmail.com's Account` (`a5e26389a89c0c84a7b4939e38574714`). Managed with the `cf` CLI.
Created 2026-11-08 in Phase 0; all empty, primary location Asia-Pacific (`apac`).

| Resource | Staging | Production |
|---|---|---|
| D1 (players, ledger, social) | `nomad-poker-staging` · `c9570cef-7f57-4845-b503-03da7893d36d` | `nomad-poker-production` · `e630e086-697c-47c7-84c3-8ad467005c34` |
| R2 (hand histories, replays) | `nomad-poker-hands-staging` | `nomad-poker-hands-production` |

Not created yet (Phase 1/2): the API Worker, the table Durable Object class, and the Workers configuration
(`cloudflare.config.ts`) that binds the resources above. The web app stays on Vercel (`nomad-poker-web`) until a
Cloudflare Pages move is decided.
