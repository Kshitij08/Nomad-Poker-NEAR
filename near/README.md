# Nomad Poker on NEAR: private dealer spike

This folder is the NEAR build, started at the `pre-hackathon` tag. Everything above it is the existing Solana game.

Agent hands are dealt and played inside sealed hardware (OutLayer, Intel TDX). A NEAR contract then checks the
dealer instead of trusting it: it verifies OutLayer's randomness proof, re-deals every hand from it, and replays every
action under the betting rules.

| Folder | What it is |
| --- | --- |
| `poker-core` | Shuffle, deal, hand ranking, betting, sessions, hole-card sealing. Shared by the dealer and the contract. |
| `dealer` | The OutLayer program (`wasm32-wasip2`). Actions: `session`, `play`, `deal`, `showdown`. |
| `table-spike` | The NEAR contract. Opens hands and sessions and settles them from the dealer's answer. |
| `poker-wasm` | poker-core's session replay compiled to WebAssembly, so Node shows exactly what the contract settled. |
| `feeder` | The run-ahead server: fetches and settles session N+1 while session N plays back. |
| `web` | The app: back an agent's pool with a NEAR wallet, watch settled sessions, and check each one in the browser. |
| `escrow` | The stakes contract for human tables, hosted tables and tournaments (see Escrow below). Live as `nomad-escrow.testnet`. |
| `scripts` | `run-session.sh` plays and settles one session; `hand.mjs` opens sealed hole cards. |

## Live on testnet

- Dealer: OutLayer project `nomad-poker.testnet/nomad-dealer`
- Contract: `table.nomad-poker.testnet`
- Escrow (human money tables): `nomad-escrow.testnet`, operator `nomad-poker.testnet`

## Try it

Checks, no accounts needed:

```bash
cd poker-core && cargo test --features seal,agent
cd table-spike && cargo test
```

Play and settle a 50-hand session (needs the NEAR and OutLayer CLIs signed in to testnet, an OutLayer payment key for
the dealer project, and the table's owner key):

```bash
scripts/run-session.sh my-session-1 50
```

You see the dealer's wait and run time, then the settlement transaction and each seat's result.

## Backing vault

Anyone can fund a pro's agent and keep 90% of what it wins. It lives in the table contract, so a session's
verification and every payout happen in one transaction.

1. A pro registers an agent: `register_agent(agent_id, tight, aggro)`. The pro's account receives 8% of profits.
2. A backer funds it: `back(agent_id, loss_limit?)` with NEAR attached. One position per backer and agent.
3. The game server opens a backed session: `open_backed_session(session_id, seats, buy_in_chips, ...)`. Each seat
   buys in from its position, only if losing the whole buy-in stays within the loss limit.
4. `submit_session` verifies the hands, then cashes out every seat. Fees apply only to profit above the position's
   previous peak: 8% to the pro, 2% to the platform, the rest to the backer.
5. Backers `withdraw` idle funds; pros and the platform `claim_earnings`. A session the dealer never answered can be
   cancelled after an hour, returning the buy-ins.

**Pools.** Instead of one backer per seat, a seat can be an agent's pool, shared by many backers through shares:
`join_pool(agent_id)` with NEAR attached, `leave_pool(agent_id, shares)`. Joins and leaves made while the pool is in
a session are queued and applied at the value it settles at. Fees apply only to gains above the pool's best value per
share. A session stakes at most 25% of the pool by default (`set_pool_risk`, up to 50%, set by the pro). Pass a seat
with no `backer` to seat a pool, or `--pool` to the feeder.

Every step logs a `nomad-vault` event. Try it with the feeder on a backed table:

```bash
node src/cli.mjs --table-id demo --sessions 2 --hands 10 --speed 2 --agents nomad-a,nomad-b,nomad-c,nomad-d --buy-in 100
```

## The app

```bash
cd web && npm install && npm run dev        # http://localhost:5190
```

- **Watch:** the table replays the most recent settled sessions hand by hand. Your browser re-deals every hand from the
  dealer's randomness proof with poker-core (compiled to WebAssembly) and checks the result matches what the contract
  paid out.
- **Back:** connect a NEAR testnet wallet (NEAR Connect), pick an agent and join its pool, or leave it.
- **Your stakes:** what each pool share is worth now; pros see and claim their earnings.
- **List your agent:** pros register an agent with its playing style.

`npm run build` rebuilds `public/poker_wasm.wasm` when Rust is installed and otherwise uses the committed copy, so it
builds on hosts without Rust (such as Vercel).

## Escrow

`escrow` holds players' stakes for human tables, hosted tables and tournaments. The table server still deals and runs
the games at normal speed and is trusted to report results (the operator); the contract holds the money, refuses any
table that would pay out more than it took in after rake, and logs every step as a `nomad-escrow` event. Amounts are
yoctoNEAR (`U128` strings); table limits are chips (0.001 NEAR each) and buy-ins are whole chips.

```bash
cd escrow && cargo test        # in WSL: aws-lc-sys does not build on Windows
cargo near build non-reproducible-wasm --no-abi
```

**On testnet:** `nomad-escrow.testnet` (a faucet-funded account, which is also the owner), operator
`nomad-poker.testnet` (the game server). `escrow/deploy.sh [contract] [operator]` builds, deploys with `new` and opens
the house tables; run it in WSL. The house tables' ids are the game server's room names, 6 seats each:

| Table id | Blinds (chips) | Buy-in (chips) | Buy-in (NEAR) |
| --- | --- | --- | --- |
| `poker-money-st50` | 1/2 | 50 to 200 | 0.05 to 0.2 |
| `poker-money-st100` | 2/5 | 100 to 500 | 0.1 to 0.5 |
| `poker-money-st500` | 10/25 | 500 to 2500 | 0.5 to 2.5 |

**If the operator disappears:** a seated player calls `reclaim(table_id)` once the operator has done nothing on that
table for 24 hours (`get_table(...).reclaimable_at`, nanoseconds). They get their seat's locked amount (the buy-in
after rake) back to their game balance, never more than the table still holds, and can then `withdraw` it.

```bash
near contract call-function as-transaction nomad-escrow.testnet reclaim json-args '{"table_id":"poker-money-st50"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <you>.testnet network-config testnet sign-with-keychain send
```

| Method | Who | What |
| --- | --- | --- |
| `new(operator)` | deployer (becomes owner) | Rake and tournament fee 5%. |
| `deposit()` payable | anyone | Adds NEAR to the game balance. |
| `withdraw(amount)` | anyone | Takes idle game balance out; a failed transfer is put back. |
| `open_table(table_id, config)` | operator | A house table. `config`: `small_blind`, `big_blind`, `min_buy_in`, `max_buy_in` (chips), `seats` (2 to 10). |
| `create_hosted_table(table_id, config, invites?)` | anyone (the host) | With `invites`, only those accounts and the host may buy in. |
| `set_invites(table_id, invites?)` | host | Replaces the invite list; `null` opens the table. |
| `buy_in(table_id, amount?)` payable | player | From the attached deposit and game balance (default: exactly the deposit). 5% rake to platform earnings, the rest locked for the player. Top-ups count toward the maximum. |
| `cash_out(table_id, player, amount, key)` | operator | Pays a seated player's stack to their game balance. Same key again: no-op (returns false). Refused if the player is not seated or the table would pay out more than it locked. |
| `close_table(table_id)` | operator or host | No more buy-ins. Once nobody is seated the table is finalised and the remainder (locked minus paid) goes to platform earnings, reported in `table_finalized`. |
| `reclaim(table_id)` | seated player | Once the operator has done nothing on the table (open, cash out, close) for 24 hours, takes the seat's locked amount back to the game balance, capped by what the table can still pay. Removes the seat; logs `reclaimed`. A closed table is finalised after the last seat leaves. |
| `create_tournament(tournament_id, name, entry_fee, max_players, starts_at, code_hash?, prize?)` payable | anyone (the host) | `prize` from the attached deposit and balance; `code_hash` is the hex SHA-256 of a private code. |
| `register(tournament_id, code?)` payable | player | Pays the entry fee before the start. |
| `leave(tournament_id)` | player | Before the start; full refund to the game balance. |
| `cancel_tournament(tournament_id)` | host before the start, operator until settled | Refunds every entry and returns the prize. |
| `settle_tournament(tournament_id, placings)` | operator | After the start. 5% of entries to the platform; the rest plus the prize pays 1st 60%, 2nd 40% (all to a lone player). Same placings again: no-op; different ones refused. |
| `claim_platform_earnings(amount?)` | owner | Sends platform earnings to the owner. |
| `set_operator`, `set_owner`, `set_fees(rake_bps?, tournament_fee_bps?)` | owner | Fees capped at 20%. |
| `set_reclaim_after(seconds)` | owner | How long the operator must be idle before `reclaim` (default 86400, at least 3600). |

Views: `get_config`, `get_balance(account)`, `get_totals` (deposited, withdrawn, balances, at tables, in tournaments,
platform earnings), `get_platform_earnings`, `get_table`, `get_seat`, `get_cash_out(table_id, key)`, `get_invites`,
`may_join`, `get_tournament`, `is_registered`. `get_table` includes `last_operator_at` and `reclaimable_at` (nanoseconds) and
`reclaims`; `get_config` includes `reclaim_after_secs`.

At all times `balances + at_tables + in_tournaments + platform_earnings == deposited - withdrawn`; the tests check it
from the views alone through 1,500 random steps.

## Run-ahead

OutLayer's testnet queue can take minutes to start a dealer run, but a session of agent hands takes longer than that
to watch. The feeder asks for session N+1 as soon as session N starts playing, settles it on the contract, and replays
it with the same poker-core code, so viewers only wait for the first session.

```bash
cd feeder && npm install && npm run build:wasm && npm test        # offline: fake dealer and table, real poker code
node src/cli.mjs --table-id demo --sessions 3 --hands 30          # live: prints each hand and how far ahead it ran
```

The live run reads the same keys as the scripts (see the top of `feeder/src/cli.mjs`), and keeps its place in
`feeder-state-<table-id>.json`, so a restart continues the chain.

## Known limits

- Opening a hand or session is owner-only until the dealer signs its answers; until then the relaying server could
  ask for a hand more than once.
- The proof reveals the whole deck, so folded hands become public once settled.
- OutLayer's testnet queue adds 1 to 9 minutes per dealer call.
- Backed sessions are settled before viewers see them play, so results are on-chain ahead of playback.
- The contract pays for vault storage itself; there is no storage deposit per position yet. The escrow does the same
  for tables and tournaments.
- The escrow trusts the operator for results. If the table server stops, seated players' stakes wait for it (or a
  new operator the owner sets); there is no player-initiated refund yet.
- A pool's high-water mark is per pool, not per backer: someone who joins after a drawdown pays no fees on the
  recovery up to the old peak.
