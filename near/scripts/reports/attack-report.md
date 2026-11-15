# Attack report: table.nomad-poker.testnet

Run 2026-11-15T02:03:59.587Z against `table.nomad-poker.testnet` (agents v2). Script: `near/scripts/attack-report.mjs`.

**Result: 33 of 33 attempts refused.**

Who attacks:

- **feeder key**: the feeder's only key, a function-call key on `feeder.nomad-poker.testnet` limited to `open_backed_session`,
  `open_session`, `submit_session` and `cancel_session` on the table, with no deposit allowed. Calls to any other
  method are refused by NEAR itself before they become a transaction.
- **operator account**: `feeder.nomad-poker.testnet` signing with its full-access key (which the feeder does not hold), to show
  the contract refuses the operator role on every owner-only method.
- **pro**: `pro-b.nomad-poker.testnet`, the pro of nomad-b.
- **stranger**: `stranger.nomad-poker.testnet`, no role at all.

A `submit_session` with a wrong answer does not fail the transaction: the contract returns `{"ok": false, "error"}`
and changes nothing; the report checks the session is still pending afterwards.

| # | Who | Attempt | Method | Refused | Refusal | Transaction |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | feeder key | take pool money: leave nomad-a's pool | `leave_pool` | yes | Access key does not allow method leave_pool (pool nomad-a still 0.633000000 NEAR) | none: refused before it became a transaction |
| 2 | feeder key | withdraw a backer's position | `withdraw` | yes | Access key does not allow method withdraw | none: refused before it became a transaction |
| 3 | feeder key | claim the platform's fee earnings | `claim_earnings` | yes | Access key does not allow method claim_earnings | none: refused before it became a transaction |
| 4 | feeder key | make itself the vault's fee recipient (owner only) | `set_vault_config` | yes | Access key does not allow method set_vault_config | none: refused before it became a transaction |
| 5 | feeder key | attach NEAR to a session call | `open_session` | yes | Deposit is not allowed with function call | none: refused before it became a transaction |
| 6 | operator account | name another operator (owner only) | `set_operator` | yes | owner only | [FgPHK23F…](https://testnet.nearblocks.io/txns/FgPHK23F83XJop6hqrHiYH68Xn8zwnJormrVAk7c2bYs) |
| 7 | operator account | redirect platform fees to itself (owner only) | `set_vault_config` | yes | owner only | [HpDUjDR1…](https://testnet.nearblocks.io/txns/HpDUjDR1JfXzWhDgJ3mWcvb6jFbnJkZFi2RYDdnXRw6E) |
| 8 | operator account | lift every pool's loss limit (owner only) | `set_default_pool_loss_limit` | yes | owner only | [2djiyMdW…](https://testnet.nearblocks.io/txns/2djiyMdWdAH81udijdJu9ND6KCzoSiv5uuXesDJp4CJq) |
| 9 | operator account | point the table at another dealer (owner only) | `set_project` | yes | owner only | [Gh3UtKs8…](https://testnet.nearblocks.io/txns/Gh3UtKs8P2RfbGifGtE7rBm1AxDdNogemJarWVzwhaQw) |
| 10 | operator account | drop the listing rules (owner only) | `set_listing_rules` | yes | owner only | [6635rjGc…](https://testnet.nearblocks.io/txns/6635rjGcP7fCRUfZEqsrMLX1z1afZPj6Q5V3oEYeMb5C) |
| 11 | operator account | cancel a settled session to unlock its buy-ins again | `cancel_session` | yes | session is not pending | [6S182ENr…](https://testnet.nearblocks.io/txns/6S182ENr9ycDQ7upS1DMLYB7P852vT5i392nPzsKCgue) |
| 12 | pro (pro-b) | take backers' money: leave its own agent's pool without shares | `leave_pool` | yes | more shares than you hold (pool nomad-b still 0.267000000 NEAR) | [AbUT4hrs…](https://testnet.nearblocks.io/txns/AbUT4hrsqh6cEWYyNgbBtkRsxG1Vua66mRQUF3uSN5g7) |
| 13 | pro (pro-b) | withdraw from a position it does not have | `withdraw` | yes | no position | [BozriLMk…](https://testnet.nearblocks.io/txns/BozriLMkQ7fmCHP3vtJm4Cd4GHemykoRNoZAAtrjDFqP) |
| 14 | pro (pro-b) | risk more than 50% of the pool per session | `set_pool_risk` | yes | 1 to 5000 basis points | [7o1ze9kH…](https://testnet.nearblocks.io/txns/7o1ze9kHRqvQKwUamyu4zjqko81UqS8ev216q2PTCmM) |
| 15 | pro (pro-b) | loosen its pool's loss limit past the owner's default | `set_pool_loss_limit` | yes | 1 to 5000 basis points (the default; a pro may only tighten it) | [A2Gt2BGK…](https://testnet.nearblocks.io/txns/A2Gt2BGKuUdE2xxXuF4iquAo7rsNsUnCxv2yy1hTr8Fw) |
| 16 | pro (pro-b) | change another pro's strategy | `update_agent` | yes | only the agent's pro | [FcwU1xoY…](https://testnet.nearblocks.io/txns/FcwU1xoYeh6wmD3W1XrvUBa1t3icsUsJpTSwjTv3ACUG) |
| 17 | pro (pro-b) | take over another pro's agent | `transfer_agent` | yes | only the agent's pro | [8qZeHGNZ…](https://testnet.nearblocks.io/txns/8qZeHGNZgJxGyrbS9pA9uz7abUWSdzV6uGcEoXRwp7gx) |
| 18 | pro (pro-b) | claim fees it did not earn | `claim_earnings` | yes | nothing to claim | [AVQ9Ushu…](https://testnet.nearblocks.io/txns/AVQ9Ushuym3FBDc6ue31hZghZeSWpyi8QEn3QkucLMrp) |
| 19 | stranger | leave a pool it never joined | `leave_pool` | yes | more shares than you hold (pool nomad-a still 0.633000000 NEAR) | [GwYBtxkx…](https://testnet.nearblocks.io/txns/GwYBtxkxpL6XZRqf17UcvRbw5WpGzEEJSEZiraeveYRV) |
| 20 | stranger | claim the platform's fees | `claim_earnings` | yes | nothing to claim | [2BhH7Lda…](https://testnet.nearblocks.io/txns/2BhH7LdayT7Q2yWKMyccU2GZuU238Ee4Mzuv63SWRFEa) |
| 21 | stranger | make itself operator | `set_operator` | yes | owner only | [VDLNTEdN…](https://testnet.nearblocks.io/txns/VDLNTEdN4CAPy8pdPW6Jh1cTJU3d4kUuCPzhwDxaN6W) |
| 22 | stranger | open a session that locks pool money | `open_backed_session` | yes | owner or operator only | [5sdDhXUB…](https://testnet.nearblocks.io/txns/5sdDhXUBE6UaCGUCSJYaiWrvgimqobH4mQ3HkwgTkqqy) |
| 23 | stranger | join nomad-e's pool before its strategy has a track record | `join_pool` | yes | nomad-e is not open to backers yet: strategy v1 has 0 of 3 sessions and 0 of 50 hands | [SZpyhbbR…](https://testnet.nearblocks.io/txns/SZpyhbbRUMdwXLvfQhyw3C2h2CBpnNQSgkm1dUJ7KS1) |
| 24 | stranger | back nomad-e before it qualifies | `back` | yes | nomad-e is not open to backers yet: strategy v1 has 0 of 3 sessions and 0 of 50 hands | [Gmot5pKU…](https://testnet.nearblocks.io/txns/Gmot5pKUf1FQqzxiigtgh35HLt7Noux7azG6hubsSZsT) |
| 25 | feeder key | self-play: seat nomad-a and nomad-e, both pro.nomad-poker.testnet's | `open_backed_session` | yes | self-play: nomad-e and another seat both belong to pro.nomad-poker.testnet | [89rdxS6A…](https://testnet.nearblocks.io/txns/89rdxS6A1Un4E4onnRqhEfSbanT65JQ5ttgpnhtmq5cr) |
| 26 | feeder key | seat nomad-b's pool, now 33.25% below its high-water mark, past its loss limit | `open_backed_session` | yes | pool nomad-b: the pool is 33.25% below its high-water mark, past its loss limit of 33.24% | [EtwHMiwZ…](https://testnet.nearblocks.io/txns/EtwHMiwZFqt41aa42f9dYtHkiKJBa5xwwPoNuicNxX8v) |
| 27 | feeder key | stake more than 25% of nomad-c's pool in one session | `open_backed_session` | yes | pool nomad-c: the buy-in is more than 25% of the pool | [6ghxNLkW…](https://testnet.nearblocks.io/txns/6ghxNLkWZtKgkKFv4YypZwY8Q1YoMwFVQxxcUBUPKDdR) |
| 28 | stranger | forged deck proof (one hex digit of the signature changed) | `submit_session` | yes | returned ok:false: the proof is not signed by OutLayer's randomness key (session still pending, buy-ins still locked) | [r44sZ8v6…](https://testnet.nearblocks.io/txns/r44sZ8v6fUiwHGyER8YHni9QrRV2Mnw3z2f27ezcZf5) |
| 29 | stranger | a real proof from another session (v2live-0) | `submit_session` | yes | returned ok:false: the proof is for another request (session still pending, buy-ins still locked) | [3ieKXMrj…](https://testnet.nearblocks.io/txns/3ieKXMrjDrnJifqhtxX89n57aM3usaD2zbgfVLKQcBAE) |
| 30 | stranger | an illegal edit: one more action after the last hand | `submit_session` | yes | returned ok:false: hand 2: the hand is over (session still pending, buy-ins still locked) | [29VgM7kJ…](https://testnet.nearblocks.io/txns/29VgM7kJ7RWbPNua6k4ocvWgjogxeUPmSQ3cp8HmaveX) |
| 31 | stranger | a legal edit: action 3 "r4" -> "c" (still replays under the rules), with the real attestation | `submit_session` | yes | returned ok:false: the attestation does not match these actions (session still pending, buy-ins still locked) | [9B2uy9t6…](https://testnet.nearblocks.io/txns/9B2uy9t6DZJzuqD7TMyg93jQWdJitpAC2yntADiaCzc) |
| 32 | stranger | the real actions without the dealer's attestation | `submit_session` | yes | returned ok:false: this session needs the dealer's attestation (attest_alpha, attest_signature_hex) (session still pending, buy-ins still locked) | [A9RnfwUM…](https://testnet.nearblocks.io/txns/A9RnfwUMCseQpMhiWPJXjLV7wyoP4w1K2QwEuAcBSqMf) |
| 33 | stranger | the real actions with an attestation signed for other actions | `submit_session` | yes | returned ok:false: the attestation does not match these actions (session still pending, buy-ins still locked) | [2LXJ6odq…](https://testnet.nearblocks.io/txns/2LXJ6odq8KnAmHa9ddkjSY2UDyGzjbj5vnCF5X6Q4E2t) |

Setup and control steps (these are meant to succeed):

| Step | Method | Result | Transaction |
| --- | --- | --- | --- |
| nomad-b's pro sets its pool loss limit to 3324 bps (drawdown 3325 bps) | `set_pool_loss_limit` | ok: null | [ErE9Yaak…](https://testnet.nearblocks.io/txns/ErE9YaakrSmEco3JaKk4gA3QgtuURwz1ctk9wKZUW381) |
| nomad-b's pro clears its own limit again (the default applies) | `set_pool_loss_limit` | ok: null | [BiuCpmma…](https://testnet.nearblocks.io/txns/BiuCpmmaAfTwZ5K9SEbdZ6ZbAwszh1dFRBse2nDVa8fV) |
| feeder opens backed session atk-mwh6x7p8 (pools of nomad-a and nomad-c, 10 chips, 4 hands) | `open_backed_session` | ok: {"action":"session","hand_id":"atk-mwh6x7p8","stacks":[10,10],"profiles":[{"fold_below":35,"raise_above":58,"aggression":45,"bluff_chance":3,"raise_size":60,"po | [48K35bTS…](https://testnet.nearblocks.io/txns/48K35bTSAdf8DFbbAy4MeLughzsNAgkAbHtjFNpVpDuF) |
| dealer answered atk-mwh6x7p8 in 8s with an attested action list | `OutLayer` | ok: vrf:100000063921:nomad-poker.testnet:act-fcdebbf1e49dc9543cf212aff25ae4379757e978aaefba52b8334ecc256d9387 | none: refused before it became a transaction |
| control: the real, attested answer settles atk-mwh6x7p8 | `submit_session` | ok: {"ok":true,"hands_played":3,"stacks":[0,20],"totals":[-10,10],"payouts":{"session_id":"atk-mwh6x7p8","seats":[{"backer":null,"agent":"nomad-c","pro":"pro-c.noma | [4ueBF9ns…](https://testnet.nearblocks.io/txns/4ueBF9nsS3D1yf1p86g2ZfHArb1c142o9rK9XL7FRcig) |
