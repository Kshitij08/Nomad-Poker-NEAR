import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { PlayFabError, type PlayFabEconomy } from "../services/playfab.js";
import { isJoinCode, newJoinCode, newSessionName, normalizeJoinCode } from "./codes.js";
import { enqueueMove, entryDebitKey, MoneyService, refundKey } from "./money.js";
import { computePayout, MAX_CHIP_AMOUNT } from "./payout.js";

/**
 * Hosted round-format tournaments: the records, the rules around them, and the clock that moves them
 * from registration to a result. Chips move only through MoneyService.
 *
 * Lifecycle: funding (host prize being taken) → registering → locked (roster frozen at the start time)
 * → running (the tournament server said it started) → finished. Off the main line: funding_failed,
 * cancelled (host, or fewer than 2 players at the start time) and aborted (the server never started or
 * went quiet). Cancelled and aborted refund every entry fee and the host's prize.
 */

export type Speed = "turbo" | "regular" | "slow";
export type Visibility = "public" | "private";

export class TournamentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface TournamentOptions {
  clock?: () => Date;
  /** Earliest a new tournament may start. 10 minutes by default; tests and dev shorten it. */
  minLeadMs?: number;
  maxLeadMs?: number;
  /** Most tournaments one host may have open at once. */
  maxActivePerHost?: number;
}

export interface Viewer {
  playFabId: string;
}

const SPAWN_LEAD_MS = 3 * 60_000;
const SPAWN_CLAIM_STALE_MS = 90_000;
const START_GRACE_MS = 3 * 60_000;
const HEARTBEAT_TIMEOUT_MS = 3 * 60_000;
const EDIT_FREEZE_MS = 5 * 60_000;
const MAX_ENTRY_FEE = 1_000_000;
const MAX_HOST_PRIZE = 10_000_000;
const ACTIVE_ENTRY = `('paying', 'registered', 'playing', 'finished')`;
const OPEN_STATUSES = `('funding', 'registering', 'locked', 'running')`;

export class TournamentService {
  readonly money: MoneyService;
  private readonly clock: () => Date;
  private readonly minLeadMs: number;
  private readonly maxLeadMs: number;
  private readonly maxActivePerHost: number;
  private readonly bootedAt: Date;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly pool: Pool,
    private readonly playfab: PlayFabEconomy | null,
    options: TournamentOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.minLeadMs = options.minLeadMs ?? Number(process.env.TOURNAMENT_MIN_LEAD_SECS ?? 600) * 1000;
    this.maxLeadMs = options.maxLeadMs ?? 14 * 24 * 60 * 60_000;
    this.maxActivePerHost = options.maxActivePerHost ?? 2;
    this.money = new MoneyService(pool, playfab, this.clock);
    this.bootedAt = this.clock();
  }

  // ---- Identity ---------------------------------------------------------------------------

  /** Checks a PlayFab session ticket and remembers who it belongs to. */
  async authenticate(sessionTicket: string): Promise<{ playFabId: string; displayName: string }> {
    if (!this.playfab) throw new TournamentError(503, "playfab_unavailable", "Tournaments are not set up on this server.");
    if (!sessionTicket) throw new TournamentError(400, "bad_request", "sessionTicket is required.");
    let identity;
    try {
      identity = await this.playfab.authenticateSessionTicket(sessionTicket);
    } catch (err) {
      if (err instanceof PlayFabError && err.final) {
        throw new TournamentError(401, "invalid_ticket", "Your sign-in has expired. Sign in again.");
      }
      throw new TournamentError(503, "playfab_unavailable", "Couldn't reach PlayFab. Try again.");
    }
    const displayName = identity.displayName?.trim() || `Player ${identity.playFabId.slice(-4)}`;
    await this.pool.query(
      `INSERT INTO pf_players (playfab_id, title_player_account_id, display_name, last_seen_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (playfab_id) DO UPDATE
         SET title_player_account_id = EXCLUDED.title_player_account_id,
             display_name = EXCLUDED.display_name,
             last_seen_at = EXCLUDED.last_seen_at`,
      [identity.playFabId, identity.titlePlayerAccountId, displayName, this.clock()]
    );
    return { playFabId: identity.playFabId, displayName };
  }

  // ---- Reading ----------------------------------------------------------------------------

  async list(filter: string, limit = 50) {
    const now = this.clock();
    const where =
      filter === "running" ? `t.status IN ('locked', 'running')`
      : filter === "finished" ? `t.status = 'finished' AND t.finished_at > $1::timestamptz - interval '7 days'`
      : `t.status = 'registering' AND t.starts_at > $1::timestamptz`;
    const order = filter === "finished" ? `t.finished_at DESC` : `t.starts_at ASC`;
    const params: unknown[] = filter === "running" ? [] : [now];
    params.push(Math.max(1, Math.min(100, limit)));
    const rows = await this.pool.query(
      `${SELECT_TOURNAMENT} WHERE t.visibility = 'public' AND ${where} ORDER BY ${order} LIMIT $${params.length}`,
      params
    );
    return { serverNowUnix: unix(now), tournaments: rows.rows.map((r) => this.view(r, null)) };
  }

  async get(id: string, viewer: Viewer | null) {
    const row = await this.findById(id);
    if (!row) throw notFound();
    const entry = viewer ? await this.entryOf(id, viewer.playFabId) : null;
    // A private tournament's code is its invitation: only the host and its players see it here.
    const showCode = row.visibility === "public" || row.host_playfab_id === viewer?.playFabId || Boolean(entry);
    return { serverNowUnix: unix(this.clock()), tournament: this.view(row, entry, showCode, viewer?.playFabId ?? null) };
  }

  async getByCode(rawCode: string, viewer: Viewer | null) {
    const code = normalizeJoinCode(rawCode);
    if (!isJoinCode(code)) throw new TournamentError(400, "bad_code", "That isn't a tournament code.");
    const row = (await this.pool.query(`${SELECT_TOURNAMENT} WHERE t.join_code = $1`, [code])).rows[0];
    if (!row) throw new TournamentError(404, "not_found", "No tournament has that code.");
    const entry = viewer ? await this.entryOf(row.id, viewer.playFabId) : null;
    return { serverNowUnix: unix(this.clock()), tournament: this.view(row, entry, true, viewer?.playFabId ?? null) };
  }

  /** Everything the player is in or hosting, newest first, with where to connect once the server is up. */
  async mine(viewer: Viewer) {
    const entries = await this.pool.query(
      `${SELECT_TOURNAMENT_WITH_ENTRY}
       WHERE e.playfab_id = $1 AND (t.status IN ${OPEN_STATUSES} OR t.starts_at > $2::timestamptz - interval '7 days')
       ORDER BY t.starts_at DESC LIMIT 50`,
      [viewer.playFabId, this.clock()]
    );
    const hosted = await this.pool.query(
      `${SELECT_TOURNAMENT}
       WHERE t.host_playfab_id = $1 AND (t.status IN ${OPEN_STATUSES} OR t.starts_at > $2::timestamptz - interval '7 days')
       ORDER BY t.starts_at DESC LIMIT 50`,
      [viewer.playFabId, this.clock()]
    );
    return {
      serverNowUnix: unix(this.clock()),
      entries: entries.rows.map((r) => this.view(r, r, true, viewer.playFabId)),
      hosted: hosted.rows.map((r) => this.view(r, null, true, viewer.playFabId)),
    };
  }

  // ---- Hosting ----------------------------------------------------------------------------

  async create(host: Viewer, input: any) {
    const now = this.clock();
    const name = text(input?.name, 1, 40, "Name");
    const entryFee = whole(input?.entryFee ?? 0, 0, MAX_ENTRY_FEE, "Entry fee");
    const hostPrize = whole(input?.hostPrize ?? 0, 0, MAX_HOST_PRIZE, "Host prize");
    const maxPlayers = whole(input?.maxPlayers ?? 30, 2, 30, "Max players");
    const speed = oneOf<Speed>(input?.speed ?? "regular", ["turbo", "regular", "slow"], "Speed");
    const visibility = oneOf<Visibility>(input?.visibility ?? "public", ["public", "private"], "Visibility");
    const startsAt = this.startTime(input, now);
    if (hostPrize + entryFee * maxPlayers > MAX_CHIP_AMOUNT) {
      throw new TournamentError(400, "too_large", "That prize pool is too big.");
    }

    const id = randomUUID();
    const moveId = await this.transaction(async (c) => {
      await this.requirePlayer(c, host.playFabId);
      const open = await c.query(
        `SELECT count(*)::int AS n FROM tournaments WHERE host_playfab_id = $1 AND status IN ${OPEN_STATUSES}`,
        [host.playFabId]
      );
      if (open.rows[0].n >= this.maxActivePerHost) {
        throw new TournamentError(409, "host_limit", `You can host ${this.maxActivePerHost} tournaments at a time.`);
      }

      for (let attempt = 0; ; attempt++) {
        try {
          await c.query("SAVEPOINT code_attempt");
          await c.query(
            `INSERT INTO tournaments
               (id, name, host_playfab_id, entry_fee, host_prize, visibility, join_code, session_name,
                starts_at, speed, max_players, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
            [id, name, host.playFabId, entryFee, hostPrize, visibility, newJoinCode(), newSessionName(),
              startsAt, speed, maxPlayers, hostPrize > 0 ? "funding" : "registering", now]
          );
          break;
        } catch (err: any) {
          await c.query("ROLLBACK TO SAVEPOINT code_attempt");
          if (err?.code !== "23505" || attempt >= 5) throw err;   // unique code collision: draw again
        }
      }

      return enqueueMove(
        c,
        { tournamentId: id, playFabId: host.playFabId, kind: "host_prize_debit", amount: hostPrize, key: `trn:${id}:host_prize` },
        now
      );
    });

    if (moveId) await this.money.run(moveId);
    const row = await this.findById(id);
    if (row.status === "funding_failed") {
      throw new TournamentError(402, "insufficient_chips", "You don't have enough chips for that prize.");
    }
    return { serverNowUnix: unix(this.clock()), tournament: this.view(row, null, true, host.playFabId) };
  }

  async edit(host: Viewer, id: string, input: any) {
    const now = this.clock();
    await this.transaction(async (c) => {
      const t = await this.lockHosted(c, id, host);
      this.requireEditable(t, now);
      const sets: string[] = [];
      const args: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        args.push(value);
        sets.push(`${column} = $${args.length}`);
      };

      if (input?.name !== undefined) set("name", text(input.name, 1, 40, "Name"));
      if (input?.speed !== undefined) set("speed", oneOf(input.speed, ["turbo", "regular", "slow"], "Speed"));
      if (input?.visibility !== undefined) set("visibility", oneOf(input.visibility, ["public", "private"], "Visibility"));
      if (input?.startsAt !== undefined || input?.startsAtUnix !== undefined) set("starts_at", this.startTime(input, now));

      const players = await this.countActive(c, id);
      if (input?.maxPlayers !== undefined) {
        const max = whole(input.maxPlayers, 2, 30, "Max players");
        if (max < players) throw new TournamentError(409, "too_many_players", `${players} players are already in.`);
        set("max_players", max);
      }
      if (input?.entryFee !== undefined) {
        const fee = whole(input.entryFee, 0, MAX_ENTRY_FEE, "Entry fee");
        if (fee !== Number(t.entry_fee)) {
          const anyone = await c.query(`SELECT 1 FROM tournament_entries WHERE tournament_id = $1 LIMIT 1`, [id]);
          if (anyone.rowCount) {
            throw new TournamentError(409, "fee_locked", "The entry fee can't change once someone has registered.");
          }
          set("entry_fee", fee);
        }
      }
      if (!sets.length) return;
      set("updated_at", now);
      await c.query(`UPDATE tournaments SET ${sets.join(", ")} WHERE id = $1`, args);
    });
    return this.get(id, host);
  }

  async raisePrize(host: Viewer, id: string, rawAmount: unknown) {
    const now = this.clock();
    const amount = whole(rawAmount, 1, MAX_HOST_PRIZE, "Amount");
    const moveId = await this.transaction(async (c) => {
      const t = await this.lockHosted(c, id, host);
      if (t.status !== "registering" || now >= t.starts_at) {
        throw new TournamentError(409, "not_open", "The prize can only be raised before the start.");
      }
      if (Number(t.host_prize) + amount + Number(t.entry_fee) * t.max_players > MAX_CHIP_AMOUNT) {
        throw new TournamentError(400, "too_large", "That prize pool is too big.");
      }
      const n = t.prize_raise_count + 1;
      await c.query(`UPDATE tournaments SET prize_raise_count = $2, updated_at = $3 WHERE id = $1`, [id, n, now]);
      return enqueueMove(
        c,
        { tournamentId: id, playFabId: host.playFabId, kind: "prize_raise_debit", amount, key: `trn:${id}:raise:${n}` },
        now
      );
    });
    const outcome = moveId ? await this.money.run(moveId) : "done";
    if (outcome === "failed") throw new TournamentError(402, "insufficient_chips", "You don't have enough chips.");
    return this.get(id, host);
  }

  async cancel(host: Viewer, id: string) {
    const refunds = await this.transaction(async (c) => {
      const t = await this.lockHosted(c, id, host);
      if (t.status !== "funding" && t.status !== "registering") {
        throw new TournamentError(409, "not_open", "A tournament can only be cancelled before it starts.");
      }
      return this.cancelLocked(c, t, "cancelled", "host_cancelled");
    });
    await this.money.runAll(refunds);
    return this.get(id, host);
  }

  async remove(host: Viewer, id: string, playFabId: string) {
    const now = this.clock();
    const refund = await this.transaction(async (c) => {
      const t = await this.lockHosted(c, id, host);
      if (t.status !== "registering" || now >= t.starts_at) {
        throw new TournamentError(409, "not_open", "Players can only be removed before the start.");
      }
      return this.leave(c, t, playFabId, "removed");
    });
    await this.money.runAll([refund]);
    return this.get(id, host);
  }

  // ---- Playing ----------------------------------------------------------------------------

  async register(player: Viewer, id: string) {
    const now = this.clock();
    const moveId = await this.transaction(async (c) => {
      const t = await this.lockTournament(c, id);
      if (t.status !== "registering" || now >= t.starts_at) {
        throw new TournamentError(409, "not_open", "Registration is closed.");
      }
      const name = await this.requirePlayer(c, player.playFabId);
      const existing = (
        await c.query(
          `SELECT * FROM tournament_entries WHERE tournament_id = $1 AND playfab_id = $2 FOR UPDATE`,
          [id, player.playFabId]
        )
      ).rows[0];
      if (existing && (existing.status === "paying" || existing.status === "registered")) return null;   // already in
      if (existing?.status === "removed") {
        throw new TournamentError(403, "removed", "The host removed you from this tournament.");
      }
      if ((await this.countActive(c, id)) >= t.max_players) {
        throw new TournamentError(409, "full", "This tournament is full.");
      }

      const fee = Number(t.entry_fee);
      const status = fee > 0 ? "paying" : "registered";
      let entryId: number;
      let attempt: number;
      if (existing) {
        attempt = existing.attempt + 1;
        entryId = Number(existing.id);
        await c.query(
          `UPDATE tournament_entries
           SET status = $2, attempt = $3, paid_amount = 0, display_name = $4, updated_at = $5 WHERE id = $1`,
          [entryId, status, attempt, name, now]
        );
      } else {
        attempt = 1;
        const inserted = await c.query(
          `INSERT INTO tournament_entries (tournament_id, playfab_id, display_name, status, attempt, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 1, $5, $5) RETURNING id`,
          [id, player.playFabId, name, status, now]
        );
        entryId = Number(inserted.rows[0].id);
      }
      return enqueueMove(
        c,
        { tournamentId: id, entryId, playFabId: player.playFabId, kind: "entry_debit", amount: fee,
          key: entryDebitKey(id, player.playFabId, attempt) },
        now
      );
    });

    const outcome = moveId ? await this.money.run(moveId) : "done";
    if (outcome === "failed") throw new TournamentError(402, "insufficient_chips", "You don't have enough chips to enter.");
    return this.get(id, player);
  }

  async unregister(player: Viewer, id: string) {
    const now = this.clock();
    const refund = await this.transaction(async (c) => {
      const t = await this.lockTournament(c, id);
      if (t.status !== "registering" || now >= t.starts_at) {
        throw new TournamentError(409, "not_open", "You can't leave after the start.");
      }
      return this.leave(c, t, player.playFabId, "unregistered");
    });
    await this.money.runAll([refund]);
    return this.get(id, player);
  }

  // ---- The tournament server (internal routes) ----------------------------------------------

  /** Hands one queued tournament to the spawner, so exactly one process hosts it. */
  async claimSpawn() {
    const now = this.clock();
    const row = (
      await this.pool.query(
        `UPDATE tournaments SET server_state = 'claimed', server_claimed_at = $1, updated_at = $1
         WHERE id = (
           SELECT id FROM tournaments
           WHERE server_state = 'queued' AND status IN ('registering', 'locked')
           ORDER BY starts_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id, session_name, starts_at, speed`,
        [now]
      )
    ).rows[0];
    if (!row) return { found: false, tournamentId: "", sessionName: "", startsAtUnix: 0, speed: "" };
    return { found: true, tournamentId: row.id, sessionName: row.session_name, startsAtUnix: unix(row.starts_at), speed: row.speed };
  }

  async ready(id: string, ok: boolean, error: string) {
    const now = this.clock();
    // Any server holding the internal key may say it is hosting — a spawned child after its claim, or an
    // Editor started by hand for testing, which never claims.
    const result = ok
      ? await this.pool.query(
          `UPDATE tournaments SET server_state = 'ready', server_ready_at = $2, server_error = NULL, updated_at = $2
           WHERE id = $1 AND status IN ('registering', 'locked', 'running') RETURNING id`,
          [id, now]
        )
      : await this.pool.query(
          `UPDATE tournaments SET server_state = 'queued', server_error = $3, updated_at = $2
           WHERE id = $1 AND server_state IN ('claimed', 'queued') RETURNING id`,
          [id, now, String(error ?? "").slice(0, 500)]
        );
    if (!result.rowCount) throw new TournamentError(409, "not_open", "This tournament isn't waiting for a server.");
    return { ok: true };
  }

  /** The tournament as the server needs it: settings plus the roster (frozen once the start time passes). */
  async roster(id: string) {
    const t = await this.findById(id);
    if (!t) throw notFound();
    const entries = await this.pool.query(
      `SELECT playfab_id, display_name, status FROM tournament_entries
       WHERE tournament_id = $1 AND status IN ('registered', 'playing', 'finished')
       ORDER BY created_at, id`,
      [id]
    );
    // What the table HUD shows as the prizes: the host's prize plus everyone in, as it stands now.
    const prizes = computePayout(Number(t.host_prize), Number(t.entry_fee), entries.rowCount ?? 0, t.platform_fee_bps);
    return {
      serverNowUnix: unix(this.clock()),
      tournamentId: t.id,
      name: t.name,
      hostPlayFabId: t.host_playfab_id,
      status: t.status,
      sessionName: t.session_name,
      speed: t.speed,
      startsAtUnix: unix(t.starts_at),
      rosterFrozen: t.status === "locked" || t.status === "running" || t.status === "finished",
      firstPrize: prizes.first,
      secondPrize: prizes.second,
      entrants: entries.rows.map((e) => ({ playFabId: e.playfab_id, displayName: e.display_name })),
    };
  }

  /**
   * The tournament server asking who a joining client is. It checks the PlayFab session ticket here, so
   * game servers never need the PlayFab secret key, and learns whether that player is in the tournament.
   */
  async verify(id: string, sessionTicket: string) {
    const t = await this.findById(id);
    if (!t) throw notFound();
    const who = await this.authenticate(sessionTicket);
    const entry = await this.entryOf(id, who.playFabId);
    const entrant = Boolean(entry) && ["registered", "playing", "finished"].includes(entry.entry_status);
    // Watching is for the host and the players only; the server turns everyone else away.
    const host = who.playFabId === t.host_playfab_id;
    return { ok: true, playFabId: who.playFabId, displayName: who.displayName, entrant, host };
  }

  async started(id: string) {
    const now = this.clock();
    const result = await this.pool.query(
      `UPDATE tournaments SET status = 'running', started_at = COALESCE(started_at, $2), last_heartbeat_at = $2, updated_at = $2
       WHERE id = $1 AND status IN ('locked', 'running') RETURNING id`,
      [id, now]
    );
    if (!result.rowCount) throw new TournamentError(409, "not_locked", "This tournament isn't ready to start.");
    return { ok: true };
  }

  async progress(id: string, seq: number, snapshot: unknown) {
    const now = this.clock();
    const result = await this.pool.query(
      `UPDATE tournaments
       SET last_heartbeat_at = $2,
           last_progress = CASE WHEN $3::bigint > progress_seq THEN $4::jsonb ELSE last_progress END,
           progress_seq = GREATEST(progress_seq, $3::bigint),
           updated_at = $2
       WHERE id = $1 AND status IN ('locked', 'running') RETURNING id`,
      [id, now, Math.trunc(Number(seq) || 0), JSON.stringify(snapshot ?? null)]
    );
    if (!result.rowCount) throw new TournamentError(409, "not_running", "This tournament isn't running.");
    return { ok: true };
  }

  /**
   * The final standings from the tournament server. Records places, pays 1st and 2nd. Sending the same
   * result again is a no-op; a different result for a finished tournament is refused.
   */
  async result(id: string, body: any) {
    const now = this.clock();
    const championId = String(body?.championId ?? "");
    const standings: { playFabId: string; place: number; roundReached: number }[] = Array.isArray(body?.standings)
      ? body.standings.map((s: any) => ({
          playFabId: String(s?.playFabId ?? ""),
          place: Number(s?.place),
          roundReached: Number(s?.roundReached),
        }))
      : [];
    const canonical = JSON.stringify({
      championId,
      standings: [...standings].sort((a, b) => a.place - b.place),
    });
    const hash = createHash("sha256").update(canonical).digest("hex");

    const payouts = await this.transaction(async (c) => {
      const t = await this.lockTournament(c, id);
      if (t.status === "finished") {
        if (t.result_hash === hash) return [] as number[];
        throw new TournamentError(409, "result_conflict", "A different result was already recorded.");
      }
      if (t.status !== "running" && t.status !== "locked") {
        throw new TournamentError(409, "not_running", `This tournament is ${t.status}.`);
      }

      const playing = (
        await c.query(
          `SELECT id, playfab_id, paid_amount FROM tournament_entries WHERE tournament_id = $1 AND status = 'playing'`,
          [id]
        )
      ).rows;
      validateStandings(standings, championId, playing.map((e) => e.playfab_id));

      const funded = Number(
        (
          await c.query(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM money_moves
             WHERE tournament_id = $1 AND kind IN ('host_prize_debit', 'prize_raise_debit') AND state = 'done'`,
            [id]
          )
        ).rows[0].total
      );
      const paidEntrants = playing.filter((e) => Number(e.paid_amount) > 0).length;
      const payout = computePayout(funded, Number(t.entry_fee), paidEntrants, t.platform_fee_bps);

      const byPlayer = new Map(playing.map((e) => [e.playfab_id, e]));
      const moves: number[] = [];
      for (const s of standings) {
        const prize = s.place === 1 ? payout.first : s.place === 2 ? payout.second : 0;
        const entry = byPlayer.get(s.playFabId)!;
        await c.query(
          `UPDATE tournament_entries SET status = 'finished', place = $2, round_reached = $3, prize = $4, updated_at = $5
           WHERE id = $1`,
          [entry.id, s.place, s.roundReached, prize, now]
        );
        if (prize > 0) {
          const moveId = await enqueueMove(
            c,
            { tournamentId: id, entryId: Number(entry.id), playFabId: s.playFabId, kind: "payout", amount: prize,
              key: `trn:${id}:payout:${s.place}` },
            now
          );
          if (moveId) moves.push(moveId);
        }
      }

      await c.query(
        `UPDATE tournaments
         SET status = 'finished', finished_at = $2, result = $3::jsonb, result_hash = $4, updated_at = $2
         WHERE id = $1`,
        [id, now, JSON.stringify({ championId, standings, payout }), hash]
      );
      return moves;
    });

    await this.money.runAll(payouts);
    return this.get(id, null);
  }

  // ---- The clock --------------------------------------------------------------------------

  startScheduler(intervalMs = 5_000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.warn("[tournaments] tick failed:", err?.message ?? err));
    }, intervalMs);
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass of everything time moves along: queue servers before the start, lock or cancel at the
   * start, give up on servers that never came or went quiet, and retry pending money.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock();

      // The host's prize never cleared before the start: nothing to play for.
      for (const row of (await this.pool.query(
        `SELECT id FROM tournaments WHERE status = 'funding' AND starts_at <= $1`, [now])).rows) {
        await this.cancelById(row.id, "cancelled", "prize_not_funded");
      }

      // A server needs a couple of minutes to boot; ask for one as soon as there is a game to play.
      await this.pool.query(
        `UPDATE tournaments t SET server_state = 'queued', updated_at = $1
         WHERE t.status = 'registering' AND t.server_state = 'none' AND t.starts_at <= $2
           AND (SELECT count(*) FROM tournament_entries e
                WHERE e.tournament_id = t.id AND e.status IN ('paying', 'registered')) >= 2`,
        [now, new Date(now.getTime() + SPAWN_LEAD_MS)]
      );
      await this.pool.query(
        `UPDATE tournaments SET server_state = 'queued', updated_at = $1
         WHERE server_state = 'claimed' AND server_claimed_at < $2 AND status IN ('registering', 'locked')`,
        [now, new Date(now.getTime() - SPAWN_CLAIM_STALE_MS)]
      );

      for (const row of (await this.pool.query(
        `SELECT id FROM tournaments WHERE status = 'registering' AND starts_at <= $1`, [now])).rows) {
        await this.lockOrCancel(row.id);
      }

      for (const row of (await this.pool.query(
        `SELECT id FROM tournaments WHERE status = 'locked' AND started_at IS NULL AND starts_at < $1`,
        [new Date(now.getTime() - START_GRACE_MS)])).rows) {
        await this.cancelById(row.id, "aborted", "server_never_started");
      }

      // Measured from this process's boot too, so a backend restart doesn't read as a dead server.
      const quietSince = new Date(Math.max(now.getTime() - HEARTBEAT_TIMEOUT_MS, 0));
      for (const row of (await this.pool.query(
        `SELECT id FROM tournaments
         WHERE status = 'running' AND GREATEST(last_heartbeat_at, started_at, $2::timestamptz) < $1`,
        [quietSince, this.bootedAt])).rows) {
        await this.cancelById(row.id, "aborted", "server_lost");
      }

      await this.money.runDue();
    } finally {
      this.ticking = false;
    }
  }

  private async lockOrCancel(id: string) {
    const now = this.clock();
    const refunds = await this.transaction(async (c) => {
      const t = await this.lockTournament(c, id);
      if (t.status !== "registering" || t.starts_at > now) return [] as number[];
      const ready = await c.query(
        `SELECT count(*)::int AS n FROM tournament_entries WHERE tournament_id = $1 AND status = 'registered'`,
        [id]
      );
      if (ready.rows[0].n < 2) return this.cancelLocked(c, t, "cancelled", "not_enough_players");

      // Anyone still paying is left out; their payment is refunded when it lands (MoneyService).
      await c.query(
        `UPDATE tournament_entries SET status = 'playing', updated_at = $2 WHERE tournament_id = $1 AND status = 'registered'`,
        [id, now]
      );
      await c.query(
        `UPDATE tournaments
         SET status = 'locked', locked_at = $2, updated_at = $2,
             server_state = CASE WHEN server_state = 'none' THEN 'queued' ELSE server_state END
         WHERE id = $1`,
        [id, now]
      );
      return [] as number[];
    });
    await this.money.runAll(refunds);
  }

  private async cancelById(id: string, status: "cancelled" | "aborted", reason: string) {
    const refunds = await this.transaction(async (c) => {
      const t = await this.lockTournament(c, id);
      if (["finished", "cancelled", "aborted", "funding_failed"].includes(t.status)) return [] as number[];
      return this.cancelLocked(c, t, status, reason);
    });
    await this.money.runAll(refunds);
  }

  /** With the tournament row locked: end it and refund everything that was taken. */
  private async cancelLocked(c: PoolClient, t: any, status: "cancelled" | "aborted", reason: string) {
    const now = this.clock();
    await c.query(
      `UPDATE tournaments SET status = $2, cancel_reason = $3, cancelled_at = $4, updated_at = $4 WHERE id = $1`,
      [t.id, status, reason, now]
    );

    const refunds: number[] = [];
    const entries = await c.query(
      `UPDATE tournament_entries SET status = 'cancelled', updated_at = $2
       WHERE tournament_id = $1 AND status IN ('registered', 'playing')
       RETURNING id, playfab_id, attempt, paid_amount`,
      [t.id, now]
    );
    for (const e of entries.rows) {
      const id = await enqueueMove(
        c,
        { tournamentId: t.id, entryId: Number(e.id), playFabId: e.playfab_id, kind: "refund",
          amount: Number(e.paid_amount), key: refundKey(entryDebitKey(t.id, e.playfab_id, e.attempt)) },
        now
      );
      if (id) refunds.push(id);
    }

    // The host's prize: refund each debit that went through. One still in flight is refunded when it
    // lands, because by then the tournament is no longer open.
    const hostDebits = await c.query(
      `SELECT playfab_id, amount, idempotency_key FROM money_moves
       WHERE tournament_id = $1 AND kind IN ('host_prize_debit', 'prize_raise_debit') AND state = 'done'`,
      [t.id]
    );
    for (const d of hostDebits.rows) {
      const id = await enqueueMove(
        c,
        { tournamentId: t.id, playFabId: d.playfab_id, kind: "refund", amount: Number(d.amount),
          key: refundKey(d.idempotency_key) },
        now
      );
      if (id) refunds.push(id);
    }
    return refunds;
  }

  /** With the tournament locked: take a player out before the start and refund their fee. */
  private async leave(c: PoolClient, t: any, playFabId: string, status: "unregistered" | "removed") {
    const entry = (
      await c.query(
        `SELECT * FROM tournament_entries WHERE tournament_id = $1 AND playfab_id = $2 FOR UPDATE`,
        [t.id, playFabId]
      )
    ).rows[0];
    if (!entry || !["paying", "registered"].includes(entry.status)) {
      throw new TournamentError(404, "not_registered", "That player isn't registered.");
    }
    if (entry.status === "paying") {
      throw new TournamentError(409, "payment_pending", "The entry fee is still going through. Try again in a moment.");
    }
    const now = this.clock();
    await c.query(`UPDATE tournament_entries SET status = $2, updated_at = $3 WHERE id = $1`, [entry.id, status, now]);
    return enqueueMove(
      c,
      { tournamentId: t.id, entryId: Number(entry.id), playFabId, kind: "refund", amount: Number(entry.paid_amount),
        key: refundKey(entryDebitKey(t.id, playFabId, entry.attempt)) },
      now
    );
  }

  // ---- Helpers ------------------------------------------------------------------------------

  private startTime(input: any, now: Date): Date {
    const raw = input?.startsAtUnix !== undefined ? Number(input.startsAtUnix) * 1000 : Date.parse(String(input?.startsAt ?? ""));
    if (!Number.isFinite(raw)) throw new TournamentError(400, "bad_request", "Pick a start time.");
    const startsAt = new Date(raw);
    if (startsAt.getTime() < now.getTime() + this.minLeadMs) {
      throw new TournamentError(400, "too_soon", `Start at least ${Math.ceil(this.minLeadMs / 60_000)} minutes from now.`);
    }
    if (startsAt.getTime() > now.getTime() + this.maxLeadMs) {
      throw new TournamentError(400, "too_far", "Start within the next two weeks.");
    }
    return startsAt;
  }

  private requireEditable(t: any, now: Date) {
    if (t.status !== "registering" && t.status !== "funding") {
      throw new TournamentError(409, "not_open", "This tournament can't be changed now.");
    }
    if (now.getTime() >= new Date(t.starts_at).getTime() - EDIT_FREEZE_MS) {
      throw new TournamentError(409, "frozen", "Details are frozen in the last 5 minutes.");
    }
  }

  private async requirePlayer(c: PoolClient, playFabId: string): Promise<string> {
    const row = (await c.query(`SELECT display_name FROM pf_players WHERE playfab_id = $1`, [playFabId])).rows[0];
    if (!row) throw new TournamentError(401, "sign_in", "Sign in again.");
    return row.display_name;
  }

  private async lockTournament(c: PoolClient, id: string) {
    if (!isUuid(id)) throw notFound();
    const t = (await c.query(`SELECT * FROM tournaments WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!t) throw notFound();
    return t;
  }

  private async lockHosted(c: PoolClient, id: string, host: Viewer) {
    const t = await this.lockTournament(c, id);
    if (t.host_playfab_id !== host.playFabId) throw new TournamentError(403, "not_host", "Only the host can do that.");
    return t;
  }

  private async countActive(c: PoolClient, id: string): Promise<number> {
    const r = await c.query(
      `SELECT count(*)::int AS n FROM tournament_entries WHERE tournament_id = $1 AND status IN ('paying', 'registered')`,
      [id]
    );
    return r.rows[0].n;
  }

  private async findById(id: string) {
    if (!isUuid(id)) return null;
    return (await this.pool.query(`${SELECT_TOURNAMENT} WHERE t.id = $1`, [id])).rows[0] ?? null;
  }

  private async entryOf(id: string, playFabId: string) {
    return (
      await this.pool.query(
        `SELECT status AS entry_status, place AS entry_place, prize AS entry_prize, paid_amount AS entry_paid
         FROM tournament_entries WHERE tournament_id = $1 AND playfab_id = $2`,
        [id, playFabId]
      )
    ).rows[0] ?? null;
  }

  private async transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /** The client's view. Flat, no nulls, no top-level arrays — Unity's JsonUtility reads it as is. */
  private view(row: any, entry: any, showCode = row.visibility === "public", viewerId: string | null = null) {
    const players = Number(row.players ?? 0);
    const estimate = computePayout(Number(row.host_prize), Number(row.entry_fee), players, row.platform_fee_bps);
    const myStatus = entry?.entry_status ?? "";
    const serverReady =
      row.server_state === "ready" && ["registering", "locked", "running"].includes(row.status);
    // Who learns where the server is: its players, and the host (to watch, even when not playing).
    const isHost = viewerId !== null && viewerId === row.host_playfab_id;
    const mayConnect = serverReady && (myStatus === "registered" || myStatus === "playing" || isHost);
    return {
      id: row.id,
      name: row.name,
      hostPlayFabId: row.host_playfab_id,
      hostName: row.host_name ?? "",
      currency: row.currency,
      entryFee: Number(row.entry_fee),
      hostPrize: Number(row.host_prize),
      prizePool: estimate.pool - estimate.fee,
      firstPrize: estimate.first,
      secondPrize: estimate.second,
      visibility: row.visibility,
      joinCode: showCode ? row.join_code : "",
      startsAt: new Date(row.starts_at).toISOString(),
      startsAtUnix: unix(row.starts_at),
      speed: row.speed,
      maxPlayers: row.max_players,
      players,
      format: formatFor(players),
      status: row.status,
      cancelReason: row.cancel_reason ?? "",
      myStatus,
      myPlace: Number(entry?.entry_place ?? 0),
      myPrize: Number(entry?.entry_prize ?? 0),
      serverReady: mayConnect,
      sessionName: mayConnect ? row.session_name : "",
    };
  }
}

const SELECT_TOURNAMENT = `
  SELECT t.*, h.display_name AS host_name,
         (SELECT count(*) FROM tournament_entries e2
          WHERE e2.tournament_id = t.id AND e2.status IN ${ACTIVE_ENTRY})::int AS players
  FROM tournaments t
  LEFT JOIN pf_players h ON h.playfab_id = t.host_playfab_id`;

const SELECT_TOURNAMENT_WITH_ENTRY = `
  SELECT t.*, h.display_name AS host_name,
         (SELECT count(*) FROM tournament_entries e2
          WHERE e2.tournament_id = t.id AND e2.status IN ${ACTIVE_ENTRY})::int AS players,
         e.status AS entry_status, e.place AS entry_place, e.prize AS entry_prize, e.paid_amount AS entry_paid
  FROM tournament_entries e
  JOIN tournaments t ON t.id = e.tournament_id
  LEFT JOIN pf_players h ON h.playfab_id = t.host_playfab_id`;

/** The same split as Poker.Core.RoundPlanner, so the page can say what the field will play. */
export function formatFor(players: number): "cancelled" | "single" | "two_tables" | "four_tables" {
  if (players < 2) return "cancelled";
  if (players <= 7) return "single";
  if (players <= 15) return "two_tables";
  return "four_tables";
}

function validateStandings(
  standings: { playFabId: string; place: number; roundReached: number }[],
  championId: string,
  roster: string[]
) {
  const bad = (msg: string) => new TournamentError(400, "bad_result", msg);
  if (standings.length !== roster.length) throw bad(`Expected ${roster.length} standings, got ${standings.length}.`);
  const rosterSet = new Set(roster);
  const seenPlayers = new Set<string>();
  const seenPlaces = new Set<number>();
  for (const s of standings) {
    if (!rosterSet.has(s.playFabId)) throw bad(`${s.playFabId} wasn't playing.`);
    if (seenPlayers.has(s.playFabId)) throw bad(`${s.playFabId} appears twice.`);
    if (!Number.isInteger(s.place) || s.place < 1 || s.place > roster.length || seenPlaces.has(s.place)) {
      throw bad(`Place ${s.place} is invalid or repeated.`);
    }
    if (!Number.isInteger(s.roundReached) || s.roundReached < 1) throw bad(`Round ${s.roundReached} is invalid.`);
    seenPlayers.add(s.playFabId);
    seenPlaces.add(s.place);
  }
  const champion = standings.find((s) => s.place === 1);
  if (!champion || champion.playFabId !== championId) throw bad("The champion must be in 1st place.");
}

function notFound() {
  return new TournamentError(404, "not_found", "Tournament not found.");
}

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function unix(value: Date | string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

function text(value: unknown, min: number, max: number, label: string): string {
  const s = String(value ?? "").trim();
  if (s.length < min || s.length > max) throw new TournamentError(400, "bad_request", `${label} must be ${min}–${max} characters.`);
  return s;
}

function whole(value: unknown, min: number, max: number, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new TournamentError(400, "bad_request", `${label} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function oneOf<T extends string>(value: unknown, allowed: T[], label: string): T {
  const s = String(value ?? "").toLowerCase() as T;
  if (!allowed.includes(s)) throw new TournamentError(400, "bad_request", `${label} must be one of: ${allowed.join(", ")}.`);
  return s;
}
