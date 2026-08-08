import express from "express";
import "./config/env.js";
import { createApiRouter } from "./api/routes.js";
import { createConnection, hasSettlementKeypair } from "./config/solana.js";
import { createInternalRouter } from "./internalRoutes.js";
import { createHostRouter } from "./hostRoutes.js";
import { hasJwtSecretConfigured } from "./auth/jwt.js";
import { requireInternalApiKey, warnIfInternalApiKeyMissing } from "./middleware/internalAuth.js";
import { requirePlayerJwt } from "./middleware/playerAuth.js";
import { createPool } from "./db/pool.js";
import { startIndexer } from "./services/indexer.js";

const app = express();
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
app.use("/api", createApiRouter());
app.use("/internal", requireInternalApiKey, createInternalRouter());
app.use("/host", requirePlayerJwt, createHostRouter(createPool()));

const port = Number(process.env.PORT ?? 8787);

async function main() {
  warnIfInternalApiKeyMissing();

  if (!hasJwtSecretConfigured()) {
    console.warn(
      "[backend] JWT_SECRET is not set (or too short) — /api/auth/* and /api/me will return 503."
    );
  }

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
