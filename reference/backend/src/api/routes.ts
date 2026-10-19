import express from "express";
import type { Pool } from "pg";
import { createAuthRouter } from "../auth/routes.js";
import { hasJwtSecretConfigured, verifyPlayFabToken, verifyPlayerToken } from "../auth/jwt.js";
import type { StrategyService } from "../strategies/service.js";
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
import { AgentDeploymentService } from "../services/agentDeployments.js";

export function createApiRouter(providedPool?: Pool, strategies?: StrategyService) {
  const router = express.Router();
  const pool = providedPool ?? createPool();
  const agents = new AgentDeploymentService(pool);

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

  /** Queue an agent for a seat on an existing normal Quick Play table. */
  router.post("/agent/start", partyLimit, async (req, res) => {
    const session = String(req.body?.session ?? "");
    if (!isPartySessionName(session)) {
      res.status(400).json({ error: "Invalid agent session code" });
      return;
    }

    try {
      const ownerId = String(req.body?.ownerId ?? "").trim();
      if (!ownerId) {
        res.status(400).json({ error: "ownerId required" });
        return;
      }
      const stake = Math.max(50, Number(req.body?.stake) || 1000);
      const deployment = await agents.enqueue({
        deploymentId: session,
        ownerId,
        agentName: String(req.body?.agentName ?? "Agent"),
        profile: String(req.body?.profile ?? "balanced"),
        strategyVersion: String(req.body?.strategyVersion ?? "v1"),
        strategyConfig: {
          hasCustom: Boolean(req.body?.hasCustom),
          foldBelow: Number(req.body?.foldBelow) || 0,
          raiseAbove: Number(req.body?.raiseAbove) || 0,
          aggression: Number(req.body?.aggression) || 0,
          bluffChance: Number(req.body?.bluffChance) || 0,
          raiseFractionOfPot: Number(req.body?.raiseFractionOfPot) || 0,
          ...agentProfileV2(req.body),
        },
        bankroll: Math.max(stake, Number(req.body?.bankroll) || 5000),
        maxHands: Math.max(1, Math.min(5000, Number(req.body?.maxHands) || 100)),
        maxRuntimeSeconds: Math.max(
          60,
          Math.min(86_400, Number(req.body?.maxRuntime) || 3600)
        ),
        stopLoss: Math.max(0, Number(req.body?.stopLoss) || 0),
        profitTarget: Math.max(0, Number(req.body?.profitTarget) || 0),
        stake,
      });
      // Copying a marketplace strategy: the copier must be the signed-in player (the profit share is theirs to pay).
      const strategyId = optionalString(req.body?.strategyId);
      if (strategyId && strategies) {
        let copier: string;
        try {
          copier = (await verifyPlayFabToken(bearer(req) ?? "")).sub ?? "";
        } catch {
          res.status(401).json({ error: "Sign in to copy a strategy.", code: "sign_in" });
          return;
        }
        if (copier !== ownerId) {
          res.status(403).json({ error: "You can only copy for your own account." });
          return;
        }
        await strategies.attachCopy(session, copier, strategyId);
      }
      // No child room needs to boot; "ready" keeps legacy Unity deploy clients compatible.
      res.json({ ...deployment, status: "ready", kind: "agent", strategyId: strategyId ?? null });
    } catch (err: any) {
      const status = Number(err?.status) || 400;
      res.status(status).json({ error: err.message ?? String(err) });
    }
  });

  /** Owner client: live hands / stack while the agent table is still farming. */
  router.get("/agent/progress", async (req, res) => {
    const session = String(req.query.session ?? "");
    if (!isPartySessionName(session)) {
      res.status(400).json({ error: "Invalid agent session code" });
      return;
    }
    try {
      await agents.assertOwner(session, optionalString(req.query.ownerId));
      const live = await agents.get(session);
      res.json(live ? { ...live, RecentHands: await agents.recentHands(session, 10) } : live);
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
    }
  });

  /** Owner client: ask the farming table to stop after the current hand and return the stack. */
  router.post("/agent/stop", async (req, res) => {
    const session = String(req.body?.session ?? "");
    if (!isPartySessionName(session)) {
      res.status(400).json({ error: "Invalid agent session code" });
      return;
    }
    try {
      res.json(await agents.requestStop(session, optionalString(req.body?.ownerId)));
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
    }
  });

  /** Owner client: fetch AFK agent return summary after deployment ends. */
  router.get("/agent/result", async (req, res) => {
    const session = String(req.query.session ?? "");
    if (!isPartySessionName(session)) {
      res.status(400).json({ error: "Invalid agent session code" });
      return;
    }
    try {
      await agents.assertOwner(session, optionalString(req.query.ownerId));
      const result = await agents.getResult(session);
      if (!result) {
        res.status(404).json({ error: "No result yet" });
        return;
      }
      // A copied strategy's profit share (the client credits the session result minus these).
      if (strategies) await strategies.settle(session).catch(() => null); // settles once; a no-op afterwards
      const copyFee = strategies ? await strategies.feeFor(session) : null;
      res.json({ ...result, CopyFee: copyFee });
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
    }
  });

  router.get("/agent/history", async (req, res) => {
    const ownerId = String(req.query.ownerId ?? "").trim();
    if (!ownerId) {
      res.status(400).json({ error: "ownerId required" });
      return;
    }
    const { limit, offset } = pagination(req.query.limit, req.query.offset);
    try {
      const sessions = await agents.list(ownerId, limit, offset);
      const total = await agents.count(ownerId);
      res.json({ Sessions: sessions, deployments: sessions, Total: total, total, limit, offset });
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
    }
  });

  router.get("/agent/hands", async (req, res) => {
    const ownerId = String(req.query.ownerId ?? "").trim();
    const deploymentId = String(req.query.deploymentId ?? "").trim();
    if (!ownerId || !deploymentId) {
      res.status(400).json({ error: "ownerId and deploymentId required" });
      return;
    }
    const { limit, offset } = pagination(req.query.limit, req.query.offset);
    try {
      const hands = await agents.hands(ownerId, deploymentId, limit, offset);
      const total = await agents.handCount(ownerId, deploymentId);
      res.json({
        Hands: hands,
        hands,
        Total: total,
        total,
        limit,
        offset,
      });
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
    }
  });

  /** One Agent hand with its replay (ReplayJson; empty for hands recorded before replays existed). */
  router.get("/agent/hand", async (req, res) => {
    const ownerId = String(req.query.ownerId ?? "").trim();
    const deploymentId = String(req.query.deploymentId ?? "").trim();
    const handNumber = Number(req.query.handNumber);
    if (!ownerId || !deploymentId || !Number.isInteger(handNumber) || handNumber <= 0) {
      res.status(400).json({ error: "ownerId, deploymentId and a positive handNumber required" });
      return;
    }
    try {
      const hand = await agents.hand(ownerId, deploymentId, handNumber);
      if (!hand) {
        res.status(404).json({ error: "Unknown hand" });
        return;
      }
      res.json({ Hand: hand, hand });
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
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

/**
 * The Agents v2 strategy fields (docs/AGENTS_V2.md), all optional: how much the seat changes play (0..1), the brain
 * (2 = smart), and up to four betting rounds with their own five numbers. Non-numbers become 0; the game server
 * clamps every number to the bot's range (BotProfile.Clamped).
 */
export function agentProfileV2(body: any): { positionWeight: number; brain: number; streets: unknown[] } {
  const finite = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const pw = finite(body?.positionWeight);
  const streets = Array.isArray(body?.streets) ? body.streets.slice(0, 4) : [];
  return {
    positionWeight: Math.max(0, Math.min(1, pw)),
    brain: Number(body?.brain) === 2 ? 2 : 0,
    streets: streets.map((s: any) => ({
      HasValue: Boolean(s?.HasValue),
      FoldBelow: finite(s?.FoldBelow),
      RaiseAbove: finite(s?.RaiseAbove),
      Aggression: finite(s?.Aggression),
      BluffChance: finite(s?.BluffChance),
      RaiseFractionOfPot: finite(s?.RaiseFractionOfPot),
    })),
  };
}

function optionalString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function pagination(rawLimit: unknown, rawOffset: unknown) {
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(rawLimit) || 25)));
  const offset = Math.max(0, Math.trunc(Number(rawOffset) || 0));
  return { limit, offset };
}

function bearer(req: express.Request): string | undefined {
  const header = req.header("authorization")?.trim();
  return header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() || undefined : undefined;
}
