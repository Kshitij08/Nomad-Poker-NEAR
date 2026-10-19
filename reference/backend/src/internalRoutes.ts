import { Router } from "express";
import type { Pool } from "pg";
import { createPool } from "./db/pool.js";
import type { StrategyService } from "./strategies/service.js";
import {
  beginRound,
  cashOutPlayer,
  closeTable,
  createTable,
  settleRound,
} from "./services/settlement.js";
import { endHand, startHand } from "./services/gameHand.js";
import {
  claimNext,
  markReady,
  toPublic,
} from "./services/partySessions.js";
import {
  AgentDeploymentService,
  type AgentPhase,
} from "./services/agentDeployments.js";
import { parseReplay, REPLAY_MAX_BYTES } from "./services/agentReplay.js";

export function createInternalRouter(providedPool?: Pool, strategies?: StrategyService): Router {
  const router = Router();
  const agents = new AgentDeploymentService(providedPool ?? createPool());

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

  /** Normal Quick Play host: atomically claim the oldest queued agent at this stake. */
  router.get("/agent/claim", async (req, res) => {
    const table = String(req.query.table ?? "").trim();
    const stake = Number(req.query.stake);
    if (!table || !Number.isFinite(stake) || stake <= 0) {
      res.status(400).json({ error: "table and positive stake required" });
      return;
    }
    try {
      const deployment = await agents.claim(table, Math.trunc(stake));
      res.json(
        deployment
          ? { ...deployment, found: true, status: "claimed", kind: "agent" }
          : { found: false, session: "", deploymentId: "", DeploymentId: "", phase: "", status: "", kind: "agent" }
      );
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
    }
  });

  router.post("/agent/release", async (req, res) => {
    const session = String(req.body?.session ?? "");
    const table = String(req.body?.table ?? "").trim();
    if (!session || !table) {
      res.status(400).json({ error: "session and table required" });
      return;
    }
    try {
      res.json({ released: Boolean(await agents.releaseClaim(session, table)) });
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
    }
  });

  /** Public Quick Play server: publish hands played and current stack for the owner. */
  router.post("/agent/progress", async (req, res) => {
    const session = String(req.body?.session ?? "");
    if (!session) {
      res.status(400).json({ error: "session required" });
      return;
    }
    try {
      res.json(
        await agents.updateProgress(session, {
          handsPlayed: optionalNumber(req.body?.HandsPlayed ?? req.body?.handsPlayed),
          stack: optionalNumber(req.body?.Stack ?? req.body?.stack),
          netPnl: optionalNumber(req.body?.NetPnl ?? req.body?.netPnl),
          runtimeSeconds: optionalNumber(
            req.body?.RuntimeSeconds ?? req.body?.runtimeSeconds
          ),
          wins: optionalNumber(req.body?.Wins ?? req.body?.wins),
          losses: optionalNumber(req.body?.Losses ?? req.body?.losses),
          showdowns: optionalNumber(req.body?.Showdowns ?? req.body?.showdowns),
          phase: optionalPhase(req.body?.phase),
          assignedTable: optionalString(req.body?.AssignedTable ?? req.body?.assignedTable),
        })
      );
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
    }
  });

  /** Public Quick Play server: whether the owner has asked this deployment to stop. */
  router.get("/agent/control", async (req, res) => {
    const session = String(req.query.session ?? "");
    if (!session) {
      res.status(400).json({ error: "session required" });
      return;
    }
    try {
      res.json(await agents.control(session, optionalString(req.query.table)));
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
    }
  });

  /** Quick table: idempotently store one completed hand and refresh aggregates. */
  router.post("/agent/hand", async (req, res) => {
    const session = String(
      req.body?.session ?? req.body?.DeploymentId ?? req.body?.deploymentId ?? ""
    );
    const handNumber = Number(req.body?.HandNumber ?? req.body?.handNumber);
    if (!session || !Number.isInteger(handNumber) || handNumber <= 0) {
      res.status(400).json({ error: "session and positive handNumber required" });
      return;
    }
    // Too large / not an object: the hand is still stored, without its replay (see agentReplay.ts for why).
    const replay = parseReplay(req.body?.ReplayJson ?? req.body?.replayJson ?? req.body?.Replay ?? req.body?.replay);
    if (replay.dropped) {
      console.warn(
        `[agent] hand ${handNumber} of ${session}: replay dropped (${replay.dropped}; cap ${REPLAY_MAX_BYTES} bytes)`
      );
    }
    try {
      const saved = await agents.upsertHand(session, {
          handNumber,
          startStack: requiredNumber(
            req.body?.StartingStack ?? req.body?.StartStack ?? req.body?.startStack
          ),
          endStack: requiredNumber(
            req.body?.EndingStack ?? req.body?.EndStack ?? req.body?.endStack
          ),
          netPnl: requiredNumber(req.body?.NetPnl ?? req.body?.netPnl),
          holeCards: req.body?.HoleCards ?? req.body?.holeCards ?? [],
          boardCards: req.body?.BoardCards ?? req.body?.boardCards ?? [],
          pot: requiredNumber(req.body?.Pot ?? req.body?.pot),
          result: String(req.body?.Result ?? req.body?.result ?? ""),
          showdown: Boolean(req.body?.Showdown ?? req.body?.showdown),
          publicActions:
            parseJsonArray(req.body?.PublicActionsJson) ??
            req.body?.PublicActions ??
            req.body?.publicActions ??
            [],
          completedAt: optionalDate(req.body?.CompletedUnix ?? req.body?.completedUnix),
          replay: replay.replay,
        }, optionalString(req.body?.AssignedTable ?? req.body?.assignedTable));
      res.json({ ...saved, ReplayStored: replay.replay != null, ReplayDropped: replay.dropped ?? "" });
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
    }
  });

  /** Public Quick Play server: publish deployment return summary for the owner client. */
  router.post("/agent/complete", async (req, res) => {
    const session = String(req.body?.session ?? "");
    if (!session) {
      res.status(400).json({ error: "session required" });
      return;
    }
    try {
      const result = await agents.complete(session, req.body ?? {});
      // Copied strategy: settle the profit share now (idempotent; a failure here is retried by the next result read).
      const copyFee = strategies ? await strategies.settle(session).catch((e) => { console.warn("[strategies] settle failed:", e?.message ?? e); return null; }) : null;
      res.json({ ...result, ok: true, CopyFee: copyFee });
    } catch (err: any) {
      res.status(Number(err?.status) || 400).json({ error: err.message ?? String(err) });
    }
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

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw Object.assign(new Error("Invalid numeric hand field"), { status: 400 });
  }
  return parsed;
}

function optionalDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  const date = Number.isFinite(parsed)
    ? new Date(parsed > 10_000_000_000 ? parsed : parsed * 1000)
    : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw Object.assign(new Error("Invalid completed timestamp"), { status: 400 });
  }
  return date;
}

function optionalPhase(value: unknown): AgentPhase | undefined {
  const phase = String(value ?? "");
  if (
    phase === "queued" ||
    phase === "seated" ||
    phase === "playing" ||
    phase === "stop_requested" ||
    phase === "settling" ||
    phase === "completed" ||
    phase === "failed"
  ) {
    return phase;
  }
  return undefined;
}

function parseJsonArray(value: unknown): unknown[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
