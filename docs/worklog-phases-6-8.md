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

### After your go-ahead on Phase 6 (9 Nov, afternoon)

19. **The game server's devnet key exists and is funded.** `infra/escrow-key.mjs staging create` generated
    `5mGzv7csqZZ7zXGJvCF2fBPYFWvw8tjkawVNXdbzx5X1`; its secret is only in the git-ignored
    `apps/game-server/.secrets.staging.json` and the Worker's secrets. The devnet RPC faucet is closed to scripts, so
    (with your OK) I sent it 1.5 devnet SOL from your WSL CLI wallet `2vN2…hsfY`.
20. **Heads-up: escrow money tables are already retired in Unity.** `PokerClientGame.IsMoneyTable` is `false` on main
    and on `web/unity-port`, and commit `dd50a964` on the `magicblock-switch` branch deletes the escrow program, its
    backend routes and the client code ("onchain play runs only on poker-game-v2"). Live SOL play is the PER private
    tables. The plan doc still lists the escrow, so I built its server side (below); see question 12 before I build
    the player-facing part.
21. **SOL escrow tables on the game server (server side done).** `poker-money…` rooms open where `MONEY_TABLES=1`
    (staging only) and the key is set. The room creates its own table on chain with the server's key, and the table
    plays without bots or Agents. A player buys in with their own wallet (`buy_in`), and the server sits them with
    their seat's on-chain chips. Each hand is a round: `begin_round` before the deal, then `settle_round` with every
    chip change. The settle carries any mid-hand buy-ins along, as the program requires, and the server re-reads the
    seats afterwards and halts if the chain holds less than the table shows. A leaver is paid at the hand boundary
    (`cash_out`, plus their seat rent back in the same transaction). Closing the room pays every seat left, including
    a buy-in that never sat, then runs `close_table`. The escrow is the ledger: D1 only records the table
    (`escrow_tables`, migration 0009). No XP or missions on SOL tables (as in Unity). Code:
    `apps/game-server/src/escrowTable.ts`, `packages/chain/src/escrowClient.ts`, and a hand gate in
    `PokerServerGame`. Tests: a fake chain that enforces the program's rules (rounds, nonces, pending buy-ins, no
    cash-out mid-round), and decoders checked against web3.js.
22. **Blocker found: devnet's public RPC refuses Cloudflare Workers.** The deployed game server got
    `403 "Your IP or provider is blocked from this endpoint"` from `api.devnet.solana.com` (the same call from this
    machine answers 200). It's visible at `GET /v1/chain/config` (`rpcError`). The Worker needs another devnet RPC
    (question 13). Until then `scripts/escrow-check.ts --local` runs the same tables in-process on this machine against
    the real devnet program. It uses the same key and the real web client; only D1 is the local stand-in.
23. **Phase 6 escrow gate passed on devnet** (local server, 9 Nov; `results/escrow-check-1794208765231.json`).
    - Three throwaway wallets were each funded with 0.13 SOL from the server key and signed in by wallet.
    - Each bought in with its own `buy_in` built by the web client's escrow coder. Carol's landed mid-hand, as
      1,000 pending chips, which the next settlement moved into play.
    - 20 rounds were settled. Bob cashed out after round 10 with 1,150 chips; Alice left with 700 and Carol with 1,150.
    - The room idled out and `close_table` closed the table and the vault.
    - Every lamport is accounted for: payouts total exactly 3 buy-ins (0.3 SOL), and each wallet's only cost was the
      5% rake and one 5,000-lamport fee. Seat rent came back with each cash-out.
    - What was left in the test wallets went back to the server key, which now holds 1.4847 SOL. A run costs about
      0.015 SOL, almost all of it the rake on three buy-ins (paid to the escrow's dev wallet). Table rent comes back
      on close.
24. **The Worker now uses the Unity client's Alchemy devnet URL** (your choice, 9 Nov). It is stored as the
    `SOLANA_RPC_URL` Worker secret, in the git-ignored secrets file and nowhere in the repo; `/v1/chain/config`
    reports the public devnet URL to clients, never the secret one. The first staging run then failed, and that showed
    two more problems, both fixed:
    - **Alchemy's free tier refuses `getProgramAccounts`.** The server used it to find seats with a mid-hand
      buy-in, so the settle after Carol's buy-in failed and the table halted (safely: seats stayed on chain).
      Now the server reads the seats of the wallets it knows in one `getMultipleAccounts` call. Only when the table's
      counts show a seat it doesn't know (a buy-in that never sat) does it try `getProgramAccounts`, and then the
      fee payers of the table's own transactions, which works on any tier. Tested with an RPC that refuses
      `getProgramAccounts`.
    - **A deploy never drained SOL rooms.** The drain listed rooms from `table_sessions`, which SOL tables don't
      write, so the halted table was left "open" with no room. The drain now includes `escrow_tables`, and a
      minute cron sweep (also `POST /v1/admin/escrow-sweep`) pays out and closes any SOL table its room left
      behind. Each sweep claims a table first, so two sweeps can't work the same one; my first manual sweep did
      race the cron's and lost harmlessly. The sweep paid the halted table's three seats (1,000 + 850 + 1,150
      chips, exactly the buy-ins) and closed it, and it also cleaned up the earlier failed create.
25. **Phase 6 escrow gate passed on deployed staging** (`results/escrow-check-1794211836397.json`). Same run as
    decision 23, with the Worker doing all the signing:
    - 20 rounds settled, including Carol's mid-hand buy-in (1,000 pending chips), and Bob cashed out at round 10.
    - Payouts were Alice 1,100, Bob 1,000 and Carol 900 chips: exactly three buy-ins.
    - The room idled out and closed the table and the vault.
    - The test wallets went back to the server key.
26. **PER on the new stack: a new program instance, the keeper in a Cloudflare Container, data in D1** (your choices,
    9 Nov: hybrid, a new program, Cloudflare Containers).
    - **Program:** `7LcbAnHBFHkviM6AhGgmm871VYNkTU8HTt2bTWVWLKBn`, built from `Poker/per` with the repo's pinned
      script (your global Solana and Anchor untouched). It was deployed by your deployer `4kiqWY…`, which stays the
      upgrade authority and admin. It reserves 3% growth room instead of the script's 25%: the deployer had 17.3 SOL
      and 25% needed 18.9, and the program can be extended later.
    - **Setup:** the same one-time setup the test program had (`v3-setup.ts` with the v4 keys): config, fees
      (2% / 8%, hosting fees off), a delegated Agent sponsor, the keeper funded with 1.5 SOL, and both game balances
      opened.
    - **New keys:** `v4-keeper` (`GV5LYv…EcJw`) and `v4-auditor` (`5hEB5u…RQaWi`), in your WSL `poker-per` folder
      and in the git-ignored `apps/per/.secrets.staging.json`. The archive key and admin token are new. The Poker
      repo was put back to the test program's id afterwards.
    - **Service (`apps/per`):** the Railway service copied into `container/` and run as one Cloudflare Container
      (`basic`, max 1 instance). The Worker in front of it does three things:
      - answers the lobby reads (`/tables…`) from its own D1 database (`nomad-poker-per-staging`);
      - forwards everything else, with the caller's IP for the 120-a-minute limit;
      - pings the container every minute so the keeper keeps running.

      The container reaches D1 only through the Worker (an outbound handler at `http://d1.per/query`), so it
      holds no database credential.
    - **Postgres → D1:** a shim keeps the node-postgres interface. It translates the Postgres-only SQL and returns
      the same types. Two queries were rewritten (the rollback move, and `stddev_samp`, now computed in JS).
      `admitSpend`'s transaction is one atomic insert. Advisory locks are replaced by a 30 s lease in D1, so a
      deploy's brief overlap can't run two keepers.
    - **Port testing:** a test prepares all 73 queries against the D1 schema and checks the types and the rewritten
      ones. It caught two real problems: SQLite has no data-modifying CTE, and SQLite treats a numeric string as
      larger than any number, which would have let host credits overspend.
    - **Exit gate:** the PER keeper suite (`Poker/per/tests/keeper.devnet.ts`, 27 checks) passed against the
      service run locally (`apps/per/results/m7-keeper-local-…json`), then against deployed staging
      (`m7-keeper-staging-pass-…json`). It covers the lobby finding the table, the keeper starting hands and timing
      a player out, archived and audited logs, verify, commit, cash-out, close and the lobby dropping the table.
      Staging failed at first, for three reasons, each proved before fixing:
      - **D1 was on another continent.** The container runs in Chicago (`ORD`, from `/audit/where`) and the first D1
        database was in APAC, so each keeper query took about 220 ms and a hand's log was missed. It is now on a
        D1 in ENAM, at 16–19 ms. The APAC database (`nomad-poker-per-staging`) is unused, with test rows only;
        tell me if I should delete it.
      - **A latent keeper bug** that the faster loop exposed: it committed a fresh table before anyone sat. The
        program only takes an outsider's commit once the table has changed (`CommitTooSoon`, which first showed up
        as an empty error, so failed actions now log the error's name, cause and program logs). The keeper now
        checks `committed_ledger_seq` / `committed_hand_no` first.
      - **Right after `open_log`,** the rollup sometimes needs a moment before the auditor's read sees the log. That
        failed the action into the keeper's 30 s backoff, and the next hand began meanwhile. The read is now
        retried for up to 4 s.

      The last two fixes also apply to the Railway service's code (Poker/per/backend). I didn't change the Poker
      repo.
    - **Web client:** `?perprogram=nomad` (the default in the staging web build) uses this program and service.
      The existing test and live options are unchanged.
27. **Escrow money tables removed from the new stack** (your call, 9 Nov: PER only, as in Unity).
    - **Removed:**
      - the game server's money rooms, escrow host, chain routes and sweep;
      - the engine's hand gate;
      - the `@nomad/chain` package and the `escrow_tables` record (migration 0010);
      - the web client's escrow program client, cash-out screen and room-mode probe;
      - the escrow program's source and IDL.
    - **Kept:** all of it is in git history (`5645313`, `92c490d`). Every escrow table was already paid out and
      closed on chain. The game server's devnet key, holding about 1.45 devnet SOL from your WSL wallet, is kept
      retired in the git-ignored `apps/game-server/.secrets.retired-escrow.json`.
    - **Staging redeployed.** One ordering slip: I applied the drop migration before deploying the code that stopped
      using the table, so the old code's pre-deploy drain failed. No table was open and nobody was seated, so I
      deployed directly, and the drain works again.
28. **Private tables played end to end in the game's own screens** (staging build on `localhost`, 9 Nov). Two
    throwaway devnet wallets were exposed to the page as test wallets, funded from the retired escrow key, and their
    SOL returned afterwards.
    - **What worked:**
      - connecting the wallet and switching to ONCHAIN;
      - depositing 0.5 SOL;
      - Quick Play, where the keeper hosted a table in 9 s and the second wallet was matched to it in 0.5 s;
      - three hands, begun and timed out by the keeper, archived, with logs opened;
      - leaving with the chips back in the game balance, and Withdraw all, paid by the service.

      Both wallets got their SOL back on chain.
    - **Three bugs, each proved before fixing:**
      - **The site's security policy blocked the PER service.** Lobby, Quick Play and Agents failed with
        "HTTP 0" (`connect-src blocked …/flags`), while deposits worked because they go to devnet and the rollup
        directly. The policy now includes the stage's PER URL, and staging is redeployed.
      - **Alchemy's devnet has no `signatureSubscribe`.** web3.js confirms over that WebSocket, so every Solana
        send from the container reported "expired" even when it landed. The keeper created and delegated two
        Quick Play tables but never opened them, and Quick Play timed out. The container now confirms by
        polling, checked with `apps/per/container/test/l1-confirm.devnet.ts`. Those two orphaned tables hold
        about 0.03 SOL of the keeper's rent and nobody's chips.
      - **"Approve the connection in your wallet" covered the wallet picker.** It now appears only once a wallet is
        chosen.
    - **Noted, not changed:**
      - A deposit with too little SOL in the wallet says "sendTransaction failed: error 1".
      - The table showed "TEE not attested (attestation ran)": see decision 29.
29. **"TEE not attested" had two causes.**
    - **Fixed:** the site's security policy blocked `pccs.phala.network`, where the browser attestation fetches
      Intel's TDX collateral, so the check failed before comparing anything ("attestation ran"). It is now allowed,
      and staging is redeployed.
    - **Not fixed:** with that unblocked, the check passes everything but two pins. The quote is genuine Intel TDX
      and up to date (no advisories); `mrTd`, `rtMr0`, `rtMr3`, `mrConfigId` and `mrOwner` match; the enclave signed
      a fresh challenge. But `rtMr1` and `rtMr2`, which measure the boot image and the software it runs, changed
      since the 9 Oct record (`b4fe…` → `5a5e062f…`, `51c0…` → `b90b887d…`), along with the enclave's key. So
      MagicBlock redeployed its devnet TEE. MagicBlock publishes no reference values, and its own SDK check only
      verifies a genuine quote and a challenge. Both records are in `apps/per/results/tee-attestation-*.json`.
      The Unity game uses the same pins (`PerPlatform.cs`), so its badge is red too. Question 14.
30. **The TEE badge is removed from the web game** (your call, 9 Nov, answering question 14). It was a trust signal
    only; the game plays the same without it, and keeping it meant re-pinning after every MagicBlock enclave update.
    - Gone: the badge on both table HUDs (the status now spans the strip), `web3/per/attestation.ts`, the 360 KB
      `assets/web3/per-attest.js`, the pins in `config.ts`, and `pccs.phala.network` in the CSP.
    - Kept: **Verify hand** (proves a finished hand was dealt fairly from the players' seeds), and the attestation
      tools under `onchain/per` (`client-web/per-attest.ts`, `scripts/probe-tee-attestation.ts`) for checking the
      enclave by hand.
    - The Unity game is untouched and still shows its (red) badge.
31. **Your answers of 9 Nov, and what followed.**
    - **Domain:** `nomadpoker.fun` will be the main site; the Vercel and `workers.dev` addresses stay until you say.
    - **Admins:** you are the only admin. Admins are still added by an operator, now with one command,
      `node infra/add-admin.mjs <stage> <player id | wallet | Friend ID> [admin|support]` (`--remove`, `--list`); it
      refuses guest accounts and writes a `grant` / `revoke` audit row. You have no account on staging yet, and
      staging's email sign-in hands the link to whoever asks (no mail provider), so an email address can't prove it's
      you there: sign in with your wallet, open `/admin.html`, and run the command it shows (or send me the player id).
    - **Web admin page** (`/admin.html`, `apps/web/src/admin/`): find a player; see their balances, sign-ins, seat,
      Agents, tournaments, recent ledger and admin history; adjust a balance (admin only, confirmed, retry-safe); ban
      or lift a ban; the ledger reconciliation; integrity leads; the audit log. It uses the game's sign-in in the same
      browser, and the API checks the role on every call (new `GET /v1/admin/me` tells the page which role you have).
      Player-typed text is always shown as text. Checked in the browser with stubbed admin answers (search, adjust,
      ban, all tabs, phone width); against staging, a signed-in non-admin gets the "not an admin" page. The auto-mode
      permission check refused granting admin to a QA account, so the admin role itself is covered by the API tests.
    - **Asia PER database deleted** (`99fe2920…`); nothing used it.
    - **The two stuck Quick Play tables** (`hCxu…`, `AFLA…`) and the played one (`7fyD…`) are empty and idle; the
      keeper closes empty tables after 6 hours idle and takes its rent back, so they go by themselves around
      16:30–17:00 UTC on 9 Nov.
    - **Empty-wallet deposits** now say "Your wallet has 0.12 SOL. Depositing 0.5 SOL needs a little more…" before the
      wallet is asked to sign (and before the one-time game-balance rent is spent). Proved first: a devnet simulation
      of an over-balance transfer fails with the System Program's code 1 and the log "Transfer: insufficient
      lamports"; the game looked code 1 up in the poker program's errors and printed "error 1". Any such failure that
      still gets through reads as plain words too.
    - **Escrow text** removed from `apps/web/docs/live-backends.md` (the web build has no escrow tables).
    - **On hold:** alerts, scheduled backups, native Google ids, the coach's key, JDK 21. **Alchemy only** for RPC.
32. **Load test for 100 daily players: passes at 3× the worst-case peak, after one fix.** Worst case: all 100 at once,
    so 3× = 300 players at the same time, 60 tables of 5 (plus filler bots), 10 minutes, at real speed.
    - **Result** (`apps/game-server/results/load-1794238509007.json`): 300/300 seated, joins 1.3 s typical and 1.7 s
      at p95, 896 hands, no client errors, no sequence errors, **drift 0 on all 60 tables**.
    - **The bug the first real-speed run found** (one table of 60 off by 112): when a hand ends, the engine unlocks
      the seats a moment before the table settles the hand. A Leave in that gap released the seat and cashed it out
      at once; the settlement then read that stack as 0, logged "Chip conservation broken", halted the table's books and
      skipped the hand's house result. The player's own balance was right; the house's books were short. Fixed by
      keeping seats locked from the deal until the settlement ends (`pokerServerGame.ts`); `settleRace.test.ts` steps
      into exactly that gap and fails without the fix.
    - **The limit, measured:** the first run used staging's QA speed (20×), about 20 times real players' traffic.
      There the single staging database refused writes ("D1 DB is overloaded"): over 1,000 stack checkpoints and 95
      cash-outs failed, leaving 66 seat locks with stale stacks (paid back, stale, when those guests next joined).
      Nothing near expected load does this, but a database hiccup in production could do the same to a few players:
      fixed in decision 33.
    - QA rooms can now run at real speed: `-x1-` in the room name (`roomSpec.qaSpeed`);
      `npx tsx scripts/load.ts 300 60 10 staging 1`.
33. **The table's money writes ride out a busy database; three more problems the overload test found** (your go-ahead,
    9 Nov).
    - **Retries** (`apps/game-server/src/d1ChipLedger.ts`): cash-outs and recovering a stranded seat try for about
      15 s, stack checkpoints for about 4 s (the next hand's checkpoint supersedes one), with backoff and jitter,
      logging `GAVE UP` if they stop. A retry never pays twice: the credit is keyed to the seat lock, and a retry that
      finds the lock gone after a lost answer counts as paid. Buy-ins are not retried (the player sees it and tries
      again). `d1ChipLedger.test.ts` runs each case over a database that refuses work or loses answers.
    - **A written buy-in reported as failed** (`seatLocks.buyIn`): six players were left unseated with their 500 in a
      lock; each lock was written the same second as a "buy-in failed", because the balance read after the buy-in
      was refused. A refused read now returns success with an unknown balance.
    - **The reconciliation froze the database**: its table check read 94 million rows (16 s) with no index on
      `ledger_entries.ref`, and every other query waited, then failed (a signed-in request: 14 s, then an error). The
      hourly cron and the admin page's Ledger health tab both run it. Migration `0011_ledger_ref_index.sql`: 13 ms; the
      whole reconciliation 1.7 s. Applied to staging; production's deploy scripts refuse to run until it is applied there.
    - **The per-table audit could miscount**: it read the ledger and the seat locks one after the other, so a cash-out
      landing in between was counted in neither (an exact table showed drift -1,473). One batch now.
    - **Result, 300 players at 20× speed** (about 20 times real traffic, `results/load-1794243227728.json`): 300/300
      seated, no client errors, no failed or given-up ledger writes, no stranded seats, drift 0 on all 60 tables. The
      same test before the fixes: 95 failed cash-outs, 66 stale seats, drift on 22 tables.
    - **Deploy lesson:** after the retry deploy, table Durable Objects kept running the previous version for over
      10 minutes, even in new rooms, so one overload run tested old code. Check the version in Workers Logs before
      trusting a test.
    - **Staging's reconciliation stays red** until 9 Dec on the 46 tables damaged by the three runs on old code (rooms
      `qa-load-mw9dfbp7-*`, `qa-load-mw9fslc0-*`, `qa-load-mw9e5fff-41-x1-st100`; load-test guests only).
    - **The two stuck private tables:** the keeper couldn't close them because they were never opened ("expected this
      account to be already initialized"). It now opens such a table first (`keeper.ts`); both were opened at 17:01 UTC.
      Opening starts their idle clock, so the keeper closes them around 23:02 UTC and then takes the rent back. The
      played table (`7fyD…`) closed and its rent came back at 16:53.

## Questions for you

(newest last)

1. ~~**Phase 6 keys.**~~ Answered 9 Nov: yes. Key generated and funded (decision 19).
2. ~~**Where the PER service runs.**~~ Answered 9 Nov: hybrid, a new program instance, Cloudflare Containers
   (decision 26).
3. ~~**Admins for production.**~~ Answered 9 Nov: you are the only admin, and yes to a web admin page (decision 31).
4. **Alerts.** *On hold (9 Nov).* May I set up Cloudflare notifications (to your email) for Worker error spikes, and a
   Workers Logs alert on `[reconcile] PROBLEMS`? That changes account settings, so I didn't.
5. **Scheduled backups.** *On hold (9 Nov).* Running `infra/backup-d1.mjs` daily needs a Cloudflare API token
   somewhere that runs on a schedule. The workflow is ready (`.github/workflows/backup.yml`, daily 04:30 UTC) and does
   nothing until you add a `CLOUDFLARE_API_TOKEN` repository secret (D1 export + R2 write).
6. ~~**Expected peak for the load test.**~~ Answered 9 Nov: 100 daily players for now (decision 31).
7. **App identity for the stores.** Bundle id answered 9 Nov: `com.nomadpoker.app` is final. Still open: a real app
   icon and splash art (the Unity ones are TopDownEngine's placeholders).
8. **Android builds (mostly answered).** *JDK 21 on hold (9 Nov).* Capacitor 8 needs JDK 21 and this machine only has
   Unity's JDK 17, so the debug APK is built in CI instead (`.github/workflows/android.yml`). Release builds and Play
   uploads need a signing key and Play credentials as repository secrets; iOS needs a Mac (or a macOS CI runner) and an
   Apple developer account.
9. **Native Google sign-in** needs OAuth client ids (Android SHA-1 + iOS) from your Google Cloud project. *On hold
   (9 Nov).*
10. ~~**The production domain.**~~ Answered 9 Nov: `nomadpoker.fun` will be the main site; until then the current
    Vercel and `workers.dev` addresses stay (decision 31).
11. **The coach's written note.** *On hold (9 Nov).* It uses Claude (default model `claude-haiku-5-5`) when the API
    has an `ANTHROPIC_API_KEY` secret; without it players get the computed report only.
12. ~~**Build the player side of escrow SOL tables, or drop the escrow?**~~ Answered 9 Nov: removed; PER only
    (decision 27).
13. ~~**A devnet RPC the Worker can reach.**~~ Answered 9 Nov: reuse the Alchemy devnet URL the Unity client ships
    (decision 24). Confirmed 9 Nov: Alchemy only, its limits are enough; no second provider.
14. ~~**The TEE badge's pins (decision 29).**~~ Answered 9 Nov: remove the badge from the web game (decision 30).

