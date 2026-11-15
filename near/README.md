# Nomad Poker on NEAR

This folder is the NEAR build, started at the `pre-hackathon` tag. The folders above it are the game client, API and
game server that use these contracts.

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

- Dealer: OutLayer project `nomad-poker.testnet/nomad-dealer` (agents v2 and NEAR-AI agents, version `e18a6962bb`)
- Contract: `table.nomad-poker.testnet`, operator `feeder.nomad-poker.testnet` (the feeder; see Operator below)
- Agents: `nomad-a` (pro `pro.nomad-poker.testnet`, Autopilot), `nomad-b` (`pro-b`, Daredevil), `nomad-c` (`pro-c`,
  Trapper), `nomad-d` (`pro-d`, a custom Guardian), `nomad-e` (`pro`, Guardian; no pool). The pro accounts are
  `<name>.nomad-poker.testnet`.
- After the soak test (15 Nov) the pools of nomad-a and nomad-c are past the 50% loss limit and take no new
  sessions; nomad-b and nomad-d play. All four strategies have their track record (open to new backers).
- Escrow (human money tables): `nomad-escrow.testnet`, operator `nomad-poker.testnet`

## Try it

Checks, no accounts needed:

```bash
cd poker-core && cargo test --release --features seal,agent,nearai
cd table-spike && cargo test
cd poker-wasm && cargo test --release
cd feeder && npm test                 # includes nearai.test.ts (a real NEAR AI signature)
```

Rust builds and tests run in WSL (aws-lc-sys does not build on Windows); Node runs on Windows.

Play and settle a 50-hand session (needs the NEAR and OutLayer CLIs signed in to testnet, an OutLayer payment key for
the dealer project, and the table's owner key):

```bash
scripts/run-session.sh my-session-1 50
```

You see the dealer's wait and run time, then the settlement transaction and each seat's result.

## Backing vault

Anyone can fund a pro's agent and keep 90% of what it wins. It lives in the table contract, so a session's
verification and every payout happen in one transaction.

1. A pro registers an agent with its strategy: `register_agent(agent_id, profile)` (see Agents v2). The pro's account
   receives 8% of profits.
2. A backer funds it: `back(agent_id, loss_limit?)` with NEAR attached, once the strategy has a track record (the pro
   may always fund their own agent). One position per backer and agent.
3. The feeder (operator) opens a backed session: `open_backed_session(session_id, seats, buy_in_chips, ...)`. Each
   seat buys in from its position, only if losing the whole buy-in stays within the loss limit.
4. `submit_session` verifies the hands and the dealer's attestation, then cashes out every seat. Fees apply only to profit above the position's
   previous peak: 8% to the pro, 2% to the platform, the rest to the backer.
5. Backers `withdraw` idle funds; pros and the platform `claim_earnings`. A session the dealer never answered can be
   cancelled after an hour, returning the buy-ins.

**Pools.** Instead of one backer per seat, a seat can be an agent's pool, shared by many backers through shares:
`join_pool(agent_id)` with NEAR attached, `leave_pool(agent_id, shares)`. Joins and leaves made while the pool is in
a session are queued and applied at the value it settles at. Fees apply only to gains above the pool's best value per
share. A session stakes at most 25% of the pool by default (`set_pool_risk`, up to 50%, set by the pro). Pass a seat
with no `backer` to seat a pool, or `--pool` to the feeder.

**P&L.** Each holding and each pool keeps a cost basis: `deposited` (NEAR that became shares, including queued joins at
the value they were applied at) and `withdrawn` (NEAR paid out by leaves). P&L = `value + withdrawn - deposited`.
`get_holding` returns `{ shares, value, deposited, withdrawn, pending_in, pending_out_shares }` and the pool view adds
`deposited` and `withdrawn` (all yoctoNEAR strings). Holdings and pools that existed before this (15 Nov) were started at
their value then by `init_cost_basis` (owner), so their P&L counts from that moment; any missed one starts the same way
when first touched.

Every step logs a `nomad-vault` event. Try it with the feeder on a backed table (pools, 60-chip buy-ins):

```bash
node src/cli.mjs --table-id demo --sessions 2 --hands 10 --speed 4 --agents nomad-a,nomad-b,nomad-c,nomad-d --pool --buy-in 60
```

## Agents v2

Agents play the Nomad app's Strategy tab (`packages/engine/src/agents`): the "smart" brain (`HeuristicBot.decideV2`:
Monte-Carlo equity against random hands, a heads-up equivalent, pot odds, stack-to-pot sizing) driven by the five
numbers, the per-street overrides and the position weight. It lives in `poker-core` (modules `profile` and `agent`) and
runs only inside the sealed dealer. Every decision is a pure function of (profile, hand seed, action index, table
state): random draws come from SplitMix64 seeded by SHA-256, and the math uses only IEEE-exact operations (no libm), so
the dealer, native tests and the WebAssembly build agree (the feeder's tests check a golden session against native).

**Profile JSON** (what `register_agent`, `update_agent`, `get_profile` and `list_agents` use). Numbers are hundredths, so
the app's 0.35 is `35`:

```json
{
  "fold_below": 35, "raise_above": 58, "aggression": 45, "bluff_chance": 3, "raise_size": 60,
  "position_weight": 0,
  "streets": [
    { "fold_below": 10, "raise_above": 55, "aggression": 60, "bluff_chance": 5, "raise_size": 60 },
    { "fold_below": 50, "raise_above": 70, "aggression": 45, "bluff_chance": 0, "raise_size": 50 },
    { "fold_below": 50, "raise_above": 70, "aggression": 45, "bluff_chance": 0, "raise_size": 50 },
    { "fold_below": 50, "raise_above": 70, "aggression": 45, "bluff_chance": 0, "raise_size": 50 }
  ],
  "style": "Autopilot"
}
```

| Field | App setting | Range |
| --- | --- | --- |
| `fold_below` | Fold below (Calling bets) | 10 to 55 |
| `raise_above` | Raise above (Hands it plays) | 45 to 90 |
| `aggression` | Aggression (Raise vs call) | 10 to 95 |
| `bluff_chance` | Bluff chance | 0 to 25 |
| `raise_size` | Raise size, share of the pot | 30 to 120 |
| `position_weight` | Position weight (optional, default 0) | 0 to 100 |
| `streets` | Per-street overrides (optional): `[]`, or four entries [preflop, flop, turn, river], each `null` or its own five numbers | as above |
| `style` | Display name only (optional, up to 24 letters, digits, spaces or `-_'.`) | |

The ranges are the engine's `BotProfile.clamped`; an out-of-range value is refused with the field's name. The presets
(`Profile::preset`, `feeder/src/profiles.mjs`): Autopilot `[35,58,45,3,60]` with its own streets (`[10,55,60,5,60]` before
the flop, `[50,70,45,0,50]` after); Guardian `[40,60,25,2,45]`; Trapper `[30,52,15,0,60]`; Daredevil `[22,52,75,8,90]`.

First-generation agents (`{tight, aggro}`) keep working: they play the v2 profile `Profile::from_legacy` maps them to
(fold_below 10 + 0.45·tight, raise_above 50 + 0.3·tight, aggression 10 + 0.85·aggro, bluff 0.08·aggro, size 40 +
aggro/2), `register_agent` still accepts `tight` and `aggro`, and views still return the nearest `tight` and `aggro`.
Settled sessions verify as before: the contract replays actions and never re-derives decisions.

**Registering from the app** (the player's wallet signs; 30 Tgas, no deposit):

```js
nearCall("table.nomad-poker.testnet", "register_agent", { agent_id: "my-agent", profile }, 0n, 30n);
// a new strategy later (a new strategy version; the track record restarts):
nearCall("table.nomad-poker.testnet", "update_agent", { agent_id: "my-agent", profile }, 0n, 30n);
```

`profile` is the Strategy tab's numbers times 100: `fold_below = round(values[0] * 100)` through
`raise_size = round(values[4] * 100)`, `position_weight = round(positionWeight * 100)`, and `streets` from
`AgentStrategyState.streets` the same way (each `null` or five numbers), or `[]` when no round has its own.

**Rules the contract enforces**

- **Self-play guard.** `open_backed_session` refuses two seats whose agents belong to the same pro. Agents are seated
  from the session's randomness, not in the order listed: the request says `"seating": "vrf"`, the dealer seats the
  listed agents by `session::seat_order(seed)`, and settlement applies the same order. Results, payouts and the history
  record are by table position (`seat_order[p]` is the listed seat at position p).
- **Listing.** New backers may `join_pool` or `back` an agent only once its current strategy version has a track
  record: `min_sessions` settled sessions and `min_hands` hands (testnet defaults 3 and 50; the owner sets them with
  `set_listing_rules`). The pro may always fund their own agent, which is how a record starts. `update_agent` starts a
  new version and the record over; a session opened before the change does not count toward the new version. Existing
  backers stay and may leave as usual.
- **Pool loss limit.** A pool takes no new sessions once its value per share is `loss_limit_bps` below its high-water
  mark (owner default 5000 = 50%, `set_default_pool_loss_limit`; a pro may set a tighter one with
  `set_pool_loss_limit(agent_id, bps)`, or `null` for the default). This is on top of the 25% per-session risk cap.
  Backers can always leave; the pool plays again only if its limit is loosened (up to the default) or the owner raises
  the default.
- **Attested actions.** For sessions opened by `open_backed_session` (`"attest": "v1"` in the request), the dealer signs
  the actions in the same run with OutLayer's VRF key (label `act-<sha256>` over the session id, the deck proof, the
  request and the actions: `session::attest_digest`). `submit_session(..., attest_alpha, attest_signature_hex)` refuses
  such a session without a matching attestation, so a relayer cannot change an action, even into another legal one.
- **Operator.** `set_operator(account)` (owner) names the feeder. It may open sessions (`open_session`,
  `open_backed_session`, `open_play`) and cancel unanswered ones after an hour, nothing else: every owner-only method
  refuses it.

**New and changed methods**

| Method | Who | Notes |
| --- | --- | --- |
| `register_agent(agent_id, profile?, tight?, aggro?)` → `AgentView` | anyone (becomes the pro) | A profile, or the old two numbers. |
| `update_agent(agent_id, profile)` → `AgentView` | the agent's pro | A new strategy version; the track record restarts. |
| `transfer_agent(agent_id, new_owner)` | the agent's pro | Hands the agent and its future pro share to another account. |
| `set_pool_loss_limit(agent_id, loss_limit_bps?)` | the agent's pro | 1 up to the default; `null` uses the default. |
| `set_operator(operator?)`, `set_listing_rules(min_sessions, min_hands)`, `set_default_pool_loss_limit(loss_limit_bps)` | owner | |
| `submit_session(session_id, alpha, signature_hex, actions, attest_alpha?, attest_signature_hex?)` | anyone | Backed sessions need the attestation. |
| `open_session`, `open_backed_session`, `open_play`, `cancel_session` | owner or operator | Were owner only. |

| View | Returns |
| --- | --- |
| `get_agent(agent_id)` | `AgentView`: `{ id, owner, tight, aggro, sessions, hands, net_chips, created_at, profile, strategy_version }` |
| `get_profile(agent_id)` | the profile JSON above |
| `get_listing(agent_id)` | `{ agent_id, strategy_version, sessions, hands, min_sessions, min_hands, qualified, open_to_backers }` (`hands` and `min_hands` are strings) |
| `get_pool_limits(agent_id)` | `{ loss_limit_bps, pro_loss_limit_bps, default_loss_limit_bps, drawdown_bps, price, hwm_price, max_buy_in_bps, accepts_sessions }` |
| `get_rules()` | `{ operator, min_sessions, min_hands, pool_loss_limit_bps }` (`min_hands` is a number here) |
| `list_agents(from_index?, limit?)` | `[{ agent: AgentView, pool: PoolView \| null, listing, limits }]` (was `{ agent, pool }`) |
| `get_session_record(session_id)` | as before plus `seating` and `seat_order`; `stacks` and `profiles` are by table position |

**Upgrading in place.** Everything new is stored under its own keys (`g` rules, `x` agent strategies, `w` strategy
versions per open session), so the contract deploys over the old one with `near contract deploy ... without-init-call`;
pools, positions, earnings and history are untouched. This version also fixes the vault config read:
`set_vault_config` was never read back, because `LazyOption::new(key, None)` does not load storage (none was set on
testnet).

## NEAR-AI agents: a private strategy, chosen by a private model

A pro can keep their strategy secret and still let backers check how the agent was played. They write instructions
in plain words ("aggressive heads-up specialist; bluff half as much after a losing run"); a private model on NEAR AI
Cloud, running in a TEE, turns them into each session's v2 profile inside the sealed dealer. The text never appears on
chain; the model's signed choice does.

1. **Seal.** The pro's browser seals the text to the dealer's X25519 key (`get_strategy_key()`), with the agent id as
   associated data, and stores only the ciphertext: `set_private_strategy(agent_id, model, eph, ct)`
   (`sealStrategy` in `feeder/src/nearai.ts`; `poker_core::seal::seal_strategy` in Rust). The dealer made its key
   once (`strategy_key` action) from fresh randomness and keeps it in OutLayer worker storage, which every version of
   the project can read and nobody outside the sealed runtime can. This is a new strategy version (the track record
   restarts); the agent's v2 profile stays as its fallback. `clear_private_strategy` goes back.
2. **Choose.** `open_backed_session` puts the sealed text in the NEAR-AI seat's request (`profiles[i].private`). Once
   per session per NEAR-AI seat, the dealer opens it, asks the model (`poker_core::nearai::request_body`: system
   rules, the private text, the agent's public results, a fresh nonce; thinking off, at most 120 tokens) with the
   `NEAR_AI_API_KEY` project secret, reads the reply into a profile (`profile_from_response`), and fetches NEAR AI's
   signature for it. Then it plays the session deterministically with that profile. A model that cannot be asked in
   time (the dealer stops starting calls after 35 s of OutLayer's 60 s) plays the fallback, listed in
   `near_ai_errors`.
3. **Prove.** The dealer's output carries, per NEAR-AI seat: `seat`, `agent_id`, `model`, `chat_id`, the raw
   `response` (only the numbers), `signature_text` (`<model>:<sha256 of request>:<sha256 of response>`), `signature`
   (EIP-191, secp256k1) and `signing_address`, and the `profile`. `submit_session(..., near_ai)` checks each one on
   chain: the address is on the table's list of attested signers for that model (`set_near_ai_signer`, owner, after
   `scripts/verify-near-ai.ts --signer <model>` checks its TDX quote binds the address), the signature recovers to
   it (`ecrecover`), it signs exactly this response, and the response says exactly this profile. The dealer's VRF
   attestation covers the profiles it played, so a proof cannot be dropped or swapped. Proofs are kept in the session
   record (`near_ai`).
4. **Check.** Anyone: `node scripts/verify-near-ai.ts <session_id> --attest` re-checks every proof from the record and
   asks NEAR AI Cloud for the model's attestation with a fresh nonce (the quote's REPORTDATA must be the signing address
   followed by the nonce). The quote's own Intel signature chain and the GPU evidence: https://cloud.near.ai/verify.
   The web app can call `verifyNearAiProof(record.near_ai[i], signers)` and `checkAttestation(model, address)` from
   `feeder/src/nearai.ts` (only @noble and fetch).

What stays private and what does not: the strategy text is on chain only sealed; NEAR AI sees it inside the model's
TEE; the public signature names only the request's hash, and the request has a fresh nonce so guessed texts cannot be
checked against it. The model's reply is public, so the dealer and the contract refuse replies with reasoning text.

**On testnet:** model `Qwen/Qwen3.6-35B-A3B-FP8` (Private TEE), signer `0xfdbd7952498b333206f360d71d97a1e0961e8ddf`;
nomad-b and nomad-d are NEAR-AI agents. Session `ailive-1` was the first ([proofs](scripts/reports/near-ai-ailive-1.md)).
A session costs about 350 tokens per NEAR-AI agent, about $0.00012 at this model's price ($0.17 / $1.10 per million
input / output tokens), and adds about 4 s to the dealer run.

| Method / view | Who | Shape |
| --- | --- | --- |
| `set_private_strategy(agent_id, model, eph, ct)` → strategy version | the agent's pro | `eph` 32-byte hex, `ct` hex of 17 to 1016 bytes |
| `clear_private_strategy(agent_id)` → strategy version | the agent's pro | |
| `get_private_strategy(agent_id)` | view | `{ model, sealed_bytes, set_at }` or null; also `get_agent(..).private_strategy` |
| `get_strategy_key()` | view | dealer X25519 public key, hex |
| `set_strategy_key(public_key_hex)`, `set_near_ai_signer(model, signing_address, allowed)` | owner | |
| `get_near_ai_signers()` | view | `[{ model, signing_addresses: ["0x…"] }]` |
| `submit_session(..., near_ai?)` | anyone | `near_ai`: `[{ seat, agent_id, model, chat_id, response, signature_text, signature, signing_address, profile }]` |
| `get_session_record(id).near_ai` | view | the same proofs; `seat` is the listed seat, `seat_order.indexOf(seat)` its table position |

The feeder attaches the secret to each dealer run (`secrets_ref: {profile: "default", account_id: OWNER}`; set
`SECRETS_PROFILE`/`SECRETS_ACCOUNT` to change it). Make an agent a NEAR-AI agent from the command line:

```bash
node scripts/near-ai-agent.ts --agent nomad-b --pro pro-b.nomad-poker.testnet --file strategy.txt
```

## Operator: the feeder's limited key

The feeder never holds the owner's key. On testnet:

1. `feeder.nomad-poker.testnet` is its own account, and the owner named it: `set_operator({"operator": "feeder.nomad-poker.testnet"})`.
2. Its working key is a function-call key for the table and the session methods only (NEAR also refuses any deposit
   with it):

   ```bash
   near account add-key feeder.nomad-poker.testnet grant-function-call-access --allowance '1 NEAR' \
     --contract-account-id table.nomad-poker.testnet \
     --function-names 'open_backed_session, open_session, submit_session, cancel_session' \
     use-manually-provided-public-key ed25519:<public key> network-config testnet sign-with-legacy-keychain send
   ```

3. That key alone sits in its own credentials folder, `~/.near-credentials/feeder/feeder.nomad-poker.testnet.json`, and
   the feeder reads only that folder. The account's full-access key stays in the normal keychain for top-ups.

```powershell
$env:NEAR_CREDENTIALS_DIR = '\\wsl.localhost\Ubuntu\home\kshit\.near-credentials\feeder'
$env:OUTLAYER_KEYS_FILE = '\\wsl.localhost\Ubuntu\home\kshit\.outlayer\testnet\payment-keys.json'
node src/cli.mjs --table-id v2live --sessions 3 --hands 10 --speed 4 --agents nomad-a,nomad-b,nomad-c,nomad-d --pool --buy-in 60
```

With that key the feeder cannot withdraw, leave a pool, claim earnings or call an owner method (NEAR refuses before
the call reaches the contract); signing as its account with any key, the contract refuses those too.

## Proof scripts

Node on Windows with keys from the WSL keychain (see the top of each script):

- `scripts/attack-report.mjs`: the feeder's key, the operator account, a pro and a stranger try to take pool money, call
  owner-only methods, break the self-play guard, a loss limit, the risk cap or the listing rules, and settle a real
  session with a forged proof, another session's proof, an illegal or a legal edit of its actions, or no attestation.
  Every attempt must be refused: [`scripts/reports/attack-report.md`](scripts/reports/attack-report.md).
- `scripts/soak.mjs [--sessions 3] [--hands 50]`: runs backed sessions of the four pools, then reconciles from the
  contract's views that pool values, the 8% pro and 2% platform fees and fee earnings add up to the yoctoNEAR, with no
  rake: [`scripts/reports/soak-report.md`](scripts/reports/soak-report.md).

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

The game app (`apps/web`, https://nomad-poker-near.vercel.app) has all of this under **Agents › Back a pro**, plus:
stake and withdraw (part or all), P&L from each holding's `deposited` and `withdrawn`, session results, NEAR AI
proofs re-checked in the browser (`apps/web/src/near/nearAi.ts`, pinned to the feeder's code by tests), and, in
On-chain, listing your own agent and setting its private strategy from **Agents › Overview**.

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

**Hosted tournaments for NEAR** reuse the Coins tournament machinery (`packages/db/src/tournaments.ts`, currency
`'near'`): D1 keeps the record, roster and clock; the escrow holds the money under the same tournament id. The app's
Host tab has a NEAR stakes option (fees and prizes in chips of 0.001 NEAR). The flow:

1. The host (signed in with NEAR) creates it in the API (hidden), their wallet calls `create_tournament` with the prize
   attached, and `POST /v1/tournaments/<id>/confirm-escrow` checks `get_tournament` matches (host, fee, prize, size,
   start, private) before anyone else can see it.
2. Players' wallets `register` / `leave`; the API's register / unregister only change the roster once `is_registered`
   agrees. The host's wallet cancels with `cancel_tournament`, then the API marks it cancelled.
3. The game server (the operator) settles it when the tournament room posts its result (`settle_tournament` with the
   NEAR accounts in finishing order), and its minute cron refunds anything cancelled or aborted here but still open on
   the escrow (`cancel_tournament`). Both read the escrow first, so a repeat does nothing; see
   `apps/game-server/src/tournamentEscrow.ts`. The API needs `NEAR_ESCROW` (and `NEAR_RPC_URL`) set.

`NEAR_LIVE=1 … npx vitest run src/__tests__/nearTournamentLive.test.ts` in `apps/game-server` runs create, register
both test accounts, cancel and refund against the real escrow (gas only).

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

- Opening a session is limited to the owner and the operator, but the operator could still ask the dealer for a
  session under several ids and open only the one it likes. Actions are attested by OutLayer's VRF key under the
  dealer's account; OutLayer's proof does not name the project, so whoever can run another OutLayer program under that
  account could produce attested sessions of their own.
- The agent brain is the app's smart brain with deterministic draws and f64 math, so it plays like the app's agents
  but not bit for bit (the app uses System.Random and float32).
- The proof reveals the whole deck, so folded hands become public once settled.
- OutLayer's testnet queue adds 1 to 9 minutes per dealer call.
- Backed sessions are settled before viewers see them play, so results are on-chain ahead of playback.
- The contract pays for vault storage itself; there is no storage deposit per position yet. The escrow does the same
  for tables and tournaments.
- The escrow trusts the operator for results. If the table server stops, a seated player can `reclaim` their stake
  after 24 hours of operator silence (see Escrow above).
- A pool's high-water mark is per pool, not per backer: someone who joins after a drawdown pays no fees on the
  recovery up to the old peak.
