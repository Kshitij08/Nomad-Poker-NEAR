# Poker escrow backend

Hosted API + indexer for the Solana poker escrow program. Uses **Railway Postgres** for persistence.

**Integrating Unity / game server?** See [`docs/INTEGRATION_HANDOVER.md`](../docs/INTEGRATION_HANDOVER.md) for C# API reference, hand lifecycle, and security notes.

## Architecture

| Component | Where it runs |
|-----------|----------------|
| **Postgres** | Railway (always on) |
| **API + indexer** | Railway (recommended) or locally for debugging |

Your `backend/.env` already points at Railway Postgres. The API has been running locally (`npm run backend:dev` → `http://localhost:8787`). Deploy the API to Railway so teammates and Unity always hit a live server without starting Node on their machine.

---

## 1. Railway Postgres (one-time)

If you do not have a database yet:

1. [railway.app](https://railway.app) → **New project** → **PostgreSQL**
2. Open Postgres → **Connect** → copy the **Public Network** URL for local migrations
3. Paste into `backend/.env` as `DATABASE_URL` (keep `DATABASE_SSL=true`)

Run migrations once from your machine:

```bash
npm run backend:migrate
```

---

## 2. Deploy the backend to Railway (recommended)

### A. Create the service

1. In the **same Railway project** as Postgres, click **+ New** → **GitHub Repo** (or **Empty Service** and connect later)
2. Select this repository
3. Open the new service → **Settings** → **Root Directory** → set to `backend`
4. **Settings** → **Networking** → **Generate Domain** (e.g. `https://poker-escrow-production.up.railway.app`)

### B. Environment variables

In the backend service → **Variables**, add:

| Variable | Value |
|----------|--------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference your Postgres service) |
| `DATABASE_SSL` | `true` |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` |
| `POKER_PROGRAM_ID` | `GdduGzsoiEamv285Z4DnBapmkMScnHLDdUAdWPywHozo` |
| `SETTLEMENT_AUTHORITY_SECRET` | Same base58 secret as in local `backend/.env` |
| `INTERNAL_API_KEY` | Random secret; clients send `X-API-Key: <value>` on `/internal/*` |
| `PORT` | Railway sets this automatically; optional |

Railway runs `npm start`, which applies migrations then starts the server (`backend/railway.toml`).

**Build note:** Railway’s root directory is `backend`, so `shared/idl/` is not available at build time. The IDL is vendored at `backend/idl/poker_escrow.json`. After changing the on-chain program, refresh it:

```bash
npm run copy-idl --prefix backend
git add backend/idl/poker_escrow.json
```

### C. Verify

```bash
curl https://YOUR-SERVICE.up.railway.app/api/health
curl https://YOUR-SERVICE.up.railway.app/api/config
```

### D. Point clients at Railway

- **Unity** (`PokerChainTestUI` or game scene): set **Backend Url** to `https://YOUR-SERVICE.up.railway.app`
- **Settle script**:
  ```bash
  BACKEND_PUBLIC_URL=https://YOUR-SERVICE.up.railway.app npm run devnet:settle -- dev-table-1 HOST PLAYER2 50
  ```

You can stop running `npm run backend:dev` locally unless you are debugging the server.

---

## Local development (optional)

Use this only when changing backend code. Still uses Railway Postgres via `DATABASE_URL`.

```bash
cp backend/.env.example backend/.env
# fill DATABASE_URL (Railway public URL) + SETTLEMENT_AUTHORITY_SECRET
npm run backend:migrate
npm run backend:dev
```

API: `http://localhost:8787`

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string |
| `DATABASE_SSL` | `true` for Railway; auto-enabled for non-local hosts |
| `SOLANA_RPC_URL` | Devnet RPC (default: public devnet) |
| `POKER_PROGRAM_ID` | Deployed escrow program id |
| `SETTLEMENT_AUTHORITY_SECRET` | Base58 secret key for `begin_round` / `settle_round` (devnet only) |
| `INTERNAL_API_KEY` | **Required before public deploy** — protects `/internal/*` (CLI uses same value) |
| `JWT_SECRET` | **Required for wallet login** — HS256 secret for player JWTs (min 16 chars) |
| `JWT_TTL` | Optional JWT lifetime (default `7d`) |
| `AUTH_DOMAIN` | Domain shown in the SIWS sign-in message (default `nomadpoker.fun`) |
| `AUTH_URI` | URI line of that message (default `https://<AUTH_DOMAIN>/`) |
| `PORT` | HTTP port (default `8787`; Railway injects its own) |
| `BACKEND_PUBLIC_URL` | Optional; public Railway URL for CLI scripts |
| `PLAYFAB_TITLE_ID` | **Required for tournaments** — the PlayFab title (`6A5AE`) |
| `PLAYFAB_SECRET_KEY` | **Required for tournaments** — title secret key; the backend moves all tournament chips with it. Never log it |
| `PLAYFAB_FAKE` | `1` = in-memory PlayFab for local runs (tickets look like `fake:<playFabId>:<name>`) |
| `TOURNAMENT_MIN_LEAD_SECS` | Earliest a new tournament may start, in seconds from now (default `600`) |
| `TOURNAMENTS_SCHEDULER` | `0` turns the tournament scheduler off (run it in exactly one replica) |

### Chain config for clients

`GET /api/config` returns program id and settlement authority pubkey:

```json
{
  "programId": "GdduGzsoiEamv285Z4DnBapmkMScnHLDdUAdWPywHozo",
  "settlementAuthority": "FcjrYf725azTnMao6xEzKPSrT4hD5YKYhKUHnVbWCUMH",
  "rpcUrl": "https://api.devnet.solana.com"
}
```

Unity calls this when creating tables so the on-chain settlement authority matches the backend signer.

### Settlement authority & fees

`begin_round` and `settle_round` are signed by the **settlement authority** keypair (`SETTLEMENT_AUTHORITY_SECRET`), not player wallets. Players only sign `buy_in`, `rebuy`, `cash_out`, etc.

The settlement wallet pays Solana **transaction fees** (not Ethereum-style gas). On devnet each tx is typically ~0.000005 SOL. Fund the settlement pubkey with 1–2 devnet SOL for thousands of hand settlements.

---

## Game server integration

Poker betting is off-chain. Your authoritative game server should:

1. **`POST /internal/table/create`** when the host opens a lobby — server creates the on-chain table (empty).
2. Players sign **`buy_in`** from the Unity client (host and joiners use the same flow).
3. **`POST /internal/hand/start`** before dealing — locks the table (`round_active = true`).
4. Run the hand in your poker engine.
5. **`POST /internal/hand/end`** with zero-sum chip deltas from the engine.
6. On leave: player signs **`request_leave`**, then after the hand **`POST /internal/cash-out`** for that player.
7. When the table is empty: **`POST /internal/table/close`** to recover PDA rent.

Example settle body:

```json
{
  "tableId": [100, 101, 118, ...],
  "tablePda": "...",
  "vaultPda": "...",
  "nonce": 0,
  "chipsInPlay": 2000,
  "deltas": [
    { "player": "HOST...", "chipDelta": 50, "seatPda": "..." },
    { "player": "P2...", "chipDelta": -50, "seatPda": "..." }
  ]
}
```

Unity (authoritative server in-process): use `Poker.Chain.PokerChainBackend.CreateTableAsync`, `BeginHandAsync`, `SettleHandAsync`, `CashOutPlayerAsync`, and `CloseTableAsync`.

All `/internal/*` routes require `INTERNAL_API_KEY` when that env var is set (`X-API-Key` or `Authorization: Bearer`).

---

## Indexer

The backend subscribes to program logs and:

- Classifies transactions (`BuyIn`, `SettleRound`, …) from Anchor log lines
- Upserts `tables`, `seats`, and `player_ledger` from on-chain account data
- `rounds` are written at settle time by the settlement service

Public history/UI: `GET /api/tables`, `/api/tables/:id/seats`, `/api/tables/:id/ledger`.

---

## WebGL wallet (Phantom)

Browser builds use Phantom via the Solana Unity SDK wallet adapter (`LoginWalletAdapter`). The Editor uses an in-game dev wallet instead.

Build: **SolanaTest → Create Solana Test Scene**, then build WebGL (`Assets/SolanaTest/build-webgl.bat`). At runtime, **Connect Wallet** opens the Phantom picker (Resources prefabs loaded automatically by `Web3.cs`).

### Player login (SIWS)

1. Set `JWT_SECRET` (min 16 chars) in `backend/.env` and Railway.
2. Unity: open [`Assets/SolanaTest/Scenes/SolanaAuth.unity`](../Assets/SolanaTest/Scenes/SolanaAuth.unity) (or **SolanaTest → Create Solana Auth Scene** to regenerate it). Auth UI is only in this scene.
3. Flow: connect wallet → sign message → backend upserts `players` by pubkey → JWT stored in `PokerClientIdentity`.
4. Optional soft email prompt saves to `players.email` + `marketing_opt_in` (no verification).

---

## API routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness check |
| GET | `/api/config` | Program id + settlement pubkey |
| POST | `/api/auth/nonce` | Start wallet login — returns SIWS message to sign |
| POST | `/api/auth/verify` | Verify signature, upsert player, return JWT |
| GET | `/api/me` | Player profile + ledger summary (Bearer JWT) |
| PUT | `/api/me/email` | Save voluntary email + marketing opt-in (Bearer JWT) |
| GET | `/api/tables` | Indexed tables |
| GET | `/api/tables/:id/seats` | Seats for a table |
| GET | `/api/tables/:id/ledger` | Player ledger |
| POST | `/internal/table/create` | Create empty table (settlement authority) |
| POST | `/internal/table/close` | Close empty table (settlement authority) |
| POST | `/internal/begin-round` | Lock table for a hand (`begin_round`) |
| POST | `/internal/settle` | Settle a hand (game server) |
| POST | `/internal/hand/start` | Alias for begin-round (game server) |
| POST | `/internal/hand/end` | Alias for settle (game server) |
| POST | `/internal/cash-out` | Server-signed cash-out (default leave path) |

All `/internal/*` routes require `X-API-Key` when `INTERNAL_API_KEY` is set.

---

## Tournaments

Hosted round-format tournaments (design and architecture docs in the team's claude.ai artifacts). The
backend owns the records and **all tournament money**: the host's prize, entry fees, refunds and prizes.
Game servers only report results.

- **Sign-in:** the client sends its PlayFab session ticket to `POST /api/auth/playfab`. The backend checks
  it with PlayFab and returns a 1-hour Bearer token for the routes below.
- **Money:** every chip move is a `money_moves` row with a fixed idempotency key, written in the same
  transaction as the change it pays for, then sent to PlayFab Economy v2. A retry never moves chips twice,
  and a refund's key is its debit's key plus `:refund`. A worker retries pending moves every 5 s.
  Refunds and prizes never give up.
- **Clock:** a 5-second scheduler does four things:
  - asks for a server 3 minutes before the start, once 2 or more players are in
  - at the start time, locks the roster, or cancels and refunds if fewer than 2 players
  - aborts and refunds if the server never starts, or stops sending heartbeats for 3 minutes
  - retries pending money

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/playfab` | `{sessionTicket}` → `{token, playFabId, displayName, expiresIn}` |
| GET | `/api/tournaments?filter=upcoming\|running\|finished` | Public list |
| GET | `/api/tournaments/code/:code` | Look up by the 6-letter code |
| GET | `/api/tournaments/:id` | One tournament (more detail for its host and players) |
| GET | `/api/me/tournaments` | My entries and hosted ones; `sessionName` once the server is ready |
| POST | `/api/tournaments` | Create (takes the host prize) |
| POST | `/api/tournaments/:id/edit` · `raise-prize` · `cancel` · `remove` | Host actions, before the start |
| POST | `/api/tournaments/:id/register` · `unregister` | Player actions, before the start |
| POST | `/internal/tournaments/claim-spawn` | Spawner: take one tournament that needs a server |
| POST | `/internal/tournaments/:id/ready` | Server: `{ok, error}` — the Fusion session is up |
| GET | `/internal/tournaments/:id` | Server: settings and roster (frozen once locked) |
| POST | `/internal/tournaments/:id/verify` | Server: `{sessionTicket}` → `{playFabId, displayName, entrant}` — game servers never hold the PlayFab key |
| POST | `/internal/tournaments/:id/started` · `progress` · `result` | Server: started, heartbeat `{seq, snapshot}`, final `{championId, standings}` |

### Tests

```bash
# a throwaway local database — never point this at Railway, the tests truncate tables
initdb -D /tmp/trn-pg && pg_ctl -D /tmp/trn-pg -o "-p 55432" start && createdb -h 127.0.0.1 -p 55432 trn_test
TEST_DATABASE_URL=postgres://$(whoami)@127.0.0.1:55432/trn_test npm test
```

Without `TEST_DATABASE_URL`, only the database-free tests run.

---

## Docker (local Postgres alternative)

```bash
cd backend
docker compose up -d
```

Set `DATABASE_URL=postgres://postgres:postgres@localhost:5432/poker_escrow` and `DATABASE_SSL=false`.
