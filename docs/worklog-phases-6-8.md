# Phases 6–8: decisions and open questions (worked on while Kshitij was away, from 9 Nov 2026)

A running log. Decisions are what I chose and why (each can be reversed); questions are what I need from you.
Phase 5 (Agents, tournaments, market) finished first: both exit gates passed on staging (see the plan doc).

## Ground rules I kept

- Devnet only. No transaction signed or sent with your wallet; no new keys put in the repo; no change to the live
  Unity stack (old repo, Railway, Photon, PlayFab, its devnet programs and services).
- Staging only: nothing deployed to production Workers.

## Decisions

(newest last)

1. **Order of work: Phase 7 hardening before most of Phase 6.** Phase 6's exit gate (a devnet SOL table and a PER
   table play, settle and cash out) needs transactions signed by a server key, and you asked that nothing be signed
   or sent without you. So tonight I build the Phase 6 pieces that can be tested offline (behind a switch that stays
   off) and spend most of the time on Phase 7, which can be finished and verified on staging.
2. **Security headers on the web app** (CSP, nosniff, referrer, permissions, HSTS, no framing). The CSP allows only
   this origin, the stage's API and game server, Solana devnet RPC and MagicBlock's devnet TEE. It also blocks the
   old stack's Railway backends outright (belt and braces: the client already refuses them without
   `?web3deployed=1`). Checked against a staging build served locally with the same headers: sign-in, API calls, the
   game-server socket, a table with all its assets, blob workers and devnet RPC work; `eval` and Railway are refused.
3. **Escrow money tables get a new settlement key of their own (design only tonight).** `create_table` makes its
   signer the table's settlement authority, so the game server can run escrow tables with a fresh devnet key stored as
   a Worker secret. No need to move the old key (`FcjrYf…`) out of Railway, and the live stack's tables are untouched.
4. **Rate limits.** API: every write outside sign-in is limited to 60 a minute per session (sign-in keeps its 30 a
   minute per address). Game server: room spawns, overflow scans and Agent starts are 30 a minute per address, and a
   socket sending more than 40 frames a second (or a frame over 64 KB) is closed. Deployed to staging, along with the
   web headers (live on nomad-poker-web.vercel.app).

## Questions for you

(newest last)

1. **Phase 6 keys.** To finish Phase 6 I need you to (a) let me generate a fresh devnet settlement keypair for the game
   server (stored only as a Worker secret) and airdrop it devnet SOL, and (b) OK the game server sending devnet
   transactions with it. Pros: no old secret leaves Railway; the live stack is untouched. Cons: tables created by the
   new key are separate from any the old backend created (fine on devnet).
2. **Where the PER service runs.** It is an Express + Postgres service with a forever keeper loop, Postgres advisory
   locks and Anchor (needs Node's Buffer). Options:
   - *A. Keep it a separate Node service* (a container: Cloudflare Containers, Fly or Railway under a new project).
     Pros: little porting, keeps the MagicBlock SDK as is. Cons: a third service and a second database.
   - *B. Port it into Workers* (keeper loop → a Durable Object alarm, Postgres → D1, `nodejs_compat` for Anchor).
     Pros: one platform, one database. Cons: the largest port in the plan; the TEE session and keeper timing need care.
   - *C. Hybrid*: routes and data (tables list, SOL strategies, payouts records) in the API on D1; the keeper alone as a
     small container. Pros: most traffic on Workers. Cons: two places for PER logic.
   I lean to C, but it needs PER secrets (`KEEPER_SECRET_KEY`, `AUDITOR_SECRET_KEY`, `ARCHIVE_KEY_HEX`). Which do you want?
