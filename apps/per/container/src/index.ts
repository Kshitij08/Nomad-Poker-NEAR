// poker-per service: lobby index, hand archive, verify API, the keeper, SOL Agents and payouts. It runs as one
// Cloudflare Container behind the PER Worker (apps/per/src/index.ts), which starts a single instance: that is what
// keeps one keeper and one Agent runner (the Railway service needed Postgres advisory locks for it, because a deploy
// briefly ran two copies). Its data is in D1, through the Worker's bridge (db.ts).
import { app } from "./api";
import { config } from "./config";
import { holdLease, migrate } from "./db";
import { randomUUID } from "crypto";
import { keeperState, runKeeper } from "./keeper";
import { stepAgents } from "./agents";
import { stepPayouts } from "./payouts";

async function main() {
  // The D1 bridge may take a moment after a cold start: wait for it rather than crash.
  for (let i = 0; ; i++) {
    try { await migrate(); break; } catch (e: any) {
      if (i >= 30) throw e;
      console.error("d1 bridge not ready:", e?.message ?? e);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  app().listen(config.port, () => console.log(`listening on ${config.port}; keeper ${config.keeper.publicKey.toBase58()}; auditor ${config.auditor.publicKey.toBase58()}`));
  if (!config.keeperEnabled) return;
  // Only the lease holder runs the keeper and the Agents; a new container waits (healthy) until the old one's lapses.
  const me = randomUUID();
  keeperState.standby = true;
  while (!(await holdLease("keeper", me, 30_000).catch(() => false))) await new Promise((r) => setTimeout(r, 5_000));
  setInterval(() => {
    holdLease("keeper", me, 30_000).then((mine) => {
      if (!mine) { console.error("keeper: lost the lease to another instance; exiting"); process.exit(1); }
    }, (e) => console.error("lease renew:", e?.message ?? e));
  }, 10_000).unref();
  console.log("keeper: this instance holds the lease");
  keeperState.standby = false;
  keeperState.startedAt = Date.now();
  runKeeper().catch((e) => { console.error("keeper stopped", e); process.exit(1); });
  // A keeper stuck for 3 minutes (RPC calls time out after 20 s, so this means something worse) exits; the Worker
  // starts the container again on its next request or cron tick.
  setInterval(() => {
    const since = Date.now() - Math.max(keeperState.lastLoopAt, keeperState.startedAt);
    if (since > 180_000) { console.error(`keeper stalled for ${Math.round(since / 1000)} s; exiting`); process.exit(1); }
  }, 30_000).unref();
  // M12: the Agent runner, one step per running Agent every 1.5 s (each waits for its previous step), then payouts.
  let agentsBusy = false;
  setInterval(() => {
    if (agentsBusy) return;
    agentsBusy = true;
    (async () => {
      await stepAgents();
      await stepPayouts().catch((e) => console.error("payouts:", e?.message ?? e));
    })().catch((e) => console.error("agents:", e?.message ?? e)).finally(() => { agentsBusy = false; });
  }, 1_500).unref();
}

main().catch((e) => { console.error(e); process.exit(1); });
