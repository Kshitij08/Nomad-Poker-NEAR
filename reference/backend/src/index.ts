import express from "express";
import "dotenv/config";
import { createApiRouter } from "./api/routes.js";
import { createConnection, hasSettlementKeypair } from "./config/solana.js";
import { createInternalRouter } from "./internalRoutes.js";
import { requireInternalApiKey, warnIfInternalApiKeyMissing } from "./middleware/internalAuth.js";
import { startIndexer } from "./services/indexer.js";

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

const port = Number(process.env.PORT ?? 8787);

async function main() {
  warnIfInternalApiKeyMissing();

  const connection = createConnection();
  await startIndexer(connection);

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
