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
| `POST /v1/agents/start` · `GET /v1/agents/progress?session=` · `POST /v1/agents/stop` · `GET /v1/agents/result?session=` · `GET /v1/agents/active` · `GET /v1/agents/history` · `GET /v1/agents/hands?deploymentId=` | Bearer: the Nomad session token. The owner's Agent sessions, in Unity's AgentDeployService wire shapes (see Agents). |

Rooms by name: Quick Play pools and overflow (`poker-free`, `poker-free-st50-2`) open on first join; party codes need
a spawn first; hosted tournaments are one `TRN…` room each (see Tournaments); `qa-…` rooms exist on staging only and
run 20× faster (soak tests); money pools stay off until the on-chain phase. Every room closes after idling empty
(Agents and running tournaments keep it open) and reopens on the next join.

**Every minute (cron):** Agents still waiting for a seat get another try; Agents whose table went quiet for 2 minutes
are asked about, and if their room no longer has them they end with their last checkpointed stack (`server_lost`);
the tournament clock locks or cancels at start times, aborts tournaments no room started (3 minutes) or whose room
stopped heartbeating (3 minutes), and opens the rooms of tournaments starting within 3 minutes.

## Chips

- The hello ticket is the player's Nomad API session token; the ledger checks it in D1.
- Buy-in = one D1 batch: a seat lock (one per player, across all tables) + the ledger debit. Cash-out = one batch: the
  credit (keyed on the lock, so a replay pays nothing) + dropping the lock. Chips are always in the balance or in
  exactly one seat lock.
- After every hand the table checks chip conservation (it halts on a mismatch), checkpoints each stack into its lock,
  and adds the bots' result to `table_sessions.bot_net`.
- A table that dies (deploy without drain, eviction) leaves locks at their last checkpoint. The player's next sit-down
  anywhere asks the owning table whether it still holds the seat; if not, the checkpoint is paid back (`table:recovered`).

**Drift** for a table = cash-outs + stacks still seated − buy-ins + bot_net + agent_net (Agents' result there; their
chips move through their own ledger entries). It must be zero. `GET /v1/admin/reconcile` on the API checks it for every
table, with the other money invariants, and the cron runs that hourly (a `[reconcile] PROBLEMS` warning in the logs).

## Progress

After each hand the table records, for every Nomad player dealt in, 10 XP (+25 for winning a pot) and mission
progress (hands played, hands won, wins with a pair / two pair or better), keyed per hand so a retry counts once; a
buy-in counts the table toward Table Hopper. Level-ups are paid by the server as the XP lands.

## Agents

The tables are the Agent farm: `POST /v1/agents/start` takes the bankroll from the ledger in the same D1 batch that
creates the deployment (one active Agent per owner, enforced by a unique index), then seats it at the Quick Play table
for its stake or an overflow table with room. `PokerServerGame` already had the seating rules (an empty chair or a
filler bot's, never at its owner's table, filler bots when alone, stops only at a hand boundary); `src/agentDesk.ts`
adds each Agent's limits, its hand records and privacy-filtered replays, a stack checkpoint every hand, and the
completion, which pays the stack back (`agent:<id>:return`) in one batch. A copied market strategy plays its published
numbers, and on a profitable session above the copier's high-water mark its creator's 8 % is credited in that same
batch (the platform's 2 % is withheld). The backend farm's claim / release / control protocol is gone.

A table with only Agents has no sockets, so the Durable Object sets an alarm every 30 s while anything is seated (it
also refreshes the Agents' rows).

## Tournaments

The API creates tournaments and registers players (host prize and entry fees leave through the ledger in the same
batch as the record). The game server runs them: a `TRN…` room hosts `TournamentServerGame` (moved to
`@nomad/table-server/tournament`) with `src/tournamentHost.ts` reading the roster from D1, verifying each player's
hello ticket (their Nomad token), freezing the roster at the start time, heartbeating, and posting the standings,
which pay 1st and 2nd (`trn:<id>:payout:<place>`) once. A cancelled or aborted tournament refunds every entry and the
host prize. Players are named by Friend ID in rosters and standings. A deploy restarts Durable Objects, so a
tournament running across a deploy is aborted and refunded by the cron.

## Play style (My Twin, coach)

`src/styleRecorder.ts` records every decision a Nomad player makes (strength, pot, price, position, action) and each
hand's outcome into `style_decisions` / `style_hands`; the API fits My Twin and the coach report from them.

## Hand records

Each settled hand (every event the table sent, to everyone and to each player, plus stacks and the house result) is
batched and written to R2 gzipped: `hands/<yyyy>/<mm>/<dd>/<room>/<tableId>/<first>-<last>.jsonl.gz`.

## Commands (in this folder)

```bash
npm test                      # end-to-end in Node: real client, real tables, ledger SQL on node:sqlite
npm run dev                   # local Worker on http://localhost:8789 (local D1/R2)
npm run deploy:staging        # drain, build, deploy (needs .secrets.staging.json)
npx tsx scripts/soak.ts 1000  # exit-gate soak: two staging guests, 1,000 hands with bots, zero drift
npx tsx scripts/agent-check.ts 8      # Phase 5 gate: an Agent plays 8 hands and pays back; a second is stopped
npx tsx scripts/tournament-check.ts   # Phase 5 gate: 8 staging guests play a hosted tournament; prizes in the ledger
```

`.secrets.<stage>.json` (git-ignored) holds `{ "DRAIN_TOKEN": "<random>" }`; it is uploaded with each deploy.

The web client plays here with `?netServer=staging` (it signs in to the staging API as a guest if needed); its Agents
and tournaments use these servers too. Without a Nomad server configured, Agents run in the browser's local farm and
tournaments show demo data.
