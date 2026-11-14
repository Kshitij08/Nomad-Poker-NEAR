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
| `scripts` | `run-session.sh` plays and settles one session; `hand.mjs` opens sealed hole cards. |

## Live on testnet

- Dealer: OutLayer project `nomad-poker.testnet/nomad-dealer`
- Contract: `table.nomad-poker.testnet`

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

Every step logs a `nomad-vault` event. Try it with the feeder on a backed table:

```bash
node src/cli.mjs --table-id demo --sessions 2 --hands 10 --speed 2 --agents nomad-a,nomad-b,nomad-c,nomad-d --buy-in 100
```

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
- The contract pays for vault storage itself; there is no storage deposit per position yet.
- Positions are per backer and agent; a pooled vault with shares comes next.
