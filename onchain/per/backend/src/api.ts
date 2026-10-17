// HTTP API. Public routes serve only public data: the lobby, finished hands' public records and
// their verification. Action logs (they hold the bets) leave the archive only through the audit
// routes, behind the admin token. No route signs anything, so none can move funds or play.
import express, { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config";
import { pool } from "./db";
import { open } from "./archive";
import { keeperState, recordFromJson, redact } from "./keeper";
import { l1, teePublic } from "./chain";
import { verify, verifyLog, HandLogFile } from "./shared/verifier";
import { tourneyList } from "./tourney";
import { agentRoutes, runnerState } from "./agents";

/**
 * Fixed-window rate limit per client: an IPv4 address, or an IPv6 /64 (one subscriber's block, so
 * rotating addresses inside it doesn't help). `req.ip` is the client's address as Railway's
 * proxies saw it (see "trust proxy" below).
 * Expired windows are swept once a minute, and the map is capped.
 */
function rateLimit(perMinute: number) {
  const hits = new Map<string, { n: number; at: number }>();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.at > 60_000) hits.delete(k); }, 60_000).unref();
  const bucket = (ip: string) => (ip.includes(":") && !ip.startsWith("::ffff:") ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip);
  return (req: Request, res: Response, next: NextFunction) => {
    const key = bucket(req.ip ?? "?");
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.at > 60_000) {
      if (!h && hits.size >= 100_000) { res.set("Retry-After", "60").status(429).json({ error: "rate limited" }); return; }
      hits.set(key, { n: 1, at: now });
    } else if (++h.n > perMinute) { res.set("Retry-After", "60").status(429).json({ error: "rate limited" }); return; }
    next();
  };
}

function adminOnly(req: Request, res: Response, next: NextFunction) {
  const header = req.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(config.adminToken);
  if (given.length !== want.length || !timingSafeEqual(given, want)) { res.status(401).json({ error: "unauthorized" }); return; }
  next();
}

const isAddress = (s: string) => { try { return new PublicKey(s).toBase58() === s; } catch { return false; } };
/** Hand numbers are u64 on chain but Postgres bigint is signed: 18 digits always fit. */
const isHandNo = (s: unknown): s is string => typeof s === "string" && /^[0-9]{1,18}$/.test(s);
const limitOf = (v: unknown, dflt: number, max: number) => { const n = Math.trunc(Number(v ?? dflt)); return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : dflt; };

/**
 * A downloaded action log, checked field by field before anything reads it: the verifier must
 * never see an attacker-shaped object (e.g. `secret: {length: 1e9}` made Buffer.from allocate a
 * gigabyte; M7 review).
 */
function isLogFile(l: any, table: string, handNo: string): l is HandLogFile {
  const u8 = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 255;
  return !!l && typeof l === "object" && l.table === table && l.handNo === handNo
    && typeof l.secret === "string" && /^[0-9a-f]{64}$/.test(l.secret)
    && Number.isInteger(l.len) && l.len >= 0 && l.len <= 4096
    && Array.isArray(l.entries) && l.entries.length <= 512
    && l.entries.every((e: any) => !!e && typeof e === "object" && u8(e.street) && u8(e.seat) && u8(e.kind)
      && typeof e.committed === "string" && /^[0-9]{1,20}$/.test(e.committed) && BigInt(e.committed) < 2n ** 64n);
}
const tableRow = (r: any) => ({ address: r.address, tableId: r.table_id, creator: r.creator, open: r.status === 1, maxSeats: r.max_seats, seated: r.seated,
  live: r.status === 1 && r.delegated, inviteOnly: r.invite_only, smallBlind: r.small_blind, bigBlind: r.big_blind, minBuyIn: r.min_buy_in, maxBuyIn: r.max_buy_in, handNo: r.hand_no, updatedAt: r.updated_at });
const handRow = (r: any) => ({ handNo: r.hand_no, record: r.record, verified: r.verified, buttonChecked: r.button_checked !== false, problems: r.problems,
  log: { status: r.log_status, verified: r.log_verified }, archivedAt: r.archived_at });

export function app() {
  const a = express();
  a.disable("x-powered-by");
  // Railway puts two proxies in front of the service (its edge, then the router); each appends the
  // address it saw to X-Forwarded-For. Trusting exactly 2 hops makes req.ip the real client;
  // anything a client writes into X-Forwarded-For itself sits further left and is ignored.
  // (Checked with /audit/whoami: with 1 hop, req.ip was Railway's edge, rotating per request.)
  a.set("trust proxy", 2);
  // The game (a web page on any host) reads the public routes directly, so they allow any origin.
  // The audit routes don't: they're for the operator's own tools, never a browser page.
  a.use((req, res, next) => {
    if (req.path.toLowerCase().startsWith("/audit")) return next(); // Express routing ignores case
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "content-type");
    res.set("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });
  a.use(express.json({ limit: "64kb" }));
  a.use(rateLimit(Number(process.env.RATE_PER_MINUTE ?? 120)));

  // Probes are cached for 5 s, so /health traffic can't push the service's RPC use up.
  let probe = { at: 0, db: "down", l1Slot: null as number | null, rollupSlot: null as number | null };
  // M10: feature flags the game reads at start. Turning PRIVATE_TABLES off (a Railway variable, then a
  // restart) hides private tables in every game client; Coins tables and their escrow are unaffected.
  // M12: Agents (every request signed by the player's play key; see agents.ts).
  agentRoutes(a);

  a.get("/flags", (_req, res) => {
    res.set("cache-control", "no-store").json({ privateTables: config.privateTables });
  });

  a.get("/health", async (_req, res) => {
    if (Date.now() - probe.at > 5_000) {
      const next = { at: Date.now(), db: "down", l1Slot: null as number | null, rollupSlot: null as number | null };
      try { await pool.query("select 1"); next.db = "ok"; } catch { /* down */ }
      try { next.l1Slot = await l1.getSlot(); } catch { /* unreachable */ }
      try { next.rollupSlot = await teePublic.getSlot(); } catch { /* unreachable */ }
      probe = next;
    }
    const k = keeperState;
    // A standby instance (another holds the keeper lock, deep review) is healthy: a deploy waits on it.
    const keeperLooping = !config.keeperEnabled || k.standby || Date.now() - Math.max(k.lastLoopAt, k.startedAt) < 60_000;
    // Error text stays in /audit/events; the public page only says when the last one happened.
    const keeper = { enabled: config.keeperEnabled, standby: k.standby, address: config.keeper.publicKey.toBase58(), startedAt: k.startedAt, lastLoopAt: k.lastLoopAt,
      loops: k.loops, tablesTracked: k.tablesTracked, lastErrorAt: k.lastErrorAt || null, auditorMatches: k.auditorMatches,
      delegationProgram: { upgradeSlot: k.dlp.slot, expectedSlot: k.dlp.expected, changed: k.dlp.changed } };
    const ok = probe.db === "ok" && probe.l1Slot !== null && probe.rollupSlot !== null && keeperLooping && k.auditorMatches !== false;
    res.status(ok ? 200 : 503).json({ ok, db: probe.db, l1Slot: probe.l1Slot, rollupSlot: probe.rollupSlot, keeper, auditor: config.auditor.publicKey.toBase58() });
  });

  a.get("/tables", async (req, res) => {
    // M9c: ?creator=<wallet> lists that host's tables in any state (open, closed, not yet live), so a
    // host sees "Your tables" on any device. The creator is public on every table, on Solana too.
    if (req.query.creator !== undefined) {
      if (typeof req.query.creator !== "string" || !isAddress(req.query.creator)) { res.status(400).json({ error: "bad creator address" }); return; }
      const r = await pool.query("select * from tables where creator = $1 order by first_seen desc limit 100", [req.query.creator]);
      res.json(r.rows.map(tableRow));
      return;
    }
    // Only tables that are playing, or opened / dealt a hand in the last hour: abandoned ones (test seats nobody will
    // ever play) stay out of the lobby. A host still sees theirs under "Your tables" (?creator=).
    const r = await pool.query("select * from tables where status = 1 and delegated and (hand_state <> 0 or idle_since > extract(epoch from now()) - 3600) order by updated_at desc limit 200");
    res.json(r.rows.map(tableRow));
  });

  // M11: tournaments, as the keeper last read them from the rollup (all public on chain). Listed ones only,
  // unless ?all=1 (a private tournament's link carries its address).
  a.get("/tournaments", (req, res) => {
    const all = req.query.all === "1";
    res.json({ at: tourneyList.at, items: tourneyList.items.filter((t) => all || !t.private || t.status !== 0) });
  });

  a.get("/tables/:table", async (req, res) => {
    if (!isAddress(req.params.table)) { res.status(400).json({ error: "bad table address" }); return; }
    const r = await pool.query("select * from tables where address = $1", [req.params.table]);
    if (!r.rowCount) { res.status(404).json({ error: "unknown table" }); return; }
    res.json(tableRow(r.rows[0]));
  });

  a.get("/tables/:table/hands", async (req, res) => {
    if (!isAddress(req.params.table)) { res.status(400).json({ error: "bad table address" }); return; }
    const limit = limitOf(req.query.limit, 50, 200);
    const before = isHandNo(req.query.before) ? req.query.before : null;
    const r = await pool.query(
      `select table_address, hand_no, record, verified, problems, log_status, log_verified, button_checked, archived_at from hands
       where table_address = $1 and ($2::bigint is null or hand_no < $2::bigint) order by hand_no desc limit $3`, [req.params.table, before, limit]);
    res.json(r.rows.map(handRow));
  });

  a.get("/tables/:table/hands/:hand", async (req, res) => {
    if (!isAddress(req.params.table) || !isHandNo(req.params.hand)) { res.status(400).json({ error: "bad table or hand" }); return; }
    const r = await pool.query("select table_address, hand_no, record, verified, problems, log_status, log_verified, button_checked, archived_at from hands where table_address = $1 and hand_no = $2",
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
    if (typeof table !== "string" || !isAddress(table) || !isHandNo(handNo) || !isLogFile(log, table, handNo)) {
      res.status(400).json({ error: "expected { table, handNo, log: { table, handNo, secret (64 hex), len, entries: [{ street, seat, kind, committed }] } }" }); return;
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
    const limit = limitOf(req.query.limit, 100, 1000);
    const table = typeof req.query.table === "string" && isAddress(req.query.table) ? req.query.table : null;
    res.json((await pool.query("select * from keeper_events where ($2::text is null or table_address = $2) order by id desc limit $1", [limit, table])).rows);
  });

  /** How this request's client address was seen (checks the proxy setting behind Railway). */
  a.get("/audit/whoami", adminOnly, (req, res) => { res.json({ ip: req.ip, ips: req.ips, xff: req.get("x-forwarded-for") ?? null, xRealIp: req.get("x-real-ip") ?? null }); });

  /** The keeper's current state, including its last error text (public /health shows only when). */
  a.get("/audit/keeper", adminOnly, (_req, res) => { res.json({ ...keeperState, lastError: redact(keeperState.lastError) }); });
  a.get("/audit/agents", adminOnly, (_req, res) => { res.json({ ...runnerState, lastError: redact(runnerState.lastError) }); });

  a.use((_req, res) => res.status(404).json({ error: "not found" }));
  // Client errors raised by Express itself (invalid JSON 400, body too large 413) keep their status;
  // anything else is a 500 without details.
  a.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const client = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;
    res.status(client ? err.status : 500).json({ error: client ? "bad request" : "internal error" });
  });
  return a;
}
