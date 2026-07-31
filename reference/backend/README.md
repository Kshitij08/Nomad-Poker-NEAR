# Poker escrow backend

Hosted API + indexer for the Solana poker escrow program. Uses **Railway Postgres** for persistence.

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
| `POKER_PROGRAM_ID` | `DBKWKynzCeAFBijg9AN2WcRz3X8H3tapxSD6VnTMkGM5` |
| `SETTLEMENT_AUTHORITY_SECRET` | Same base58 secret as in local `backend/.env` |
| `PORT` | Railway sets this automatically; optional |

Railway runs `npm start`, which applies migrations then starts the server (`backend/railway.toml`).

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
| `SETTLEMENT_AUTHORITY_SECRET` | Base58 secret key for `settle_round` (devnet only) |
| `PORT` | HTTP port (default `8787`; Railway injects its own) |
| `BACKEND_PUBLIC_URL` | Optional; public Railway URL for CLI scripts |

### Chain config for clients

`GET /api/config` returns program id and settlement authority pubkey:

```json
{
  "programId": "DBKWKynzCeAFBijg9AN2WcRz3X8H3tapxSD6VnTMkGM5",
  "settlementAuthority": "FcjrYf725azTnMao6xEzKPSrT4hD5YKYhKUHnVbWCUMH",
  "rpcUrl": "https://api.devnet.solana.com"
}
```

Unity calls this when creating tables so the on-chain settlement authority matches the backend signer.

---

## API routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness check |
| GET | `/api/config` | Program id + settlement pubkey |
| GET | `/api/tables` | Indexed tables |
| GET | `/api/tables/:id/seats` | Seats for a table |
| GET | `/api/tables/:id/ledger` | Player ledger |
| POST | `/internal/settle` | Settle a hand (game server) |
| POST | `/internal/cash-out` | Force cash-out (disconnected player) |

---

## Docker (local Postgres alternative)

```bash
cd backend
docker compose up -d
```

Set `DATABASE_URL=postgres://postgres:postgres@localhost:5432/poker_escrow` and `DATABASE_SSL=false`.
