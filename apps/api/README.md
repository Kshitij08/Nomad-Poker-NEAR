# @nomad/api

The Nomad Poker API: one Cloudflare Worker (Hono) on D1 and R2. Phase 1 covers sign-in, sessions and the play-money
ledger; the contract (routes, types, error codes) is `packages/contract` (`@nomad/contract`).

| Route | What it does |
|---|---|
| `POST /v1/auth/guest` | New guest player with the starter grant (10,000 coins). |
| `POST /v1/auth/wallet/challenge` → `/verify` | Sign In With Solana: the server builds the message, the wallet signs it, the server checks the ed25519 signature. Nonces are single-use and last 5 minutes. |
| `POST /v1/auth/near/challenge` → `/verify` | NEAR sign-in: the wallet (or the key an app-made account keeps in the browser) signs a NEP-413 message; the key must be a full-access key of the account. |
| `POST /v1/near/account` `{ publicKey }` | Create my NEAR account (see below): `<id>.<sponsor>` with the browser's key, funded by the sponsor. |
| `POST /v1/near/relay` `{ signedDelegate }` | Gasless moves for app-made accounts: a NEP-366 SignedDelegateAction (borsh, base64), checked and sent as a meta-transaction the sponsor pays for. |
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
| `GET /v1/tournaments?filter=upcoming\|running\|finished` · `POST /v1/tournaments` | Public tournaments; host one (the host prize leaves the balance with the record). |
| `GET /v1/tournaments/code/:code` · `GET /v1/tournaments/:id` · `GET /v1/me/tournaments` | One tournament by join code or id (`{ serverNowUnix, tournament }`); my entries and hosted ones. |
| `POST /v1/tournaments/:id/register` · `unregister` · `edit` · `raise-prize` · `cancel` · `remove` | Entry fees and refunds move through the ledger in the same batch as the entry. The game server runs the tournament and pays the prizes. |
| `GET /v1/strategies?sort=` · `POST /v1/strategies` · `GET /v1/strategies/:id` · `GET /v1/strategies/mine` · `POST /v1/strategies/:id/unlist` | The Coins copy-strategy marketplace: publish (custom numbers or My Twin), track records from every hand copied Agents played, qualification against Autopilot, the creator's dashboard. |
| `GET /v1/style/twin` · `GET /v1/style/coach` | My Twin (a profile fitted to the player's recorded decisions) and the coach report. |
| `GET /v1/shop` · `POST /v1/shop/buy` `{ itemId, requestId }` | The shop (Phase 3, `packages/db/src/shop.ts`, catalogue `SHOP_ITEMS` in the contract): XP pack, Level up, 2× XP boosts (hands recorded while one runs earn double XP), and card backs from the five room themes. Coins purchases are one batch (purchase row, ledger debit, effect); a retried requestId changes nothing. Real-money Coin packs are not sold. |
| `POST /v1/shop/sol/intent` `{ itemId }` → `/v1/shop/sol/confirm` `{ intentId, signature }` | SOL purchases on devnet: the server quotes an amount, treasury and memo (the intent id); the player's transfer must pay at least that with the memo; the server reads the transaction from `SOLANA_RPC_URL` (staging secret) before applying the item, once per signature. Closed (501) without `SOLANA_RPC_URL` and `SHOP_TREASURY`. |
| `GET /v1/admin/me` · `GET /v1/admin/players?q=` · `GET /v1/admin/players/:id` · `POST …/:id/adjust` · `…/ban` · `…/unban` · `GET /v1/admin/audit` · `GET /v1/admin/reconcile` | Support tools, for accounts listed in `admin_users` (others get 404): look-ups, balance adjustments (admins only, ledger entries), bans, the audit log of every admin action, and the ledger reconciliation. The web app's support page (`/admin.html`, `apps/web/src/admin/`) and `scripts/admin.mjs` (a terminal) drive them; `infra/add-admin.mjs` adds an admin. |

Writes outside sign-in are limited to 60 a minute per session (`WRITE_LIMITER`); sign-in to 30 a minute per address.

Sessions are opaque bearer tokens (`np_…`, 30 days, sliding); only their SHA-256 is stored. Sending a guest's token
to a wallet / Google / email sign-in links that identity to the guest and keeps its balance; if the identity already
belongs to someone, you are signed in to that player instead.

Rewards are the server's decisions (Phase 3): the rules are the engine's catalogues, run in `packages/db/src/progress.ts`. XP, gems and streak shields are ledger currencies; level-ups are paid as XP crosses them; every grant has an idempotency key (per day, mission period, level or hand). There is no route that takes an amount from a client. `scripts/rewards-check.ts` checks this against a deployed API.

Phase 5 moved the backend's tournament, strategies, twin and coach services here (`packages/db/src/tournaments.ts`,
`strategies.ts`, `style/`). Staging lets tournaments start a minute out (`TOURNAMENT_MIN_LEAD_SECONDS`) and qualifies
market strategies after 100 hands (`LISTING_MIN_HANDS`, `LISTING_MIN_DAYS`); production keeps 10 minutes, 2,000 hands
and 7 days. The coach's written note needs `ANTHROPIC_API_KEY`, which is not configured; the computed report works
without it. Agent sessions are on the game server (`/v1/agents/*`).

The ledger (`packages/db/migrations/0001_init.sql`) is append-only. A trigger applies each entry to `balances` in the same
statement, and `balances.amount >= 0` is a CHECK, so an overdraft aborts the entry: the two tables cannot disagree.
Every entry has an idempotency key per player, so retries never double-pay.

## NEAR without a wallet (`src/nearAccounts.ts`)

On-chain mode needs a NEAR account. Players with a wallet connect it (NEAR Connect). Everyone else taps **Create my
NEAR account**:

1. The browser makes an ed25519 key pair and keeps it in localStorage for this origin (`apps/web/src/near/localKey.ts`;
   the player can back it up as a near-cli JSON file, restore it on another device, or import it into a wallet).
2. `POST /v1/near/account` with the public key. The sponsor account creates `<10 of a-z0-9>.<sponsor>` (a sub-account,
   so no faucet call per player) with that key as its only full-access key and sends it `NEAR_NEW_ACCOUNT_YOCTO`
   (default **0.1 NEAR**, capped at 0.5): storage (~0.002 NEAR) plus a starting amount for deposits and buy-ins.
   One account per player; at most `NEAR_NEW_ACCOUNTS_PER_DAY` (default 50) a day across everyone. Asking again with
   the same key returns the same account.
3. The browser signs in with that key through the ordinary NEP-413 challenge / verify, which links the account to the
   player (guest, Google or email) like a wallet's. The player keeps their display name.
4. Contract calls that attach no NEAR are NEP-366 delegate actions signed in the browser and sent to
   `POST /v1/near/relay`. Calls that attach NEAR (deposit, a buy-in topped up from the account, tournament entry,
   join_pool, back) go as ordinary transactions signed in the browser and paid from the account (gas is a fraction of
   a millinear): in a meta-transaction **the relayer pays the delegate's deposit**, so relaying those would spend the
   sponsor's NEAR (seen in the first live run). The relayer
   refuses anything that isn't the caller's own app-made account and its registered key, a call to `NEAR_ESCROW`
   (`deposit`, `withdraw`, `buy_in`, `create_hosted_table`, `close_table`, `reclaim`, `register`, `leave`,
   `create_tournament`, `cancel_tournament`) or `NEAR_TABLE_CONTRACT` (`join_pool`, `leave_pool`, `claim_earnings`,
   `register_agent`, `back`, `withdraw`, `set_loss_limit`), any attached NEAR, more than 100 Tgas a call or 250 Tgas in all, a move that expired or is valid for more than 600 blocks, a
   bad signature, or a move it already relayed (by its NEP-366 hash, before paying anything). 30 moves per player in
   10 minutes, 300 a day. It wraps the move in a transaction the sponsor signs (`send_tx`, waiting for execution) and
   returns a contract panic in the contract's own words. The sponsor pays gas only (unused gas is refunded to it). Wallet players are not relayed: their wallet pays, as before. `near_accounts` and `near_relays`
   (migration 0017) record both.

Setup (testnet): the sponsor is `players.nomad-poker.testnet` (a sub-account of `nomad-poker.testnet`, funded from it) (`NEAR_SPONSOR_ID` in `cloudflare.config.ts`). Its key is
the Worker secret `NEAR_SPONSOR_KEY`, never in the repo: the `private_key` from
`~/.near-credentials/testnet/players.nomad-poker.testnet.json` (WSL), `ed25519:<base58>`. Put it in the git-ignored
`.secrets.staging.json` next to `SPIN_SECRET` (`npm run deploy:staging` uploads it) or set it with
`npx cf secret put NEAR_SPONSOR_KEY --mode staging`. For `npm run dev`, put it in `.dev.vars` (git-ignored). Without
it the two routes answer 501 and the app offers wallets only. Keep the sponsor topped up: live on testnet, an account
cost 0.1 NEAR plus ~0.003 NEAR gas and a relayed move ~0.002 NEAR after refunds.

## Commands (in this folder)

```bash
npm test                    # vitest against real SQLite (node:sqlite stand-in for D1), no Cloudflare needed
npm run dev                 # local Worker on http://localhost:8788 with local D1/R2 (run db:migrate:local first)
npm run db:migrate:staging  # apply migrations/ to the staging D1
npm run deploy:staging      # build + deploy nomad-poker-near-api-staging (needs .secrets.staging.json with SPIN_SECRET)
npx tsx scripts/rewards-check.ts   # Phase 3 exit gate: no self-granted coins, XP or items; catalogue prizes only
node scripts/smoke.mjs https://nomad-poker-near-api-staging.kshitijiitgn.workers.dev https://nomad-poker-near.vercel.app
```

Deploys use `cf-vite build` then `cf deploy --prebuilt`, because `cf build` in cf 0.15 cannot start the Vite helper on
Windows (spawn ENOENT on the extensionless `cf-vite` shim). Newer `cf` releases need Node 22.23+.

The web app talks to this API through `apps/web/src/account` (`?api=staging`, or `VITE_API_URL` at build time).
