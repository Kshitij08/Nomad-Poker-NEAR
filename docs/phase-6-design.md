# Phase 6: on-chain tables on the new stack (devnet)

Status, 9 Nov 2026: **SOL play is private tables (PER) only**, as in the Unity game. PER runs on the new stack's
staging and passed its exit gate.

## Private tables (PER)

- **Program:** a new devnet instance of `poker-per`, `7LcbAnHBFHkviM6AhGgmm871VYNkTU8HTt2bTWVWLKBn`. It was built
  from `Poker/per` and deployed by your deployer `4kiqWY…`, which stays admin and upgrade authority. It has its own
  keeper (`GV5LYv…`) and auditor (`5hEB5u…`). The Unity test (`4A3DZW…`) and live (`7q2vxh…`) programs are untouched.
- **Service (`apps/per`, the hybrid plan):**
  - A Worker answers the lobby reads (`/tables…`) from D1.
  - Everything else goes to one Cloudflare Container that runs the Railway service's code: verify, tournaments,
    SOL Agents and strategies, payouts, audit, and the keeper loop.
  - The container's data is in D1 (`nomad-poker-per-staging-us`, in ENAM next to the container), reached only
    through the Worker.
  - Details: `apps/per/README.md`.
- **Exit gate:** `Poker/per/tests/keeper.devnet.ts`, 27 checks covering the lobby, keeper-begun hands and
  timeouts, archived and audited logs, verify, commit, cash-out, close. It passed locally and on deployed staging.
- **Web client:** `?perprogram=nomad` (the default in the staging web build) uses this program and service.
- **Devnet RPC:** `api.devnet.solana.com` refuses Cloudflare, so the service uses a provider URL (a secret). For now
  that is the Alchemy devnet URL the Unity client ships.

## Escrow money tables: removed

The new stack had a working server side for `poker-escrow` tables: the game server signed every round with its own
key, and the gate passed on devnet with every lamport accounted for. It never had a player side. Since Unity had
already retired escrow money tables, the escrow code was removed on 9 Nov 2026:
- the game server's money rooms, its escrow host and its chain routes;
- the `@nomad/chain` package;
- the web client's escrow program client and cash-out screen;
- the escrow program's source and IDL.

The work is in git history (commits `5645313`, `92c490d`). Every escrow table had been paid out and closed on chain,
and migration 0010 drops their record. The game server's devnet key (`5mGzv7cs…zx5X1`, about 1.45 devnet SOL) is
kept, retired, in the git-ignored `apps/game-server/.secrets.retired-escrow.json`.
