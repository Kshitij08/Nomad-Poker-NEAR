import express from "express";
import { createAuthRouter } from "../auth/routes.js";
import { createPool } from "../db/pool.js";
import {
  DEFAULT_DEVNET_RPC,
  DEFAULT_PROGRAM_ID,
  programId,
  settlementAuthorityPublicKey,
} from "../config/solana.js";

export function createApiRouter() {
  const router = express.Router();
  const pool = createPool();

  router.use(createAuthRouter(pool));

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
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
