# Launch runbook (draft, 9 Nov 2026)

How the new stack goes live beside the Unity one, and how to back out. Steps marked *rehearsed* were run on staging.
The Unity stack is never touched by any step here until "Switch off Unity", which is a separate decision.

## 1. Production, before anyone plays

1. **Decide the domain** (question in `worklog-phases-6-8.md`), then add it to the production `ALLOWED_ORIGINS` in
   `apps/api/cloudflare.config.ts` and `apps/game-server/cloudflare.config.ts`, and add a `production` stage to
   `apps/web/scripts/stages.mjs` (the CSP is built from it).
2. **Secrets** (never in the repo): `apps/api/.secrets.production.json` with `SPIN_SECRET`;
   `apps/game-server/.secrets.production.json` with `DRAIN_TOKEN`. Fresh random values, not staging's.
3. **Database:** `(cd apps/api && npm run db:migrate:production)` applies every migration to the empty production D1.
4. **Deploy:** `npm run deploy:production` in `apps/api`, then in `apps/game-server` (each checks migrations first).
5. **Admins:** Kshitij is the only admin. Sign in to production with your wallet (or Google, once it is set up), open
   `/admin.html`, and run the command it shows: `node infra/add-admin.mjs production <your player id>`.
6. **Web:** `node apps/web/scripts/deploy-vercel.mjs production` (Vercel project), or a Cloudflare Pages move if decided.
7. **Smoke:** `node apps/api/scripts/smoke.mjs <api> <web>`; one Quick Play hand from the web; `GET /v1/admin/reconcile`.
8. **Watch:** alerts (once set up), `node infra/logs.mjs <worker> "GAVE UP"` and `"[reconcile] PROBLEMS"`.
9. **Backups:** `node infra/backup-d1.mjs production` daily at a quiet hour (an export briefly blocks writes; table
   bookkeeping retries through it).

## 2. Closed beta

- The web app at a beta URL on production Workers; fresh accounts; coins from the starter grant; SOL tables devnet only.
- Gate: the reconciliation stays clean for the whole beta (`GET /v1/admin/reconcile`, hourly in the logs); the load
  test passes at 3× the expected peak (`npx tsx apps/game-server/scripts/load.ts`).

## 3. Launch

- Point the main domain at the new web app. The live Unity app keeps running untouched.

## Backing out

| Problem | Action | Time |
|---|---|---|
| A bad Worker release | `node infra/rollback.mjs <worker> previous` (*rehearsed*: staging API back 8 s, forward 5 s). Game server: drain first. | seconds |
| Bad data written (a bug, a bad admin action) | `cf d1 time-travel get-bookmark <db>` (note it), then `cf d1 time-travel restore <db> --timestamp <before the problem> --force` (*rehearsed*: staging restored in 2 s, marker row gone, books clean). The restore prints the previous bookmark, so it can itself be undone. Anything written after that moment is lost: prefer fixing forward for a small error (an admin adjustment). | seconds |
| A table's books off (drift) | `GET /v1/admin/reconcile` names it; `node infra/table-from-r2.mjs <stage> <room> <table>` recomputes it from the R2 hand records (`--fix` writes it back) (*used* after the load test). | minutes |
| The whole launch | Point the domain back at the old site. Until Unity is switched off, nothing else is needed. | minutes |

## 4. Switch off Unity (your call, later)

1. Disable Unity sign-in and new Photon tables; let open tables finish.
2. **Cash out every escrow and PER table on the live stack first** — they hold real wallet funds.
3. Shut down the Railway services, the Photon app and the PlayFab title (nothing to export); archive the old repo.
