import { Router } from "express";
import {
  beginRound,
  cashOutPlayer,
  closeTable,
  createTable,
  settleRound,
} from "./services/settlement.js";
import { endHand, startHand } from "./services/gameHand.js";
import { claimNext, markReady, toPublic } from "./services/partySessions.js";

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

  /** Dedicated VPS: claim the next Party Create / overflow code for this lobby. */
  router.get("/party/pending", (req, res) => {
    const mode = String(req.query.mode ?? "");
    if (mode !== "free" && mode !== "chain") {
      res.status(400).json({ error: "mode must be free or chain" });
      return;
    }
    const room = claimNext(mode);
    res.json(room ? toPublic(room) : { session: "", status: "", mode: "", error: "" });
  });

  /** Dedicated child: Photon session is up (or failed to start). */
  router.post("/party/ready", (req, res) => {
    const session = String(req.body?.session ?? "");
    const ok = Boolean(req.body?.ok);
    const error = typeof req.body?.error === "string" ? req.body.error : undefined;
    const room = markReady(session, ok, error);
    if (!room) {
      res.status(404).json({ error: "Unknown party session" });
      return;
    }
    res.json(toPublic(room));
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
