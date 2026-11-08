# @nomad/api

The Nomad Poker API: one Cloudflare Worker (Hono) on D1 and R2. Phase 1 covers sign-in, sessions and the play-money
ledger; the contract (routes, types, error codes) is `packages/contract` (`@nomad/contract`).

| Route | What it does |
|---|---|
| `POST /v1/auth/guest` | New guest player with the starter grant (10,000 coins). |
| `POST /v1/auth/wallet/challenge` → `/verify` | Sign In With Solana: the server builds the message, the wallet signs it, the server checks the ed25519 signature. Nonces are single-use and last 5 minutes. |
| `POST /v1/auth/google` | Google ID token, checked against Google's keys and `GOOGLE_CLIENT_IDS` (not configured yet → 501). |
| `POST /v1/auth/email/start` → `/verify` | Email link, 15 minutes, single use. No mail provider yet: staging returns the link as `devLink`; production answers 501. |
| `POST /v1/auth/sign-out` | Ends this session. |
| `GET /v1/me` | Profile, linked identities, balances. |
| `GET /v1/ledger?before=&limit=` | Balances and ledger entries, newest first. |

Sessions are opaque bearer tokens (`np_…`, 30 days, sliding); only their SHA-256 is stored. Sending a guest's token
to a wallet / Google / email sign-in links that identity to the guest and keeps its balance; if the identity already
belongs to someone, you are signed in to that player instead.

The ledger (`migrations/0001_init.sql`) is append-only. A trigger applies each entry to `balances` in the same
statement, and `balances.amount >= 0` is a CHECK, so an overdraft aborts the entry: the two tables cannot disagree.
Every entry has an idempotency key per player, so retries never double-pay.

## Commands (in this folder)

```bash
npm test                    # vitest against real SQLite (node:sqlite stand-in for D1), no Cloudflare needed
npm run dev                 # local Worker on http://localhost:8788 with local D1/R2 (run db:migrate:local first)
npm run db:migrate:staging  # apply migrations/ to the staging D1
npm run deploy:staging      # build + deploy nomad-poker-api-staging
node scripts/smoke.mjs https://nomad-poker-api-staging.kshitijiitgn.workers.dev https://nomad-poker-web.vercel.app
```

Deploys use `cf-vite build` then `cf deploy --prebuilt`, because `cf build` in cf 0.15 cannot start the Vite helper on
Windows (spawn ENOENT on the extensionless `cf-vite` shim). Newer `cf` releases need Node 22.23+.

The web app talks to this API through `apps/web/src/account` (`?api=staging`, or `VITE_API_URL` at build time).
