import { Router, type Response } from "express";
import { optionalPlayFabJwt, requirePlayFabJwt, type PlayFabRequest } from "../middleware/playFabAuth.js";
import { StrategyError, type StrategyService } from "./service.js";

function fail(res: Response, err: any) {
  if (err instanceof StrategyError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  console.error("[strategies]", err);
  res.status(500).json({ error: "Something went wrong. Try again." });
}

/** Players: marketplace (browse, publish, dashboard), My Twin and coaching. */
export function createStrategyApiRouter(svc: StrategyService): Router {
  const r = Router();
  r.get("/strategies", optionalPlayFabJwt, async (req, res) => {
    try { res.json({ strategies: await svc.list(String(req.query.sort ?? "top"), Number(req.query.limit) || 30) }); } catch (e) { fail(res, e); }
  });
  r.get("/strategies/mine", requirePlayFabJwt, async (req: PlayFabRequest, res) => {
    try { res.json(await svc.creatorDashboard(req.playFabId!)); } catch (e) { fail(res, e); }
  });
  r.get("/strategies/:id", optionalPlayFabJwt, async (req, res) => {
    try { res.json(await svc.get(String(req.params.id))); } catch (e) { fail(res, e); }
  });
  r.post("/strategies", requirePlayFabJwt, async (req: PlayFabRequest, res) => {
    try { res.json(await svc.publish(req.playFabId!, req.body)); } catch (e) { fail(res, e); }
  });
  r.post("/strategies/:id/unlist", requirePlayFabJwt, async (req: PlayFabRequest, res) => {
    try { await svc.unlist(req.playFabId!, String(req.params.id)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  r.get("/style/twin", requirePlayFabJwt, async (req: PlayFabRequest, res) => {
    try { res.json(await svc.twin(req.playFabId!)); } catch (e) { fail(res, e); }
  });
  r.get("/style/coach", requirePlayFabJwt, async (req: PlayFabRequest, res) => {
    try { res.json(await svc.coach(req.playFabId!)); } catch (e) { fail(res, e); }
  });
  return r;
}

/** Game servers (internal API key): what players did at Coins tables. */
export function createStrategyInternalRouter(svc: StrategyService): Router {
  const r = Router();
  r.post("/style/decisions", async (req, res) => {
    try { res.json({ recorded: await svc.recordDecisions(Array.isArray(req.body?.decisions) ? req.body.decisions : []) }); } catch (e) { fail(res, e); }
  });
  r.post("/style/hands", async (req, res) => {
    try { res.json({ recorded: await svc.recordHands(Array.isArray(req.body?.hands) ? req.body.hands : []) }); } catch (e) { fail(res, e); }
  });
  return r;
}
