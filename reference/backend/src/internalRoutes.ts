import { Router } from "express";
import {
  beginRound,
  cashOutPlayer,
  closeTable,
  createTable,
  settleRound,
} from "./services/settlement.js";
import { endHand, startHand } from "./services/gameHand.js";

export function createInternalRouter(): Router {
  const router = Router();

  router.post("/table/create", async (req, res) => {
    try {
      const result = await createTable(req.body);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  router.post("/table/close", async (req, res) => {
    try {
      const sig = await closeTable(req.body);
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  router.post("/begin-round", async (req, res) => {
    try {
      const sig = await beginRound(req.body);
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  router.post("/settle", async (req, res) => {
    try {
      const sig = await settleRound(req.body);
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  router.post("/cash-out", async (req, res) => {
    try {
      const sig = await cashOutPlayer(req.body);
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  /** Game server: lock table before a hand (on-chain begin_round). */
  router.post("/hand/start", async (req, res) => {
    try {
      const sig = await startHand(req.body);
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  /** Game server: settle chip deltas after a hand (on-chain settle_round). */
  router.post("/hand/end", async (req, res) => {
    try {
      const sig = await endHand(req.body);
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  return router;
}
