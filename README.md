# Nomad Poker

The web-first Nomad Poker platform: the browser game (a faithful port of the Unity client), its game server, and
the on-chain programs. Carved out of `X2C-fun/Poker` (the live Unity stack, now maintenance-only) with the history of
the folders below kept.

| Path | What it is |
|---|---|
| `packages/engine` | `@nomad/engine`: the poker rules, bit-exact with the Unity C# core (golden tests). No DOM; shared by the web app, the table servers and the API. |
| `packages/contract` | `@nomad/contract`: the API's routes, request/response types and error codes, shared by the web app and the API. |
| `packages/db` | `@nomad/db`: the D1 schema (migrations), sessions, the ledger, seat locks and table audits, shared by the API and the game server. |
| `packages/table-server` | `@nomad/table-server`: the authoritative table (rooms, PokerServerGame, chip-ledger contract, wire protocol), hosted by the local Node server and the game server. |
| `apps/game-server` | One Durable Object per table, chips on the ledger, hands to R2; Agents play at its tables and tournaments run in its `TRN…` rooms — `apps/game-server/README.md`. Staging: https://nomad-poker-near-game-staging.kshitijiitgn.workers.dev |
| `apps/api` | The API Worker on Cloudflare (sign-in, ledger, rewards, social, tournaments, strategies market, twin, coach) — `apps/api/README.md`. Staging: https://nomad-poker-near-api-staging.kshitijiitgn.workers.dev |
| `apps/web` | The web app: 3D table, Nomad menus, every feature module, and today's local table server (`apps/web/server`). See `apps/web/README.md`. |
| `onchain/per`, `onchain/idl` | The private-table program (`poker-per`) and its IDL. Devnet only for now. SOL play is private tables only: escrow money tables were removed on 9 Nov 2026. |
| `apps/per` | The PER service on Cloudflare: lobby on D1, the keeper and SOL Agents in a Cloudflare Container — `apps/per/README.md`. |
| `reference/backend` | The old Node backend, kept only as a reference while its routes are ported; removed after Phase 6. |

Plan: [Nomad Poker: web-first backend plan](https://claude.ai/artifact/5t13JEqcsG1vNEiuXAAHx4) — Cloudflare-native
(Workers API, one Durable Object per table, D1, R2), own sign-in, devnet-only SOL tables, Capacitor store apps.

npm workspaces, Node 22.18+:

```bash
npm install
npm run dev        # http://localhost:5180
npm run server     # optional local multiplayer table server
npm test           # every workspace
npm run typecheck
```

Secrets, signing keys and program upgrade authorities never go in this repository.
