# apps/per: private tables (PER) on Cloudflare

The PER service of the Unity game (Poker/per/backend, on Railway with Postgres) moved to the new stack (Phase 6, the hybrid plan):

| Part | Where |
|---|---|
| Lobby reads: `GET /tables`, `/tables/:table`, `/tables/:table/hands` | The Worker (`src/lobby.ts`), straight from D1 |
| Everything else: verify, tournaments, SOL Agents and strategies, payouts, `/health`, `/audit/*` | The container (`container/`): the Railway service, ported |
| The keeper loop (tick, archive, open logs, commit, close, tournaments) and the Agent runner | The same container, one instance, holding a D1 lease |
| Data | D1 `nomad-poker-per-staging-us` (schema: `migrations/`) |

Staging: https://nomad-poker-per-staging.kshitijiitgn.workers.dev, for the devnet program instance
`7LcbAnHBFHkviM6AhGgmm871VYNkTU8HTt2bTWVWLKBn`, which has its own keeper and auditor. The web client uses it with
`?perprogram=nomad`, the default in the staging web build.

## How the container reaches D1

The container holds no database credential. It sends each query as HTTP to `http://d1.per/query`, and the Worker answers
that host itself through an outbound handler on the `PerService` Container class (`src/bridge.ts`).

`container/src/db.ts` keeps the node-postgres interface the service was written against (`pool.query(sql, params)`):
- it translates the Postgres-only SQL the service uses: `now()`, intervals, casts, `greatest`, `->>`, `$n`;
- it returns the same types: bigint columns as strings, booleans, Dates, parsed JSON and Buffers;
- it sends integer strings as numbers, because SQLite compares text above numbers.

Two statements were rewritten by hand: the rollback move and `stddev_samp`. `container/test/db.test.ts` prepares every
query the service sends against the schema.

The database lives in the container's region (ENAM, next to `ORD`). Every keeper query crosses this hop. From APAC each
query took about 220 ms, which was slow enough for the keeper to miss a hand log. `GET /audit/where` (admin token) shows
the container's colo and one query's time.

## Commands (in this folder)

```bash
npm test                      # Worker (lobby, bridge) + container (D1 port, Agent bot, brain)
npm run deploy:staging        # D1 migrations, Worker build, deploy (cf builds and pushes the image: Docker must run)
npx tsx scripts/local.ts      # the container's code on this machine with a local D1 (real devnet + rollup), port 8091
```

The stage's devnet RPC (Alchemy) has no `signatureSubscribe`, so `src/chain.ts` makes the Solana connection confirm by
polling. Check it with `node --import tsx container/test/l1-confirm.devnet.ts`.

`.secrets.staging.json` (git-ignored) holds `KEEPER_SECRET_KEY` and `AUDITOR_SECRET_KEY` as JSON byte arrays, plus
`ARCHIVE_KEY_HEX`, `ADMIN_TOKEN` and `SOLANA_RPC_URL` (a provider's devnet URL: public devnet refuses Cloudflare). The
Worker hands them to the container when it starts it.

After a deploy that changes the image, the running container is replaced by a rollout, not immediately: check
`/health`'s `keeper.startedAt`.

Exit gate: `Poker/per/tests/keeper.devnet.ts` (27 checks) with `BACKEND_URL` set to this service, a key folder whose
`keeper.json` is the v4 keeper and whose `m7-admin-token.txt` is the admin token, and the Poker repo's IDL temporarily set
to the v4 program. Results: `results/`.
