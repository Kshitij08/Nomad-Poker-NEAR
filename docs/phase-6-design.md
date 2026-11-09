# Phase 6 design: on-chain tables on the new stack (devnet)

Status, 9 Nov 2026 (evening): the escrow tables' server side is built and passed its exit gate on deployed staging.
- The game server has its own key: `5mGzv7cs…zx5X1` on staging, in Worker secrets only.
- It reaches devnet through the Alchemy devnet URL the Unity client ships, held as a Worker secret. The public devnet
  RPC blocks Cloudflare, and Alchemy's free tier has no `getProgramAccounts`, so the code avoids it.
- Each `poker-money…` room creates its table on chain and runs a round per hand (`HandGate` in `PokerServerGame`).
  It seats players from their on-chain seats, pays leavers out, and closes the table when the room closes.
- A cron sweep pays out and closes any table a room left behind.
- Code: `apps/game-server/src/escrowTable.ts` and `packages/chain/src/escrowClient.ts`.
- Exit gate: `apps/game-server/scripts/escrow-check.ts`.
- Open: whether to build the player side, since Unity retired escrow money tables (question 12 in
  `worklog-phases-6-8.md`), and PER (question 2).

Programs stay as they are (`poker-escrow` `GdduGz…ozo`, `poker-per` test `4A3DZW…MZ` / live `7q2vxh…pv`).

## What exists

- **Client (web):** builds and wallet-signs the player's escrow instructions (`buy_in`, `rebuy`, `request_leave`) with a
  hand-rolled IDL coder (`apps/web/src/web3/chain/escrow.ts`, no Anchor). PER deposits, withdrawals and in-rollup play
  are client-signed too (`apps/web/src/web3/per/*`).
- **Old backend (Railway, untouched):** signs the escrow's authority steps with `SETTLEMENT_AUTHORITY_SECRET`
  (pubkey `FcjrYf…UMH`): `create_table`, `begin_round`, `settle_round`, `cash_out`, `close_table`, via
  `/host/*` routes the Unity host called with a player-host JWT.
- **PER service (Railway, untouched):** Express + Postgres; keeper loop (tick, start_hand, commit, close, reclaim,
  tournaments), SOL Agents, SOL strategies market, payouts, host fees, sealed audit logs. Secrets: keeper, auditor,
  archive key, admin token.
- **New stack:** no on-chain code. `poker-money*` rooms answer "not available yet".

## Escrow money tables on the game server

The game server becomes the escrow's host, with **a settlement key of its own**. `create_table` makes its signer
the table's `settlement_authority` (no config check), so a fresh devnet key can create and settle new tables. The old
key never leaves Railway and the live stack's tables are not touched.

| When (PokerServerGame) | Instruction | Signer | Notes |
|---|---|---|---|
| A `poker-money-st<lamports>` room opens | `create_table(table_id, host, buy_in, sb, bb, max_seats)` | game server key | `table_id` = room + table session (≤ 32 bytes); the key pays rent |
| A player sits | (client) `buy_in` / `rebuy` | player wallet | the server reads the seat PDA and seats the player with its chips (`seat.chips + pending_chips`) |
| Hand start | `begin_round` | game server key | "already active" counts as success (as `ChainTableSession` does) |
| Hand end | `settle_round(nonce, deltas)` | game server key | ≤ 9 deltas, zero sum, seat PDAs as remaining accounts; re-read the table on failure; halt the table after 3 failures |
| A player leaves (between hands) | `cash_out` | game server key (or the player) | pays the seat's lamports to the player's wallet |
| Room idles empty | `close_table` | game server key | returns rent |

- The **escrow is the ledger** for SOL tables: no D1 ledger entries. The reconciliation gets an extra check: the
  table's on-chain `chips_in_play` equals the seats the server holds.
- **Signing on Workers:** build transactions with the existing IDL coder (moved to a shared package), sign with
  WebCrypto Ed25519 (supported by Workers), send by JSON-RPC over `fetch`. No Anchor and no `Buffer`. One small RPC
  client with retries and `confirmTransaction` polling.
- **The key:** a devnet keypair generated for this, stored only as a Worker secret (`ESCROW_AUTHORITY_SECRET`), funded
  by devnet airdrop. Refused on any mainnet RPC (as the old backend does).
- **Client:** the web3 module's `/api/config` and wallet auth move to the new servers: the game server serves
  `{ programId, settlementAuthority, rpcUrl }` at `/v1/chain/config` (the new key replaces the hard-coded `FcjrYf…`),
  and wallet sign-in already exists on the API (`/v1/auth/wallet/*`); `WalletAuthService` switches to it.
- `ChainTableSession` (web, unused today) is the logic to port into the game server's money-table host.

## PER private tables

Three ways (question 2 in `worklog-phases-6-8.md`); my recommendation is **C, a hybrid**:
- **API on D1:** the read routes and records (tables list, hand archive index, SOL strategies, payout records, host
  credits), signed-request auth as today (`nomad-agent|path|ts|body`).
- **A small keeper service:** the loop that signs `tick` / `start_hand` / commits / closes and runs SOL Agents, as a
  container (it needs the MagicBlock SDK, Anchor and a steady loop). It writes to D1 through the API.
- **Keys:** a fresh devnet keeper and auditor for the new deployment. The PER program config names one auditor and a
  hosting wallet, so moving them takes the PER config admin. Or keep the current keeper key, moved by you.

## Exit gate test plan

1. Escrow: two staging guests with devnet wallets (test keypairs in a harness, never yours) buy in, play 20 hands, one
   cashes out mid-way, the room closes; every lamport accounted for on chain.
2. PER: a private table plays, settles and cashes out through the new keeper.

## Needed from you

1. OK to generate a devnet settlement key for the game server, airdrop it, and let the game server send devnet
   transactions with it.
2. The PER choice (A, B or C) and its keys.
3. Test wallets for the harness: OK to generate throwaway devnet keypairs (never stored in the repo) and airdrop them.
