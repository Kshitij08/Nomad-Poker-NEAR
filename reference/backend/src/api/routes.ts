import express from "express";
import { createAuthRouter } from "../auth/routes.js";
import { hasJwtSecretConfigured, verifyPlayerToken } from "../auth/jwt.js";
import { createPool } from "../db/pool.js";
import {
  DEFAULT_DEVNET_RPC,
  DEFAULT_PROGRAM_ID,
  programId,
  settlementAuthorityPublicKey,
} from "../config/solana.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  getParty,
  isPartySessionName,
  isTrackedSessionName,
  requestOverflow,
  startParty,
  toPublic,
} from "../services/partySessions.js";

export function createApiRouter() {
  const router = express.Router();
  const pool = createPool();

  router.use(createAuthRouter(pool));

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const partyLimit = rateLimit({ windowMs: 60_000, max: 8 });

  /** Queue a generated Party Create code for the VPS dedicated process to host. */
  router.post("/party/start", partyLimit, async (req, res) => {
    const session = String(req.body?.session ?? "");
    const money = Boolean(req.body?.money);
    if (!isPartySessionName(session)) {
      res.status(400).json({ error: "Invalid party session code" });
      return;
    }

    let creatorPubkey: string | undefined;
    if (money) {
      if (!hasJwtSecretConfigured()) {
        res.status(503).json({ error: "Auth not configured (JWT_SECRET missing)" });
        return;
      }
      const header = req.header("authorization")?.trim();
      if (!header?.toLowerCase().startsWith("bearer ")) {
        res.status(401).json({ error: "Wallet login required to create a money table" });
        return;
      }
      try {
        const payload = await verifyPlayerToken(header.slice(7).trim());
        creatorPubkey = payload.sub;
      } catch {
        res.status(401).json({ error: "Unauthorized — invalid or expired token" });
        return;
      }
    }

    try {
      const room = startParty(session, money ? "chain" : "free", creatorPubkey);
      res.json(toPublic(room));
    } catch (err: any) {
      const status = Number(err?.status) || 400;
      res.status(status).json({ error: err.message ?? String(err) });
    }
  });

  router.get("/party/status", (req, res) => {
    const session = String(req.query.session ?? "");
    if (!isTrackedSessionName(session)) {
      res.status(400).json({ error: "Invalid party session code" });
      return;
    }
    const room = getParty(session);
    if (!room) {
      res.status(404).json({ error: "Unknown party session" });
      return;
    }
    res.json(toPublic(room));
  });

  /**
   * Quick Play overflow: when the primary dedicated table is full, queue the next
   * pool (`poker-free-2`, `poker-money-3`, …) on the VPS. Pass `fullSession` when
   * a join just failed so that table is not handed out again.
   */
  router.post("/quickplay/overflow", partyLimit, async (req, res) => {
    const money = Boolean(req.body?.money);
    const fullSession =
      typeof req.body?.fullSession === "string" ? req.body.fullSession.trim() : "";

    if (money) {
      if (!hasJwtSecretConfigured()) {
        res.status(503).json({ error: "Auth not configured (JWT_SECRET missing)" });
        return;
      }
      const header = req.header("authorization")?.trim();
      if (!header?.toLowerCase().startsWith("bearer ")) {
        res.status(401).json({ error: "Wallet login required to join a money table" });
        return;
      }
      try {
        await verifyPlayerToken(header.slice(7).trim());
      } catch {
        res.status(401).json({ error: "Unauthorized — invalid or expired token" });
        return;
      }
    }

    try {
      const room = requestOverflow(money ? "chain" : "free", fullSession || undefined, Number(req.body?.stake) || 0);
      res.json(toPublic(room));
    } catch (err: any) {
      const status = Number(err?.status) || 400;
      res.status(status).json({ error: err.message ?? String(err) });
    }
  });

  /** Chain config for clients creating tables (settlement pubkey must match backend key). */
  router.get("/config", (_req, res) => {
    res.json({
      programId: programId()?.toBase58() ?? DEFAULT_PROGRAM_ID,
      settlementAuthority: settlementAuthorityPublicKey()?.toBase58() ?? null,
      rpcUrl: process.env.SOLANA_RPC_URL ?? DEFAULT_DEVNET_RPC,
    });
  });

  router.get("/tables", async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM tables ORDER BY created_at DESC`);
    res.json(rows);
  });

  router.get("/tables/:tableId/seats", async (req, res) => {
    const { rows } = await pool.query(
      `SELECT * FROM seats WHERE table_id = $1 ORDER BY id`,
      [req.params.tableId]
    );
    res.json(rows);
  });

  router.get("/tables/:tableId/ledger", async (req, res) => {
    const { rows } = await pool.query(
      `SELECT * FROM player_ledger WHERE table_id = $1`,
      [req.params.tableId]
    );
    res.json(rows);
  });

  router.get("/rake/summary", async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT table_id, SUM(rake_lamports) AS total_rake
       FROM rake_events
       GROUP BY table_id`
    );
    res.json(rows);
  });

  return router;
}
