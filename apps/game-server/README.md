# @nomad/game-server

The game server: one Cloudflare Durable Object per table, running the same authoritative table as the local Node
server (`@nomad/table-server`: rooms, `PokerServerGame`, bots, the binary event codec) with its chips on the Nomad
ledger in D1 and every hand recorded to R2. Staging: https://nomad-poker-game-staging.kshitijiitgn.workers.dev

| Route | What it does |
|---|---|
| `GET /v1/health` | Liveness. |
| `GET /v1/tables/ws?session=<name>` | WebSocket to that table's Durable Object. The client then speaks the local server's protocol unchanged (`join`, `hello`, actions, chat, voice signalling; binary frames are C# codec events). Origin must be an allowed web origin (staging also accepts no Origin, for test harnesses). |
| `POST /v1/tables/spawn` `{ code }` | Creates a party room under its code (PokerDedicatedPartySpawner). |
| `POST /v1/tables/overflow` `{ failed, minBuyIn }` | The next Quick Play overflow table that is not full. |
| `POST /v1/admin/drain` | Bearer `DRAIN_TOKEN`. Every open table finishes its hand, pays everyone out and closes. Run before each deploy (the deploy scripts do). |
| `GET /v1/admin/audit?room=` | Bearer `DRAIN_TOKEN`. Where every chip of that room's tables went (see Drift). |

Rooms by name: Quick Play pools and overflow (`poker-free`, `poker-free-st50-2`) open on first join; party codes need
a spawn first; `qa-…` rooms exist on staging only and run 20× faster (soak tests); money pools stay off until the
on-chain phase. Every room closes after idling empty and reopens on the next join.

## Chips

- The hello ticket is the player's Nomad API session token; the ledger checks it in D1.
- Buy-in = one D1 batch: a seat lock (one per player, across all tables) + the ledger debit. Cash-out = one batch: the
  credit (keyed on the lock, so a replay pays nothing) + dropping the lock. Chips are always in the balance or in
  exactly one seat lock.
- After every hand the table checks chip conservation (it halts on a mismatch), checkpoints each stack into its lock,
  and adds the bots' result to `table_sessions.bot_net`.
- A table that dies (deploy without drain, eviction) leaves locks at their last checkpoint. The player's next sit-down
  anywhere asks the owning table whether it still holds the seat; if not, the checkpoint is paid back (`table:recovered`).

**Drift** for a table = cash-outs + stacks still seated − buy-ins + bot_net. It must be zero.

## Progress

After each hand the table records, for every Nomad player dealt in, 10 XP (+25 for winning a pot) and mission
progress (hands played, hands won, wins with a pair / two pair or better), keyed per hand so a retry counts once; a
buy-in counts the table toward Table Hopper. Level-ups are paid by the server as the XP lands.

## Hand records

Each settled hand (every event the table sent, to everyone and to each player, plus stacks and the house result) is
batched and written to R2 gzipped: `hands/<yyyy>/<mm>/<dd>/<room>/<tableId>/<first>-<last>.jsonl.gz`.

## Commands (in this folder)

```bash
npm test                      # end-to-end in Node: real client, real tables, ledger SQL on node:sqlite
npm run dev                   # local Worker on http://localhost:8789 (local D1/R2)
npm run deploy:staging        # drain, build, deploy (needs .secrets.staging.json)
npx tsx scripts/soak.ts 1000  # exit-gate soak: two staging guests, 1,000 hands with bots, zero drift
```

`.secrets.<stage>.json` (git-ignored) holds `{ "DRAIN_TOKEN": "<random>" }`; it is uploaded with each deploy.

The web client plays here with `?netServer=staging` (it signs in to the staging API as a guest if needed).
Tournaments and Agents still run on the local Node server (Phases 4–5).
