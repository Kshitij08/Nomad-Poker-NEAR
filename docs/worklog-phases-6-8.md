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
5. **Support tools as admin accounts, not a shared admin password.** Admins are player accounts listed in a new
   `admin_users` table (role `support`: look up, read, ban; role `admin`: also adjust balances). They are added only
   by an operator with a D1 query, never through the API. Every action, including viewing a player, is written to
   `admin_audit` in the same batch as the change. Balance adjustments are ledger entries (`admin:adjust`, keyed by a
   request id so a retry adjusts once, refused below zero). A ban signs the player out everywhere and refuses sign-in;
   the game server uses the same session check, so a banned player can't sit, register or start an Agent. Non-admins
   get 404 from `/v1/admin/*`. Tool: `apps/api/scripts/admin.mjs`. Checked on staging with a QA admin account
   (`p_t8mFwj_vjVWtqnVR`, staging only).
6. **A ledger reconciliation report, and the bug it found.** `GET /v1/admin/reconcile` (and the game server's cron,
   hourly, logging `[reconcile] PROBLEMS` when anything is off) checks every money invariant: balances equal their
   ledger entries, every table has zero drift, no seat or Agent stuck on a dead table, Agents paid exactly, ended
   tournaments net to zero, nothing stuck. Its first run on staging flagged the two tables where Phase 5's Agents had
   played: the table books counted Agents with the humans, but Agents' chips move through their own ledger entries,
   so their losses showed as drift (462 and 200 coins). No coins were lost (the Agents' own entries balanced). Fixed:
   tables now record Agents' results separately (`agent_net`, migration 0007, with a backfill for older rows) and the
   drift formula includes it. Staging now reconciles clean over its whole history.
7. **Alerts stay a log search for now.** Turning Cloudflare notifications on (email/webhook alerts) changes account
   settings, which I left for you. The hourly reconcile warning and Worker errors are in Workers Logs today.
8. **Backups: D1 Time Travel plus dated SQL dumps in R2.** `infra/backup-d1.mjs` exports, gzips and stores the
   database in the stage's R2 bucket. Ran it on staging and restored the dump into an empty database: every balance
   matched its ledger entries. Restore steps are in `infra/cloudflare.md`.
9. **A load test found a real bug: bookkeeping dropped writes during a short D1 outage.** The first 40-player run
   showed drift on 6 of 8 tables (±20 to 145 coins). The game server's logs showed table bookkeeping writes failing
   with "D1_ERROR: Currently processing a long-running export": I had run the backup export during the test, which
   locks the database for a few seconds, and the table queue gave up after about 3 seconds of retries. The R2 hand
   records (written separately) proved it to the coin: each table's R2 house total minus its D1 total exactly equals its
   drift, and D1 was short by the 1–3 hands whose writes were dropped. Fix: bookkeeping now retries with backoff for up
   to 10 minutes of real time, and logs `GAVE UP` if it ever does stop. A test runs a table through an 8-second outage:
   it fails on the old retry window and passes on the new one. I repaired the six staging tables from their R2
   records (`infra/table-from-r2.mjs --fix`) and staging reconciles clean. Lessons kept: backups should run at a quiet
   hour; deploy scripts now refuse to deploy while a D1 migration is pending (`infra/check-migrations.mjs`); and
   `infra/logs.mjs` searches Worker logs from a terminal.
10. **Integrity leads, not automatic bans.** `GET /v1/admin/integrity` lists possible chip dumping (one-way chip flow
    between a pair over many hands), marathon accounts (18+ hours in a day), robotic timing (very fast or very even
    decisions; think time is now recorded per decision, migration 0008) and win-rate outliers. A person decides.
11. **Phase 6 is written down, not built.** `docs/phase-6-design.md` maps every escrow instruction to the moment the
    game server calls it, the signer (a new key of its own) and how to sign on Workers without Anchor (the existing
    IDL coder + WebCrypto Ed25519 + JSON-RPC). Building it blind, without being able to send a devnet transaction,
    would be guesswork; with your OK it is a few days of work.
12. **Store apps (Phase 8): Capacitor shell in `apps/web`.** Store builds set `VITE_STORE_BUILD=1`, which turns the SOL
    features off (store rules: virtual coins only). Deep links (`nomadpoker://join/CODE`, `https://…/?net=CODE`,
    `…/t/CODE`) join a party or open the tournament; a tournament link never registers by itself (that spends the
    entry fee). Android's back button closes the top screen. The status bar draws over the game (the layout already
    pads for notches). Capacitor packages pinned to releases at least two weeks old. The Android project is in the
    repo; CI builds a debug APK of the store build (staging servers) on every web change.
13. **Tables nobody watches play faster.** With no socket connected (not even a spectator), a table skips the
    animation pauses, plays bots' turns 3× faster and waits 1 s between hands. Agent sessions were paced for an
    audience they don't have: on staging 8 hands took 6½ minutes before and 53 seconds after (the Agent check still
    passes, paid back exactly). The first connection restores the normal pace from the next
    turn. Tables with people at them are unchanged.
14. **Switch-over rehearsed on staging; runbook drafted** (`docs/launch-runbook.md`). Rolled the staging API back one
    version and forward again (`infra/rollback.mjs`: 8 s and 5 s), and restored the staging database to a point in time
    (2 s; a marker row written after the bookmark was gone and the books reconciled clean). The runbook lists the
    production steps, the beta gate and how to back out of each kind of problem.
15. **iOS shell generated** (Swift Package Manager, `nomadpoker://` scheme). It needs a Mac to build; no microphone
    permission is declared, since table voice is off in the apps.
16. **A security review found two coin-minting races; both are fixed.** I had a second agent review the new server code.
    (1) Stopping a just-queued Agent at the moment a table seated it refunded the whole bankroll while the Agent kept
    playing with it. (2) Raising a tournament's entry fee while players registered let them pay the old fee but count
    at the new one in the prize pool (a host with alt accounts could mint millions). Both were reproduced in failing
    tests first (the second minted 1,999,998 coins in the replay). Fixes: an Agent completion applies only from the
    phase the caller saw, and every payment in it is conditional on the completion having happened; a fee change
    applies only while nobody is registered (checked in the same statement), a registration only at the fee it read,
    and prizes come from what was actually paid in. Smaller fixes from the same review: Agents only at real stake tiers
    (a fake stake inflated a strategy's record), the market shows creators' Friend IDs (not internal ids), the
    strategies list is cached for a minute, and support staff can't ban admins. Deployed; staging reconciles clean.
    Bans now also stop the player's Agent at the next minute sweep (checked on staging: stopped 40 s after the ban,
    its stack paid back). A player banned while seated is now removed at the next hand boundary and paid out (tested).
17. **Phase 6 signing groundwork built and verified offline.** `packages/chain`: the escrow's settlement-authority
    instructions from the IDL, PDAs, transactions compiled like web3.js and signed through WebCrypto Ed25519 (the key
    stays non-extractable; Workers support it), and a devnet-only JSON-RPC client. Tests compare PDAs, message bytes
    and signed wire bytes with `@solana/web3.js` (identical) and discriminators with the IDL. No transaction sent, no
    real key used. Wiring it into the tables is listed in `docs/phase-6-design.md`.
18. **Store rules check.** The client has no real-money purchase or external payment flow, so store builds only drop
    the SOL features.

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
3. **Admins for production.** Which accounts should be admins / support on production? (Staging has one QA admin.)
   And do you want a small web admin page later? The command-line tool covers it for now; a page is about a day.
4. **Alerts.** May I set up Cloudflare notifications (to your email) for Worker error spikes, and a Workers Logs alert
   on `[reconcile] PROBLEMS`? That changes account settings, so I didn't.
5. **Scheduled backups.** Running `infra/backup-d1.mjs` daily needs a Cloudflare API token somewhere that runs on a
   schedule. The workflow is ready (`.github/workflows/backup.yml`, daily 04:30 UTC) and does nothing until you add a
   `CLOUDFLARE_API_TOKEN` repository secret (D1 export + R2 write). Want me to walk you through making that token?
6. **Expected peak for the load test.** The plan's gate is "3× expected peak". What peak should I assume (players at
   once)? I ran 40 players over 8 tables at 20× speed (≈ 800 players' worth of hand traffic at normal speed); tell me
   the number and I'll size a run to 3× it.
7. **App identity for the stores.** The Unity project's app ids and icon are template placeholders
   (`com.moremountains.topdownengine`, TopDownEngine's icon). What bundle id do you want (I used `com.nomadpoker.app`
   provisionally; it can't change after the first store upload), and is there a real app icon / splash art?
8. **Android builds (mostly answered).** Capacitor 8 needs JDK 21 and this machine only has Unity's JDK 17, so the
   debug APK is built in CI instead (`.github/workflows/android.yml`, first run green, the APK is a workflow artifact).
   Still open: may I install JDK 21 locally for quicker device testing? Release builds and Play uploads need a signing
   key and Play credentials as repository secrets; iOS needs a Mac (or a macOS CI runner) and an Apple developer account.
9. **Native Google sign-in** needs OAuth client ids (Android SHA-1 + iOS) from your Google Cloud project.
10. **The production domain.** What domain will the web app and the APIs live on (e.g. `play.<domain>`)? It sets
    the production allowed origins, the CSP, the deep-link app verification files and the launch step.
11. **The coach's written note.** It uses Claude (default model `claude-haiku-5-5`) when the API has an
    `ANTHROPIC_API_KEY` secret; without it players get the computed report only. Do you want the note, and whose key?
