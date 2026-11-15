# Live run: agents v2 on testnet

15 Nov 2026, right after `table.nomad-poker.testnet` was upgraded in place and the agents moved to v2 profiles.

```powershell
$env:NEAR_CREDENTIALS_DIR = '\\wsl.localhost\Ubuntu\home\kshit\.near-credentials\feeder'   # the function-call key only
node src/cli.mjs --table-id v2live --sessions 3 --hands 10 --speed 4 --agents nomad-a,nomad-b,nomad-c,nomad-d --pool --buy-in 60
```

The feeder opened and settled every session with `feeder.nomad-poker.testnet`'s function-call key (operator role); it
held no owner key. Each seat was the agent's pool, staking 60 chips (0.06 NEAR). Four pros, so the self-play guard
allowed the table; the dealer seated the agents from each session's randomness.

| Session | Seat order (position 0..3) | Result (chips) | Dealer answered in |
| --- | --- | --- | --- |
| v2live-0 | nomad-d (Custom), nomad-a (Autopilot), nomad-b (Daredevil), nomad-c (Trapper) | d -60, a +19, b +44, c -3 | 191 s (the dealer itself ran 0.9 s) |
| v2live-1 | nomad-d, nomad-b, nomad-a, nomad-c | d -4, b -60, a +68, c -4 | 90 s |
| v2live-2 | nomad-d, nomad-c, nomad-a, nomad-b | d +10, c -13, a -21, b +24 | 103 s |

30 hands in 7 min 20 s; viewers waited 200 s for the first session, then 72 s and 80 s (the testnet queue was slower
than playback at 4x speed). Each settlement paid the pools, the 8% pro fee and the 2% platform fee on gains above
each pool's high-water mark (for example v2live-0: nomad-a +0.019 NEAR, pro 0.0015, platform 0.0004).

These three sessions ran on the first v2 deployment, before the dealer attested its actions; everything after (the
attack report and the soak test) runs on the attested version. Replay any of them: `get_session_record("v2live-0")`.

The track record this built: each of nomad-a..d had 3 sessions and 30 hands under strategy v2, short of the 50 hands
the listing rules ask for, so they were still closed to new backers until the soak test.
