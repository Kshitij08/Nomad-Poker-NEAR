import express from "express";
import "./config/env.js";
import { createApiRouter } from "./api/routes.js";
import { createConnection, hasSettlementKeypair } from "./config/solana.js";
import { createInternalRouter } from "./internalRoutes.js";
import { createHostRouter } from "./hostRoutes.js";
import { hasJwtSecretConfigured } from "./auth/jwt.js";
import { requireInternalApiKey, requireInternalApiKeyConfigured } from "./middleware/internalAuth.js";
import { requirePlayerJwt } from "./middleware/playerAuth.js";
import { createPool } from "./db/pool.js";
import { startIndexer } from "./services/indexer.js";
import { createPlayFabFromEnv } from "./services/playfab.js";
import { TournamentService } from "./tournaments/service.js";
import { createTournamentApiRouter, createTournamentInternalRouter } from "./tournaments/routes.js";
import { StrategyService } from "./strategies/service.js";
import { createStrategyApiRouter, createStrategyInternalRouter } from "./strategies/routes.js";

const app = express();
const pool = createPool();
const playfab = createPlayFabFromEnv();
const tournaments = new TournamentService(pool, playfab);
const strategies = new StrategyService(pool, playfab);
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json());
app.use("/api", createApiRouter(pool, strategies));
app.use("/api", createTournamentApiRouter(tournaments));
app.use("/api", createStrategyApiRouter(strategies));
app.use("/internal/tournaments", requireInternalApiKey, createTournamentInternalRouter(tournaments));
app.use("/internal", requireInternalApiKey, createStrategyInternalRouter(strategies));
app.use("/internal", requireInternalApiKey, createInternalRouter(pool, strategies));
app.use("/host", requirePlayerJwt, createHostRouter(pool));

const port = Number(process.env.PORT ?? 8787);

async function main() {
  requireInternalApiKeyConfigured();

  if (!hasJwtSecretConfigured()) {
    console.warn(
      "[backend] JWT_SECRET is not set (or too short) — /api/auth/* and /api/me will return 503."
    );
  }

  // Tournaments: lock at the start time, spawn servers, retry money. TOURNAMENTS_SCHEDULER=0 turns it off
  // (e.g. a second replica — the scheduler must run in exactly one process).
  if (process.env.TOURNAMENTS_SCHEDULER !== "0") {
    tournaments.startScheduler();
    if (!process.env.PLAYFAB_SECRET_KEY && process.env.PLAYFAB_FAKE !== "1") {
      console.warn(
        "[backend] PLAYFAB_TITLE_ID / PLAYFAB_SECRET_KEY not set — tournament sign-in returns 503 and " +
          "entry fees, refunds and prizes wait until they are."
      );
    }
  }

  // Copy-strategy creator payouts that PlayFab couldn't take yet (busy, or the creator not seen since publishing).
  setInterval(() => {
    strategies.retryPayouts().catch((err) => console.warn("[strategies] payout retry failed:", err.message ?? err));
  }, 5 * 60_000).unref();

  const connection = createConnection();
  await startIndexer(connection);

  // Server-side recovery for dead money tables (crashed hosts): cash every seat out and close.
  // Opt-out by setting SWEEP_INTERVAL_SECS=0; also runnable on demand via `npm run sweep:stale`.
  const sweepIntervalSecs = Number(process.env.SWEEP_INTERVAL_SECS ?? 600);
  if (sweepIntervalSecs > 0 && hasSettlementKeypair()) {
    const { sweepStaleTables } = await import("./services/staleSweeper.js");
    setInterval(() => {
      sweepStaleTables().catch((err) => console.warn("[sweep] run failed:", err.message ?? err));
    }, sweepIntervalSecs * 1000);
  }

  if (!hasSettlementKeypair()) {
    console.warn(
      "[backend] SETTLEMENT_AUTHORITY_SECRET not set — API and indexer run, " +
        "but /internal/* settlement routes will fail until configured."
    );
  }

  app.listen(port, "0.0.0.0", () => console.log(`[backend] listening on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
