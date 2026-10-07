// HTTP API. Public routes serve only public data: the lobby, finished hands' public records and
// their verification. Action logs (they hold the bets) leave the archive only through the audit
// routes, behind the admin token. No route signs anything, so none can move funds or play.
import express, { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config";
import { pool } from "./db";
import { open } from "./archive";
import { keeperState, recordFromJson } from "./keeper";
import { l1, teePublic } from "./chain";
import { verify, verifyLog, HandLogFile } from "./shared/verifier";

/** Fixed-window rate limit per client IP. */
function rateLimit(perMinute: number) {
  const hits = new Map<string, { n: number; at: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? "?";
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.at > 60_000) hits.set(ip, { n: 1, at: now });
    else if (++h.n > perMinute) { res.set("Retry-After", "60").status(429).json({ error: "rate limited" }); return; }
    if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.at > 60_000) hits.delete(k);
    next();
  };
}

function adminOnly(req: Request, res: Response, next: NextFunction) {
  const given = Buffer.from((req.get("authorization") ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(config.adminToken);
  if (given.length !== want.length || !timingSafeEqual(given, want)) { res.status(401).json({ error: "unauthorized" }); return; }
  next();
}

const isAddress = (s: string) => { try { return new PublicKey(s).toBase58() === s; } catch { return false; } };
const isHandNo = (s: string) => /^[0-9]{1,19}$/.test(s);
const tableRow = (r: any) => ({ address: r.address, tableId: r.table_id, creator: r.creator, open: r.status === 1, maxSeats: r.max_seats, seated: r.seated,
  live: r.status === 1 && r.delegated, inviteOnly: r.invite_only, smallBlind: r.small_blind, bigBlind: r.big_blind, minBuyIn: r.min_buy_in, maxBuyIn: r.max_buy_in, handNo: r.hand_no, updatedAt: r.updated_at });
const handRow = (r: any) => ({ handNo: r.hand_no, record: r.record, verified: r.verified, problems: r.problems, log: { status: r.log_status, verified: r.log_verified }, archivedAt: r.archived_at });

export function app() {
  const a = express();
  a.disable("x-powered-by");
  a.set("trust proxy", 1);
  a.use(express.json({ limit: "64kb" }));
  a.use(rateLimit(Number(process.env.RATE_PER_MINUTE ?? 120)));

  a.get("/health", async (_req, res) => {
    const out: any = { ok: true, keeper: { ...keeperState, enabled: config.keeperEnabled, address: config.keeper.publicKey.toBase58() }, auditor: config.auditor.publicKey.toBase58() };
    try { await pool.query("select 1"); out.db = "ok"; } catch (e) { out.ok = false; out.db = "down"; }
    try { out.l1Slot = await l1.getSlot(); } catch { out.ok = false; out.l1Slot = null; }
    try { out.rollupSlot = await teePublic.getSlot(); } catch { out.ok = false; out.rollupSlot = null; }
    if (config.keeperEnabled && Date.now() - keeperState.lastLoopAt > 60_000 && Date.now() - keeperState.startedAt > 60_000) out.ok = false;
    res.status(out.ok ? 200 : 503).json(out);
  });

  a.get("/tables", async (_req, res) => {
    const r = await pool.query("select * from tables where status = 1 and delegated order by updated_at desc limit 200");
    res.json(r.rows.map(tableRow));
  });

  a.get("/tables/:table", async (req, res) => {
    if (!isAddress(req.params.table)) { res.status(400).json({ error: "bad table address" }); return; }
    const r = await pool.query("select * from tables where address = $1", [req.params.table]);
    if (!r.rowCount) { res.status(404).json({ error: "unknown table" }); return; }
    res.json(tableRow(r.rows[0]));
  });

  a.get("/tables/:table/hands", async (req, res) => {
    if (!isAddress(req.params.table)) { res.status(400).json({ error: "bad table address" }); return; }
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const before = typeof req.query.before === "string" && isHandNo(req.query.before) ? req.query.before : null;
    const r = await pool.query(
      `select table_address, hand_no, record, verified, problems, log_status, log_verified, archived_at from hands
       where table_address = $1 and ($2::bigint is null or hand_no < $2::bigint) order by hand_no desc limit $3`, [req.params.table, before, limit]);
    res.json(r.rows.map(handRow));
  });

  a.get("/tables/:table/hands/:hand", async (req, res) => {
    if (!isAddress(req.params.table) || !isHandNo(req.params.hand)) { res.status(400).json({ error: "bad table or hand" }); return; }
    const r = await pool.query("select table_address, hand_no, record, verified, problems, log_status, log_verified, archived_at from hands where table_address = $1 and hand_no = $2",
      [req.params.table, req.params.hand]);
    if (!r.rowCount) { res.status(404).json({ error: "unknown hand" }); return; }
    // Recomputed on every request, so the answer doesn't depend on what was stored at archive time.
    const prev = await pool.query("select record from hands where table_address = $1 and hand_no = $2", [req.params.table, (BigInt(req.params.hand) - 1n).toString()]);
    const v = verify(recordFromJson(r.rows[0].record), undefined, prev.rowCount ? prev.rows[0].record.button : undefined);
    res.json({ ...handRow(r.rows[0]), recomputed: { ok: v.ok, problems: v.problems, deck: v.deck } });
  });

  /** A player checks the log their client downloaded against the archived public record. */
  a.post("/verify", async (req, res) => {
    const { table, handNo, log } = req.body ?? {};
    if (typeof table !== "string" || !isAddress(table) || typeof handNo !== "string" || !isHandNo(handNo) || !log || !Array.isArray(log.entries) || log.entries.length > 4096) {
      res.status(400).json({ error: "expected { table, handNo, log: { table, handNo, secret, len, entries } }" }); return;
    }
    const r = await pool.query("select record from hands where table_address = $1 and hand_no = $2", [table, handNo]);
    if (!r.rowCount) { res.status(404).json({ error: "unknown hand" }); return; }
    try { res.json(verifyLog(recordFromJson(r.rows[0].record), log as HandLogFile)); }
    catch { res.status(400).json({ error: "malformed log" }); }
  });

  a.get("/audit/tables/:table/hands/:hand/log", adminOnly, async (req, res) => {
    const table = String(req.params.table), hand = String(req.params.hand);
    if (!isAddress(table) || !isHandNo(hand)) { res.status(400).json({ error: "bad table or hand" }); return; }
    const r = await pool.query("select log_status, log_enc from hands where table_address = $1 and hand_no = $2", [table, hand]);
    if (!r.rowCount || !r.rows[0].log_enc) { res.status(404).json({ error: "no archived log", status: r.rows[0]?.log_status ?? null }); return; }
    res.json(open(table, hand, r.rows[0].log_enc));
  });

  a.get("/audit/events", adminOnly, async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);
    res.json((await pool.query("select * from keeper_events order by id desc limit $1", [limit])).rows);
  });

  a.use((_req, res) => res.status(404).json({ error: "not found" }));
  // Client errors raised by Express itself (invalid JSON 400, body too large 413) keep their status;
  // anything else is a 500 without details.
  a.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const client = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;
    res.status(client ? err.status : 500).json({ error: client ? "bad request" : "internal error" });
  });
  return a;
}
