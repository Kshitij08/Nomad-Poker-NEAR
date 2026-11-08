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
| `GET /v1/progress` | Everything the retention screens paint: balances, items, level, spin, login track, missions. |
| `POST /v1/rewards/spin` | The daily spin: the server rolls (HMAC of a secret, the player and the UTC day, so a retry gets the same prize) and pays a catalogue prize once a day. |
| `POST /v1/rewards/login` | The 7-day login track: the server reads the streak, spends a shield on a one-day gap, pays the catalogue day. |
| `GET /v1/social` | Friends (relation, presence: online in the last two minutes, the table a friend sits at), the live table invites, server time. Counts as activity. |
| `POST /v1/friends/request` `{ idOrName }`, `/accept` `{ friendId }`, `/remove` `{ friendId }` | friends.js's rules on D1: Friend IDs (16 hex) or a unique name; asking back accepts; removing clears both sides. |
| `POST /v1/invites/send` `{ friendId, session }`, `/v1/invites/dismiss` `{ fromId }` | Friends-only table invites, 10 minutes, newest 10 kept. |
| `POST /v1/me/profile` `{ displayName?, avatar? }` | Rename (2–24 characters) and avatar. |
| `GET /v1/leaderboards/:kind?page=` | Weekly / season earnings, weekly / all-time hands won, friends weekly — from the hands the game server recorded. |
| `POST /v1/missions/claim` `{ id }` | Pays a mission only when the progress the game server counted reaches its target, once per day / week. |

Sessions are opaque bearer tokens (`np_…`, 30 days, sliding); only their SHA-256 is stored. Sending a guest's token
to a wallet / Google / email sign-in links that identity to the guest and keeps its balance; if the identity already
belongs to someone, you are signed in to that player instead.

Rewards are the server's decisions (Phase 3): the rules are the engine's catalogues, run in `packages/db/src/progress.ts`. XP, gems and streak shields are ledger currencies; level-ups are paid as XP crosses them; every grant has an idempotency key (per day, mission period, level or hand). There is no route that takes an amount from a client. `scripts/rewards-check.ts` checks this against a deployed API.

The ledger (`packages/db/migrations/0001_init.sql`) is append-only. A trigger applies each entry to `balances` in the same
statement, and `balances.amount >= 0` is a CHECK, so an overdraft aborts the entry: the two tables cannot disagree.
Every entry has an idempotency key per player, so retries never double-pay.

## Commands (in this folder)

```bash
npm test                    # vitest against real SQLite (node:sqlite stand-in for D1), no Cloudflare needed
npm run dev                 # local Worker on http://localhost:8788 with local D1/R2 (run db:migrate:local first)
npm run db:migrate:staging  # apply migrations/ to the staging D1
npm run deploy:staging      # build + deploy nomad-poker-api-staging (needs .secrets.staging.json with SPIN_SECRET)
npx tsx scripts/rewards-check.ts   # Phase 3 exit gate: no self-granted coins, XP or items; catalogue prizes only
node scripts/smoke.mjs https://nomad-poker-api-staging.kshitijiitgn.workers.dev https://nomad-poker-web.vercel.app
```

Deploys use `cf-vite build` then `cf deploy --prebuilt`, because `cf build` in cf 0.15 cannot start the Vite helper on
Windows (spawn ENOENT on the extensionless `cf-vite` shim). Newer `cf` releases need Node 22.23+.

The web app talks to this API through `apps/web/src/account` (`?api=staging`, or `VITE_API_URL` at build time).
