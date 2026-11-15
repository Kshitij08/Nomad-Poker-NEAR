# Cost basis backfill: table.nomad-poker.testnet

15 Nov 2026. The pool P&L upgrade started every existing holding at its value then (`init_cost_basis`), so P&L read
0 for backers who joined earlier. This replaces that with each holding's real history.

- History: `node near/scripts/cost-basis-history.mjs` read all 183 transactions to the table (NearBlocks v3) and the
  `nomad-vault` events in the 47 joins, leaves and settlements among them (RPC). Result: one immediate join per
  holding, no leaves, no queued moves, no cancelled sessions with moves. Each join's amount at that day's share price
  matches the holding's shares (for example 0.01 NEAR at 1.1314 → 0.008838 nomad-a shares). No transaction touched
  the table between the history read and the correction except the deploy.
- Correction: `correct_cost_basis` (owner, once; bookkeeping only, no NEAR moved),
  [3Z36AWom…](https://testnet.nearblocks.io/txns/3Z36AWomdkeynMJjdZ9772usZ1Tp21nQFUMv9h2kD7ud), after deploying the
  contract in place, [5Md2cHWC…](https://testnet.nearblocks.io/txns/5Md2cHWC92j56dsYnH6ZoNXzBty9FKkX4JnMf2oxp6iS).

P&L = value + withdrawn − deposited (NEAR):

| Holding | Value | Deposited before | Deposited after | Withdrawn | P&L before | P&L after |
| --- | --- | --- | --- | --- | --- | --- |
| nomad-poker.testnet / nomad-a | 0.237403 | 0.237403 | 0.400000 | 0.000000 | +0.000000 | -0.162597 |
| nomad-poker.testnet / nomad-b | 0.654056 | 0.654056 | 0.400000 | 0.000000 | +0.000000 | +0.254056 |
| nomad-poker.testnet / nomad-c | 0.244200 | 0.244200 | 0.400000 | 0.000000 | +0.000000 | -0.155800 |
| nomad-poker.testnet / nomad-d | 0.427500 | 0.427500 | 0.400000 | 0.000000 | +0.000000 | +0.027500 |
| pro.nomad-poker.testnet / nomad-a | 0.059351 | 0.059351 | 0.100000 | 0.000000 | +0.000000 | -0.040649 |
| kshitijgajapure.testnet / nomad-a | 0.005246 | 0.005246 | 0.010000 | 0.000000 | +0.000000 | -0.004754 |
| kshitijgajapure.testnet / nomad-b | 0.010144 | 0.010144 | 0.010000 | 0.000000 | +0.000000 | +0.000144 |

Pools (totals are the sum of their holders):

| Pool | Value | Deposited | Withdrawn | P&L |
| --- | --- | --- | --- | --- |
| nomad-a | 0.302000 | 0.510000 | 0.000000 | -0.208000 |
| nomad-b | 0.664200 | 0.410000 | 0.000000 | 0.254200 |
| nomad-c | 0.244200 | 0.400000 | 0.000000 | -0.155800 |
| nomad-d | 0.427500 | 0.400000 | 0.000000 | 0.027500 |
