import { Router, type Response } from "express";
import { hasJwtSecretConfigured, signPlayFabToken } from "../auth/jwt.js";
import { optionalPlayFabJwt, requirePlayFabJwt, type PlayFabRequest } from "../middleware/playFabAuth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { TournamentError, type TournamentService } from "./service.js";

/**
 * Player-facing tournament routes, mounted under /api. Every write is a POST (CORS here allows
 * GET/POST/PUT) and every response is a JSON object, never a bare array, so Unity's JsonUtility reads it.
 */
export function createTournamentApiRouter(service: TournamentService): Router {
  const router = Router();
  const writes = rateLimit({ windowMs: 60_000, max: 30 });

  /** Swap a PlayFab session ticket for a 1-hour backend token. */
  router.post("/auth/playfab", writes, async (req, res) => {
    await handle(res, async () => {
      if (!hasJwtSecretConfigured()) throw new TournamentError(503, "unavailable", "Sign-in isn't configured.");
      const who = await service.authenticate(String(req.body?.sessionTicket ?? ""));
      return { token: await signPlayFabToken(who.playFabId), playFabId: who.playFabId, displayName: who.displayName, expiresIn: 3600 };
    });
  });

  router.get("/tournaments", async (req, res) => {
    await handle(res, () => service.list(String(req.query.filter ?? "upcoming"), Number(req.query.limit ?? 50)));
  });

  router.get("/tournaments/code/:code", optionalPlayFabJwt, async (req: PlayFabRequest, res) => {
    await handle(res, () => service.getByCode(req.params.code, viewer(req)));
  });

  router.get("/tournaments/:id", optionalPlayFabJwt, async (req: PlayFabRequest, res) => {
    await handle(res, () => service.get(req.params.id, viewer(req)));
  });

  router.get("/me/tournaments", requirePlayFabJwt, async (req: PlayFabRequest, res) => {
    await handle(res, () => service.mine(viewer(req)!));
  });

  router.post("/tournaments", writes, requirePlayFabJwt, async (req: PlayFabRequest, res) => {
    await handle(res, () => service.create(viewer(req)!, req.body));
  });

  const action = (path: string, run: (req: PlayFabRequest) => Promise<unknown>) =>
    router.post(`/tournaments/:id/${path}`, writes, requirePlayFabJwt, async (req: PlayFabRequest, res) => {
      await handle(res, () => run(req));
    });

  action("edit", (req) => service.edit(viewer(req)!, req.params.id, req.body));
  action("raise-prize", (req) => service.raisePrize(viewer(req)!, req.params.id, req.body?.amount));
  action("cancel", (req) => service.cancel(viewer(req)!, req.params.id));
  action("remove", (req) => service.remove(viewer(req)!, req.params.id, String(req.body?.playFabId ?? "")));
  action("register", (req) => service.register(viewer(req)!, req.params.id));
  action("unregister", (req) => service.unregister(viewer(req)!, req.params.id));

  return router;
}

/** Routes for the tournament server process, mounted under /internal/tournaments (internal API key). */
export function createTournamentInternalRouter(service: TournamentService): Router {
  const router = Router();

  router.post("/claim-spawn", async (_req, res) => {
    await handle(res, () => service.claimSpawn());
  });

  router.post("/:id/ready", async (req, res) => {
    await handle(res, () => service.ready(req.params.id, req.body?.ok !== false, String(req.body?.error ?? "")));
  });

  router.get("/:id", async (req, res) => {
    await handle(res, () => service.roster(req.params.id));
  });

  router.post("/:id/verify", async (req, res) => {
    await handle(res, () => service.verify(req.params.id, String(req.body?.sessionTicket ?? "")));
  });

  router.post("/:id/started", async (req, res) => {
    await handle(res, () => service.started(req.params.id));
  });

  router.post("/:id/progress", async (req, res) => {
    await handle(res, () => service.progress(req.params.id, Number(req.body?.seq ?? 0), req.body?.snapshot ?? null));
  });

  router.post("/:id/result", async (req, res) => {
    await handle(res, () => service.result(req.params.id, req.body));
  });

  return router;
}

function viewer(req: PlayFabRequest) {
  return req.playFabId ? { playFabId: req.playFabId } : null;
}

async function handle(res: Response, run: () => Promise<unknown>) {
  try {
    res.json(await run());
  } catch (err: any) {
    if (err instanceof TournamentError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    console.error("[tournaments]", err);
    res.status(500).json({ error: "Something went wrong. Try again.", code: "internal" });
  }
}
