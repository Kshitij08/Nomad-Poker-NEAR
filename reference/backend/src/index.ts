import express from "express";
import "dotenv/config";
import { createApiRouter } from "./api/routes.js";
import { createConnection, hasSettlementKeypair } from "./config/solana.js";
import { startIndexer } from "./services/indexer.js";
import { cashOutDisconnectedPlayer, settleRound } from "./services/settlement.js";

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json());
app.use("/api", createApiRouter());

app.post("/internal/settle", async (req, res) => {
  try {
    const sig = await settleRound(req.body);
    res.json({ signature: sig });
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? String(err) });
  }
});

app.post("/internal/cash-out", async (req, res) => {
  try {
    const sig = await cashOutDisconnectedPlayer(req.body);
    res.json({ signature: sig });
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? String(err) });
  }
});

const port = Number(process.env.PORT ?? 8787);

async function main() {
  const connection = createConnection();
  await startIndexer(connection);

  if (!hasSettlementKeypair()) {
    console.warn(
      "[backend] SETTLEMENT_AUTHORITY_SECRET not set — API and indexer run, " +
        "but /internal/settle and /internal/cash-out will fail until configured."
    );
  }

  app.listen(port, "0.0.0.0", () => console.log(`[backend] listening on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
