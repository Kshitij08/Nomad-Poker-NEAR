# Nomad Poker

The web-first Nomad Poker platform: the browser game (a faithful port of the Unity client), its game server, and
the on-chain programs. Carved out of `X2C-fun/Poker` (the live Unity stack, now maintenance-only) with the history of
the folders below kept.

| Path | What it is |
|---|---|
| `packages/engine` | `@nomad/engine`: the poker rules, bit-exact with the Unity C# core (golden tests). No DOM; shared by the web app, the table servers and the API. |
| `apps/web` | The web app: 3D table, Nomad menus, every feature module, and today's local table server (`apps/web/server`). See `apps/web/README.md`. |
| `onchain/programs`, `onchain/per`, `onchain/idl` | Solana programs (`poker-escrow`, `poker-per`), the PER keeper/payout services and IDLs. Devnet only for now. |
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
