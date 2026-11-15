# Nomad Poker

## NEAR HACKATHON submission

Nomad Poker on NEAR is copy trading for poker. Pros list an AI agent that plays their style; anyone backs its pool
with a NEAR wallet and keeps 90% of what it wins (8% to the pro, 2% to the platform, only on profit above the pool's
previous peak).

- **Why the results can be trusted:** hands are dealt inside sealed hardware (OutLayer, Intel TDX), and a NEAR
  contract verifies the dealer's randomness proof, re-deals every hand and replays every action before paying out.
- **Baseline:** Nomad Poker began as a poker game on Solana. The `pre-hackathon` tag is that game, and it is not part
  of the submission. During the hackathon the NEAR contracts, dealer and feeder were added under [`near/`](near/README.md),
  the game's on-chain mode was moved to NEAR, and the Solana code was removed from `main`.
- **What was built in the window:** [`pre-hackathon...main`](https://github.com/Kshitij08/Nomad-Poker-NEAR/compare/pre-hackathon...main)
  (additions are the NEAR work; most deletions are the removed Solana code).
- **Live on NEAR testnet:** table and backing vault `table.nomad-poker.testnet`, escrow for human tables and
  tournaments `nomad-escrow.testnet`, dealer `nomad-poker.testnet/nomad-dealer` on OutLayer.
- **Libraries and tools:** near-sdk, cargo-near, the OutLayer SDK and CLI, NEAR Connect, and the pre-hackathon
  Nomad Poker web client and engine (baseline). Parts of the code were written with AI coding assistants.
- **License:** All rights reserved. The code may be read, built and run to evaluate the project; see [LICENSE](LICENSE).

### Try it

In the browser, at https://nomad-poker-near.vercel.app (NEAR testnet; the app opens in Demo mode, which plays with
free Coins):

1. Open **Agents**, then **Back a pro**. You see the listed agents, each with its pro, playing style, NEAR in its
   pool and result since start.
2. Connect a NEAR testnet wallet and press **Back** on an agent. You see your stake on its card and under
   **My stakes**.
3. Open **Sessions**. You see the sessions the contract has settled.
4. Switch from Demo to **On-chain**. The rooms show NEAR tables with their blinds and buy-in, **Play with friends**
   hosts a table with an invite link, and **Tournaments** lists NEAR tournaments.

From a clone, with no accounts (the Rust crates build on Linux or WSL):

```bash
cd near/poker-core && cargo test --features seal,agent   # shuffle, deal, ranking, betting, sealing
cd near/table-spike && cargo test                        # session verification, vault and pools
cd near/escrow && cargo test                             # stakes for human tables and tournaments
cd near/feeder && npm install && npm run build:wasm && npm test
cd near/web && npm install && npm run dev                # http://localhost:5190: replays settled sessions and re-checks each hand in the browser
```

[`near/README.md`](near/README.md) has the contract methods, how to play and settle a session yourself, and the
known limits.

## Repository

The browser game (a port of the Unity client), its game server and API, and the NEAR contracts.

| Path | What it is |
|---|---|
| `near` | The NEAR build: contracts (`table-spike`, `escrow`), the OutLayer dealer, shared poker code, the feeder and the session viewer. See `near/README.md`. |
| `packages/engine` | `@nomad/engine`: the poker rules, bit-exact with the Unity C# core (golden tests). No DOM; shared by the web app, the table servers and the API. |
| `packages/contract` | `@nomad/contract`: the API's routes, request/response types and error codes, shared by the web app and the API. |
| `packages/db` | `@nomad/db`: the D1 schema (migrations), sessions, the ledger, seat locks and table audits, shared by the API and the game server. |
| `packages/table-server` | `@nomad/table-server`: the authoritative table (rooms, PokerServerGame, chip-ledger contract, wire protocol), hosted by the local Node server and the game server. |
| `apps/game-server` | One Durable Object per table, chips on the ledger, hands to R2; Agents play at its tables and tournaments run in its `TRN…` rooms — `apps/game-server/README.md`. Staging: https://nomad-poker-near-game-staging.kshitijiitgn.workers.dev |
| `apps/api` | The API Worker on Cloudflare (sign-in, ledger, rewards, social, tournaments, strategies market, twin, coach) — `apps/api/README.md`. Staging: https://nomad-poker-near-api-staging.kshitijiitgn.workers.dev |
| `apps/web` | The web app: 3D table, Nomad menus, every feature module, and today's local table server (`apps/web/server`). See `apps/web/README.md`. |

Plan: [Nomad Poker: web-first backend plan](https://claude.ai/artifact/5t13JEqcsG1vNEiuXAAHx4) — Cloudflare-native
(Workers API, one Durable Object per table, D1, R2), own sign-in, Capacitor store apps.

npm workspaces, Node 22.18+:

```bash
npm install
npm run dev        # http://localhost:5180
npm run server     # optional local multiplayer table server
npm test           # every workspace
npm run typecheck
```

Secrets and signing keys never go in this repository.
