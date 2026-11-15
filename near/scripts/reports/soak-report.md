# Soak report: table.nomad-poker.testnet

Run 2026-11-15T02:11:32.313Z against `table.nomad-poker.testnet` (agents v2). Script: `near/scripts/soak.mjs`.

**4 sessions, 149 hands, 171 s. Reconciliation: 23 of 23 checks pass.**

Setup: the pools of `nomad-b`, `nomad-d` (four different pros), each staking 60 chips
(0.060000000 NEAR, 15% of the smallest pool) per session, up to 50 hands, blinds 1/2. Sessions are
opened by the feeder's function-call key, played by the OutLayer dealer (seated from the deck proof, actions attested)
and settled on the contract. Every number below comes from the contract's views (`get_pool`, `get_earnings`,
`list_agents`) before and after, and from the payouts the contract returned when it settled each session.

## Sessions

| Session | Hands | Seat order | Results (chips) | Dealer wait | Settlement |
| --- | --- | --- | --- | --- | --- |
| soak744ix-0 | 33 | nomad-d, nomad-b | nomad-d +60, nomad-b -60 | 6 s | [Ec8paPkr…](https://testnet.nearblocks.io/txns/Ec8paPkrroXMQbQpA9ECshBNKL8SAPWbACjScg61eJVx) |
| soak744ix-1 | 41 | nomad-b, nomad-d | nomad-b -60, nomad-d +60 | 6 s | [6eE7xEnM…](https://testnet.nearblocks.io/txns/6eE7xEnMBggkNdGcSYryEf1cj415Pe6oALwxunMmmEDz) |
| soak744ix-2 | 25 | nomad-d, nomad-b | nomad-d +60, nomad-b -60 | 6 s | [4ioVXraj…](https://testnet.nearblocks.io/txns/4ioVXrajHvwgmjkiQKTUczu3GncFtNkm3fRJGNznDM7Z) |
| soak744ix-3 | 50 | nomad-d, nomad-b | nomad-d -14, nomad-b +14 | 145 s | [FqobFZ7t…](https://testnet.nearblocks.io/txns/FqobFZ7tDLC4aJLQXNjeyhDTWG88cLhtw6eV3QHLnGgo) |

## Pools (NEAR)

| Pool | Pro | Before | Staked | Returned to backers | Pro fee 8% | Platform fee 2% | After (contract) | Drawdown after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nomad-b | pro-b.nomad-poker.testnet | 0.750200000 | 0.240000000 | 0.074000000 | 0.000000000 | 0.000000000 | 0.584200000 | 22.12% |
| nomad-d | pro-d.nomad-poker.testnet | 0.351200000 | 0.240000000 | 0.396300000 | 0.007760000 | 0.001940000 | 0.507500000 | 2.68% |

Fee earnings on the contract: `pro-b.nomad-poker.testnet` 0.030239999 → 0.030239999; `pro-d.nomad-poker.testnet` 0.000160000 → 0.007920000; `table.nomad-poker.testnet` 0.018179999 → 0.020119999.

Rake: agent sessions take none. Every session's cash-outs equal its buy-ins exactly; the only charges are the
performance fees (8% pro, 2% platform) on gains above each pool's high-water mark.

## Listing after the run

- `nomad-b`: strategy v2, 17 sessions / 614 hands under it, qualified (open to new backers)
- `nomad-d`: strategy v2, 17 sessions / 614 hands under it, qualified (open to new backers)

## Checks

| Check | Result | Detail |
| --- | --- | --- |
| soak744ix-0: chips conserved, no rake | ok | bought in 0.120000000, cashed out 0.120000000 NEAR over 33 hands |
| soak744ix-0 nomad-d: 90/8/2 split | ok | cash-out 0.120000000 = backers 0.120000000 + pro 0.000000000 + platform 0.000000000; gain 0.060000000 |
| soak744ix-0 nomad-b: 90/8/2 split | ok | cash-out 0.000000000 = backers 0.000000000 + pro 0.000000000 + platform 0.000000000; gain 0.000000000 |
| soak744ix-1: chips conserved, no rake | ok | bought in 0.120000000, cashed out 0.120000000 NEAR over 41 hands |
| soak744ix-1 nomad-b: 90/8/2 split | ok | cash-out 0.000000000 = backers 0.000000000 + pro 0.000000000 + platform 0.000000000; gain 0.000000000 |
| soak744ix-1 nomad-d: 90/8/2 split | ok | cash-out 0.120000000 = backers 0.116300000 + pro 0.002960000 + platform 0.000740000; gain 0.060000000 |
| soak744ix-2: chips conserved, no rake | ok | bought in 0.120000000, cashed out 0.120000000 NEAR over 25 hands |
| soak744ix-2 nomad-d: 90/8/2 split | ok | cash-out 0.120000000 = backers 0.114000000 + pro 0.004800000 + platform 0.001200000; gain 0.060000000 |
| soak744ix-2 nomad-b: 90/8/2 split | ok | cash-out 0.000000000 = backers 0.000000000 + pro 0.000000000 + platform 0.000000000; gain 0.000000000 |
| soak744ix-3: chips conserved, no rake | ok | bought in 0.120000000, cashed out 0.120000000 NEAR over 50 hands |
| soak744ix-3 nomad-d: 90/8/2 split | ok | cash-out 0.046000000 = backers 0.046000000 + pro 0.000000000 + platform 0.000000000; gain 0.000000000 |
| soak744ix-3 nomad-b: 90/8/2 split | ok | cash-out 0.074000000 = backers 0.074000000 + pro 0.000000000 + platform 0.000000000; gain 0.014000000 |
| pool nomad-b: value | ok | 0.750200000 + returned 0.074000000 - staked 0.240000000 = 0.584200000; contract says 0.584200000 |
| pool nomad-b: fees paid | ok | contract 0.000000000 = pro 0.000000000 + platform 0.000000000 |
| pool nomad-b: nothing left at the table | ok | at_table 0.000000000 |
| pool nomad-d: value | ok | 0.351200000 + returned 0.396300000 - staked 0.240000000 = 0.507500000; contract says 0.507500000 |
| pool nomad-d: fees paid | ok | contract 0.009700000 = pro 0.007760000 + platform 0.001940000 |
| pool nomad-d: nothing left at the table | ok | at_table 0.000000000 |
| pro pro-b.nomad-poker.testnet: earnings | ok | +0.000000000 NEAR on the contract; 8% fees in payouts 0.000000000 |
| pro pro-d.nomad-poker.testnet: earnings | ok | +0.007760000 NEAR on the contract; 8% fees in payouts 0.007760000 |
| platform table.nomad-poker.testnet: earnings | ok | +0.001940000 NEAR on the contract; 2% fees in payouts 0.001940000 |
| money only moves | ok | pools -0.009700000 + fee earnings 0.009700000 = 0.000000000 (joins minus leaves 0.000000000) |
| fees are 8% and 2% of the same base | ok | pro 0.007760000, platform 0.001940000 (ratio 4.0000, rounding down per seat) |

## Earlier soak runs the same day

This report is the last of five runs. The earlier ones, all settled on testnet:

1. `soak6ymop`: 3 sessions, 133 hands, four pools, 34 of 34 checks, but no fees were due (every winning pool was
   still below its high-water mark), so the fee checks were trivial. Settlements
   [FHeBuVYa…](https://testnet.nearblocks.io/txns/FHeBuVYag1qjh1UxKb93jFjaSbGk7cpuBfdVCdqVpotK),
   [7BgnbBFx…](https://testnet.nearblocks.io/txns/7BgnbBFxvtiQKpdz1ywiDsgPUgahBk2jy7ZYrepeEp4c),
   [DKpLPfRR…](https://testnet.nearblocks.io/txns/DKpLPfRRUss7o1EmN6veQELkf1eP4HvqfMbuErDsg2yA).
2. `soak6zy0u`: 4 sessions, 178 hands, fees charged (pro 0.0124, platform 0.0031 NEAR, money conserved), but two
   per-seat split checks failed because the script's fee-base bound was wrong (it used pro fee × 125 instead of
   × 12.5); the contract's numbers were right (for example 0.107 = 0.1027 + 0.00344 + 0.00086). Fixed in the script.
3. `soak71txo`: settled two sessions, then the contract refused the third: nomad-c's pool was 54.20% below its
   high-water mark, past the 50% default loss limit. The feeder stopped without retrying, as it should.
4. `soak73d5c` (nomad-a, b, d): one session of 24 hands, 19 of 19 checks with fees, then the contract refused
   nomad-a's pool (53.82% below its high-water mark).

So by the end, nomad-a and nomad-c take no new sessions until their pros' backers leave or the limit is raised; the
loss limit worked on real money twice.
