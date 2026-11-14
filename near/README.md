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

## Known limits

- Opening a hand or session is owner-only until the dealer signs its answers; until then the relaying server could
  ask for a hand more than once.
- The proof reveals the whole deck, so folded hands become public once settled.
- OutLayer's testnet queue adds 1 to 9 minutes per dealer call.
