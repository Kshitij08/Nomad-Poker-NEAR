// poker-per backend: lobby index, hand archive, verify API and the keeper. A separate service
// from the existing game backend (its own Railway project and database).
import { app } from "./api";
import { config } from "./config";
import { migrate, pool } from "./db";
import { keeperState, runKeeper } from "./keeper";
import { stepAgents } from "./agents";

async function main() {
  await migrate();
  app().listen(config.port, () => console.log(`listening on ${config.port}; keeper ${config.keeper.publicKey.toBase58()}; auditor ${config.auditor.publicKey.toBase58()}`));
  if (config.keeperEnabled) {
    runKeeper().catch((e) => { console.error("keeper stopped", e); process.exit(1); });
    // A keeper stuck for 3 minutes (RPC calls time out after 20 s, so this means something worse)
    // exits, and Railway restarts the service.
    setInterval(() => {
      const since = Date.now() - Math.max(keeperState.lastLoopAt, keeperState.startedAt);
      if (since > 180_000) { console.error(`keeper stalled for ${Math.round(since / 1000)} s; exiting`); process.exit(1); }
    }, 30_000).unref();
    // M12: the Agent runner, one step per running Agent every 1.5 s (each waits for its previous step).
    // Your playtest: during a deploy the old and new service briefly run together, and both stepped the same Agents
    // (the old one bought back in where the new one had just left). Only the holder of this Postgres lock runs
    // Agents; the old service holds it until it exits.
    let agentsBusy = false;
    let lockClient: import("pg").PoolClient | null = null;
    setInterval(() => {
      if (agentsBusy) return;
      agentsBusy = true;
      (async () => {
        if (!lockClient) {
          const c = await pool.connect();
          const got = (await c.query("select pg_try_advisory_lock(424212) as ok")).rows[0].ok;
          if (!got) { c.release(); return; }
          lockClient = c;
          c.on("error", () => { lockClient = null; }); // a dropped connection drops the lock: take it again
          console.log("agents: this instance runs the Agents");
        }
        await stepAgents();
      })().catch((e) => console.error("agents:", e?.message ?? e)).finally(() => { agentsBusy = false; });
    }, 1_500).unref();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
