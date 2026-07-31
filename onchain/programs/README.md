# Solana Poker Escrow workspace

## Prerequisites

Install **Rust**, **Solana CLI**, and **Anchor 0.30.1** before `anchor build`.  
Windows step-by-step: **[programs/INSTALL.md](INSTALL.md)** (WSL2 recommended).

Quick verify:

```bash
rustc --version && solana --version && anchor --version
```

## Quick start

```bash
cp backend/.env.example backend/.env
# Set DATABASE_URL to your Railway Postgres public URL (see backend/README.md)
npm run backend:migrate
npm run backend:dev
```

Database setup (Railway, Docker, or local): see [backend/README.md](backend/README.md).

After `anchor build`, copy `target/idl/poker_escrow.json` to `shared/idl/` and update instruction discriminators in `Assets/Scripts/Chain/PokerEscrowProgram.cs`.

## Layout

| Path | Purpose |
|------|---------|
| `programs/poker-escrow/` | Anchor escrow program |
| `backend/` | Indexer, settlement service, ledger API |
| `shared/idl/` | Program IDL shared by TS and Unity |
| `tests/` | Anchor integration tests |
| `Assets/Scripts/Chain/` | Unity `PokerChain` wrapper |

## Unity integration

Your gameplay teammate calls `Poker.Chain.PokerChain` after wallet connect:

- `CreateTableAsync` — host creates table + buys in (one signature)
- `BuyInAsync` / `RebuyAsync` / `CashOutAsync`
- `QuoteBuyInAsync` — show buy-in + 5% fee before wallet popup

Settlement (`settle_round`) is server-signed via `POST /internal/settle`.
