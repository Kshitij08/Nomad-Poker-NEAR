# Nomad Poker

## NEAR HACKATHON submission

Nomad Poker on NEAR is copy trading for poker. Pros list an AI agent that plays their style; anyone stakes NEAR on
its pool and keeps 90% of what it wins (8% to the pro, 2% to the platform, only on profit). Agents play each other,
so it is a skill market: the pools that grow are the ones whose pros wrote better strategies.

It is close to the private copy-trading idea on [Illia Polosukhin's list for this hackathon](https://x.com/ilblackdragon/status/2118027843980366222)
(4 Nov): a pro's strategy can stay private, while every result is public and checked on chain.

- **Demo video:** [on X](https://x.com/KshitijGajapure/status/2121893569724358873)
- **Overview:** [thread on X](https://x.com/KshitijGajapure/status/2121753190119158185)
- **Live app (NEAR testnet):** https://nomad-poker-near.vercel.app

### The problem

- About 100 million people play poker online. Most lose money for years while they learn, and the few who win only
  earn while they are sitting at the table.
- Players already pay for bots to play for them: black-market poker bots sell for $1,000 or more (PokerBotAI
  pricing), and GGPoker seized $1.2 million from 42 bot accounts in a single sweep (January 2026). That money goes to
  tools that break site rules, and a buyer has no way to check what a bot does or whether its results are real.
- So the demand is there, with no honest place to go: nowhere to back a good player's strategy openly, and no way to
  verify the results before money moves.

### How it works on NEAR

A pro lists an agent on the NEAR table contract, and backers stake NEAR in its pool. The agent plays sessions against
other agents, the OutLayer dealer deals the hands, and the contract checks every hand before any money moves. Each
part of that loop uses NEAR:

- **Why the results can be trusted:** hands are dealt inside sealed hardware (OutLayer, Intel TDX), and a NEAR
  contract verifies the dealer's randomness proof, re-deals every hand and replays every action before paying out.
- **NEAR AI agents (private strategies):** a pro chooses a strategy. The browser seals it so
  only the dealer can read it; each session a private model on NEAR AI Cloud (in a secure enclave) turns it into that
  session's settings, and the contract checks the model's signature before settling. Backers see that it is private
  and that each choice was verified, never the text.
- **NEAR Intents:** a backer holding another chain's crypto sees a live 1Click quote for swapping it into NEAR for a
  pool (quotes only: 1Click has no testnet).
- **No wallet needed:** a new player can get a `<name>.players.nomad-poker.testnet` account made for them, with the
  key kept in the browser (and a backup to save).
- **My Twin (your digital clone):** the game analyses the decisions you make at the tables and fits a profile of how
  you play (how many hands you play, how often you raise, call and bluff, how you size bets). One press turns it into
  your agent, which you can list on NEAR, so backers stake NEAR on it and it plays NEAR sessions on your behalf. Or
  publish it to the strategies marketplace, where copiers pay you 8% of the profit it makes them.
- **Attack test:** on testnet, the feeder's key, the operator account, a pro and a stranger made 33 attempts to take
  pool money or change the rules. All 33 were refused, by the contract or by NEAR's access-key limits:
  [`near/scripts/reports/attack-report.md`](near/scripts/reports/attack-report.md), with a transaction link for each.
- **A full poker game too:** sign in with NEAR (or have an account made), sit at a NEAR table, host one with an invite
  link, or run a NEAR tournament. Hands are played on the table server, so moves cost no gas; only buying in and
  cashing out touch the escrow contract. A coach reviews your recorded hands, with a short note written by a private
  model on NEAR AI Cloud.
- **Business model:** 5% of every NEAR table buy-in and tournament entry (the escrow's rake), and 2% of backing
  profits; nothing when an agent loses.

### NEAR features used

| NEAR feature | Where Nomad Poker uses it |
|---|---|
| Rust contracts (near-sdk) | [`table.nomad-poker.testnet`](https://testnet.nearblocks.io/address/table.nomad-poker.testnet): agents, sessions, the backing vault and pools. [`nomad-escrow.testnet`](https://testnet.nearblocks.io/address/nomad-escrow.testnet): human NEAR tables and tournaments. |
| OutLayer (Intel TDX) | The dealer `nomad-poker.testnet/nomad-dealer` deals every agent hand and is the only one that can read a private strategy. |
| NEAR AI Cloud (private TEE models) | Turns a private strategy into each session's settings, signed and checked by the contract; writes the coach's note. |
| NEAR Intents (1Click) | Live quotes to fund a pool from Ethereum, Base, Arbitrum, Solana, Bitcoin, Tron or Dogecoin. |
| Function-call access keys | The feeder's key can only open, submit and cancel sessions, with no deposit; the attack test tries the rest. |
| Sub-accounts | Players without a wallet get `<name>.players.nomad-poker.testnet`. |
| NEAR Connect | Wallet sign-in in the web app. |

### Tracks

- **Privacy & Private AI:** a pro's strategy is sealed in the browser so only the dealer's enclave
  (OutLayer, Intel TDX) can read it; a private model on NEAR AI Cloud turns it into each session's settings, and the
  contract checks the model's signature and attestation before paying out. Backers never see the strategy. The
  coach's note also comes from a private NEAR AI Cloud model.
- **Autonomous Business:** each agent is a small business that runs without its pro: it plays sessions, the contract
  settles them and splits profit on chain (90% backers, 8% pro, 2% platform, only on profit), with
  per-session risk and loss limits on the pool. Backers can fund it from other chains through NEAR Intents quotes.
- **Agent Economy:** agents earn for the people who back them. Pros list agents on the NEAR table contract (any player
  can turn their own play into one with My Twin), backers buy pool shares with NEAR, the pro earns a cut of the profit, and the pools that grow are the agents that play better.
- **Games With Real Economies:** a full poker game where the stakes are real NEAR: tables and tournaments run through
  an escrow contract, players can get an account made for them, and moves cost no gas, so they never handle the chain
  while playing.
- **Open Innovation:** copy trading for a skill game, with every result re-checked by a contract (and by anyone, in
  the browser) before money moves.

### Disclosure

- **Baseline:** Nomad Poker began as a poker game on Solana. The `pre-hackathon` tag is that game, and it is not part
  of the submission. During the hackathon the NEAR contracts, dealer and feeder were added under [`near/`](near/README.md),
  the game's on-chain mode was moved to NEAR, and the Solana code was removed from `main`.
- **What was built in the window:** [`pre-hackathon...main`](https://github.com/Kshitij08/Nomad-Poker-NEAR/compare/pre-hackathon...main)
  (additions are the NEAR work; most deletions are the removed Solana code).
- **Live on NEAR testnet:** table and backing vault `table.nomad-poker.testnet`, escrow for human tables and
  tournaments `nomad-escrow.testnet`, dealer `nomad-poker.testnet/nomad-dealer` on OutLayer.
- **Libraries and tools:** near-sdk, cargo-near, the OutLayer SDK and CLI, NEAR Connect, NEAR AI Cloud, NEAR Intents
  (1Click), @noble cryptography, and the pre-hackathon
  Nomad Poker web client and engine (baseline). Parts of the code were written with AI coding assistants.
- **License:** All rights reserved. The code may be read, built and run to evaluate the project; see [LICENSE](LICENSE).

### Try it

In the browser, at https://nomad-poker-near.vercel.app (NEAR testnet; the app opens in Demo mode, which plays with
free Coins):

1. Open **Agents**, then **Back a pro**. You see the listed agents, each with its pro, playing style, NEAR in its
   pool and result since start. nomad-b and nomad-d play private strategies (**NEAR AI**).
2. Press **Connect NEAR wallet**, sign in with a testnet account (or let the app make one), and press **Stake** on an
   agent. Your stake and P&L show on its card and under **My stakes**, where **Withdraw** takes some or all of it out.
3. Open **Sessions** and press **Watch** on a settled session. Your browser re-deals every hand from the dealer's
   randomness proof, replays each bet, and checks the final stacks against what the contract paid; sessions marked
   **NEAR AI ✓** also have the private model's signed choices checked. No wallet needed.
4. Switch from Demo to **On-chain**. **Agents › Overview** lists your own agent on NEAR with the Strategy tab's
   settings, and **Private strategy** gives it plain-words instructions instead.
5. After 30 decisions at Coins tables, **Agents › My twin** shows what it learned about your play. **Use My Twin**
   makes your agent play like you; list it from **Overview** with **Review & List on NEAR**, or press **Publish to
   Marketplace**.
6. Still On-chain: the rooms are NEAR tables (buy in with NEAR, leave and the stack goes back to your game balance),
   **Play with friends** hosts a table with an invite link, and **Tournaments** lists NEAR tournaments.
7. After playing some hands, open **Agents › Coach**: your stats, what is working, the biggest leak and what to try
   next, with a note from NEAR AI Cloud.

From a clone, with no accounts (the Rust crates build on Linux or WSL):

```bash
cd near/poker-core && cargo test --features seal,agent   # shuffle, deal, ranking, betting, sealing
cd near/table-spike && cargo test                        # session verification, vault and pools
cd near/escrow && cargo test                             # stakes for human tables and tournaments
cd near/feeder && npm install && npm run build:wasm && npm test
cd near/web && npm install && npm run dev                # http://localhost:5190: replays settled sessions and re-checks each hand in the browser
```

[`near/README.md`](near/README.md) has the contract methods, how to play and settle a session yourself, and the
full list of known limits.

### Limits

- NEAR testnet only, with test NEAR; nothing runs on mainnet, and NEAR Intents shows quotes without swapping.
- Agents play each other, so before fees the backers of one table win what the others lose: it pays to pick the
  better strategy, not to back every pool.
- A private strategy is only as private as the dealer's enclave and NEAR AI's; the contract checks the model's
  signature and the signer's attestation, not the full Intel and GPU evidence chain (cloud.near.ai/verify does that).
- Human NEAR tables and tournaments trust the table server for results; the escrow caps payouts at what came in, and
  a seated player can reclaim their stake after 24 hours of operator silence.

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

npm workspaces, Node 22.18+:

```bash
npm install
npm run dev        # http://localhost:5180
npm run server     # optional local multiplayer table server
npm test           # every workspace
npm run typecheck
```

Secrets and signing keys never go in this repository.
