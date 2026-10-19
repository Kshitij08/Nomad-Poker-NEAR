// Agents v2 (docs/AGENTS_V2.md): playstyle records, "My Twin", coaching, and the Coins copy-strategy marketplace
// with its profit share (8% of new profit to the creator, 2% to Nomad, high-water mark per copier and strategy).
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { idempotencyIdFor, PlayFabError, type PlayFabEconomy } from "../services/playfab.js";
import { claudeNote, coach, type HandResult, type Report } from "./coach.js";
import { settleCopy } from "./fees.js";
import { clampProfile, PRESETS, tags, type Profile } from "./profile.js";
import { fitTwin, type Action, type Decision, type Twin } from "./style.js";
import { alike, behaviour, distance, styleCell, type Behaviour } from "./styleTags.js";
import { AGENT_ROOMS, type AgentRoom } from "../services/agentDeployments.js";

export class StrategyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const ACTIONS = new Set<Action>(["fold", "check", "call", "bet", "raise"]);
const int = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : NaN; };

/** Decisions the twin fits on (most recent first), and how many a strategy published from a twin needs. */
const TWIN_WINDOW = 3000;
export const MIN_TWIN_DECISIONS_TO_PUBLISH = 300;

export class StrategyService {
  private readonly noteCache = new Map<string, { at: number; report: Report & { note: string | null } }>();

  constructor(private readonly pool: Pool, private readonly playfab: PlayFabEconomy | null, private readonly clock = () => new Date()) {}

  // ---------------------------------------------------------------- recording (game server, internal API key)

  /** Decisions from a Coins table. Rows that don't make sense are skipped, not fatal. */
  async recordDecisions(rows: unknown[]): Promise<number> {
    let n = 0;
    for (const r of rows.slice(0, 500) as any[]) {
      const action = String(r?.action ?? "") as Action;
      const v = [int(r?.handNo), int(r?.street), int(r?.position), int(r?.opponents), int(r?.pot), int(r?.toCall), int(r?.minRaiseTo), int(r?.bigBlind), int(r?.stack), int(r?.amount ?? 0)];
      const strength = Number(r?.strength);
      const player = String(r?.playerId ?? "").trim(), table = String(r?.table ?? "").trim();
      if (!player || !table || !ACTIONS.has(action) || v.some((x) => !Number.isFinite(x)) || !(strength >= 0 && strength <= 1)) continue;
      await this.pool.query(
        `INSERT INTO style_decisions (player_id, table_name, hand_no, street, position, opponents, strength, pot, to_call,
                                      min_raise_to, big_blind, stack, action, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [player, table, v[0], v[1], v[2], v[3], strength, v[4], v[5], v[6], v[7], v[8], action, v[9]]);
      n++;
    }
    return n;
  }

  async recordHands(rows: unknown[]): Promise<number> {
    let n = 0;
    for (const r of rows.slice(0, 50) as any[]) {
      const player = String(r?.playerId ?? "").trim(), table = String(r?.table ?? "").trim();
      const v = [int(r?.handNo), int(r?.position), int(r?.bigBlind), int(r?.net)];
      if (!player || !table || v.some((x) => !Number.isFinite(x))) continue;
      await this.pool.query(
        `INSERT INTO style_hands (player_id, table_name, hand_no, position, big_blind, net, showdown, won)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [player, table, v[0], v[1], v[2], v[3], Boolean(r?.showdown), Boolean(r?.won)]);
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- twin and coaching (the player)

  private async decisions(playerId: string, limit = TWIN_WINDOW): Promise<(Decision & { table: string; handNo: number })[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM style_decisions WHERE player_id = $1 ORDER BY id DESC LIMIT $2`, [playerId, limit]);
    return rows.map((r) => ({
      table: r.table_name, handNo: r.hand_no, street: r.street, position: r.position, opponents: r.opponents,
      strength: Number(r.strength), pot: Number(r.pot), toCall: Number(r.to_call), minRaiseTo: Number(r.min_raise_to),
      bigBlind: Number(r.big_blind), action: r.action, amount: Number(r.amount),
    }));
  }

  async twin(playerId: string): Promise<Twin & { tags: string[] }> {
    const t = fitTwin(await this.decisions(playerId));
    return { ...t, tags: tags(t.profile) };
  }

  /** Stats, leaks and advice; with a Claude note when the backend has a key (cached 10 minutes per player). */
  async coach(playerId: string): Promise<Report & { note: string | null }> {
    const cached = this.noteCache.get(playerId);
    if (cached && this.clock().getTime() - cached.at < 10 * 60_000) return cached.report;
    const ds = await this.decisions(playerId, 2000);
    const { rows } = await this.pool.query(
      `SELECT * FROM style_hands WHERE player_id = $1 ORDER BY created_at DESC LIMIT 500`, [playerId]);
    const hands: HandResult[] = rows.map((r) => ({ table: r.table_name, handNo: r.hand_no, position: r.position, bigBlind: Number(r.big_blind), net: Number(r.net), showdown: r.showdown, won: r.won }));
    const report = coach(ds, hands);
    const note = await claudeNote(report);
    const out = { ...report, note };
    this.noteCache.set(playerId, { at: this.clock().getTime(), report: out });
    return out;
  }

  // ---------------------------------------------------------------- marketplace

  /** Publishes a frozen strategy: from the creator's twin, or a custom profile. Re-publishing a name adds a version. */
  async publish(creatorId: string, body: any) {
    const name = String(body?.name ?? "").trim().slice(0, 40);
    if (name.length < 3) throw new StrategyError(400, "bad_name", "Give your strategy a name (3–40 letters).");
    const description = String(body?.description ?? "").trim().slice(0, 280);
    let profile: Profile, source: "custom" | "twin";
    if (body?.fromTwin) {
      const t = await this.twin(creatorId);
      if (t.decisions < MIN_TWIN_DECISIONS_TO_PUBLISH)
        throw new StrategyError(400, "twin_too_small", `Play a few more hands first: your twin has ${t.decisions} of ${MIN_TWIN_DECISIONS_TO_PUBLISH} decisions.`);
      profile = t.profile; source = "twin";
    } else {
      try { profile = clampProfile(body?.profile ?? {}); } catch (e: any) { throw new StrategyError(400, "bad_profile", e.message); }
      source = "custom";
    }
    // A strategy that plays like one already listed by someone else isn't a new strategy (review 20 Oct: without this
    // the list fills with near-copies of whatever ranks first). Its own earlier versions don't count.
    const mine = behaviour(profile as any);
    for (const other of await this.records(`s.listed AND s.creator_id <> $1`, [creatorId])) {
      if (other.qualified && alike(mine, other.behaviour))
        throw new StrategyError(409, "too_similar",
          `That plays like "${other.name}" by ${other.creatorName}, which is already listed. Change how many hands it plays, its pressure, bluffing or bet size.`);
    }
    const { rows: who } = await this.pool.query(`SELECT display_name FROM pf_players WHERE playfab_id = $1`, [creatorId]);
    const creatorName = String(who[0]?.display_name ?? `Player ${creatorId.slice(-4)}`);
    const { rows: prev } = await this.pool.query(
      `SELECT COALESCE(MAX(version), 0) AS v FROM strategies WHERE creator_id = $1 AND name = $2`, [creatorId, name]);
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO strategies (strategy_id, creator_id, creator_name, name, description, version, profile, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, creatorId, creatorName, name, description, Number(prev[0].v) + 1, JSON.stringify(profile), source]);
    if (Number(prev[0].v) > 0) // older versions leave the listing; their copiers keep them
      await this.pool.query(`UPDATE strategies SET listed = FALSE WHERE creator_id = $1 AND name = $2 AND strategy_id <> $3`, [creatorId, name, id]);
    return this.get(id);
  }

  async unlist(creatorId: string, strategyId: string) {
    const r = await this.pool.query(`UPDATE strategies SET listed = FALSE WHERE strategy_id = $1 AND creator_id = $2`, [strategyId, creatorId]);
    if (!r.rowCount) throw new StrategyError(404, "not_found", "Not your strategy.");
  }

  /**
   * The marketplace lists (review 20 Oct):
   * - "top": qualified strategies by score (risk-adjusted, see toPublic);
   * - "styles": the best qualified strategy of each style cell (hands played x pressure), so every style shows;
   * - "new": New and promising: under 30 days old with at least 300 hands, by score, qualified or not (it says which);
   * - "popular": qualified strategies by copiers.
   * `style` keeps one cell ("Loose Aggressive"...). `room` ranks by the record at one table type (mixed, tight, loose,
   * wild): strategies with at least 300 hands there, its numbers in `record`.
   */
  async list(sort = "top", limit = 30, style?: string, room?: string) {
    let all = await this.records(`s.listed`, []);
    if (style) all = all.filter((x) => x.style === style);
    if (room && (AGENT_ROOMS as readonly string[]).includes(room))
      all = all.filter((x) => x.byRoom[room as AgentRoom].hands >= NEW_MIN_HANDS)
        .map((x) => ({ ...x, room, record: { ...x.record, ...x.byRoom[room as AgentRoom] } }));
    const byScore = (a: any, b: any) => (b.record.score ?? -1e9) - (a.record.score ?? -1e9);
    const n = Math.min(100, Math.max(1, limit));
    if (sort === "new") {
      const since = this.clock().getTime() - NEW_DAYS * 86_400_000;
      return all.filter((x) => new Date(x.createdAt).getTime() >= since && x.record.hands >= NEW_MIN_HANDS).sort(byScore).slice(0, n);
    }
    const qualified = all.filter((x) => x.qualified);
    if (sort === "popular") return qualified.sort((a, b) => b.record.copiers - a.record.copiers || byScore(a, b)).slice(0, n);
    if (sort === "styles") {
      const best = new Map<string, any>();
      for (const x of qualified.sort(byScore)) if (!best.has(x.style)) best.set(x.style, x);
      return [...best.values()].slice(0, n);
    }
    return qualified.sort(byScore).slice(0, n);
  }

  async get(strategyId: string) {
    const rows = await this.records(`s.strategy_id = $1`, [strategyId]);
    if (!rows[0]) throw new StrategyError(404, "not_found", "That strategy doesn't exist.");
    const s = rows[0];
    // The listed strategies that play most like it (so a copier can compare).
    const others = (await this.records(`s.listed AND s.strategy_id <> $1`, [strategyId]))
      .map((o) => ({ o, d: distance(s.behaviour, o.behaviour) }))
      .filter((x) => x.d <= 2).sort((a, b) => a.d - b.d).slice(0, 3)
      .map(({ o }) => ({ strategyId: o.strategyId, name: o.name, creatorName: o.creatorName, style: o.style, record: o.record }));
    return { ...s, similar: others };
  }

  /** The creator's dashboard: their strategies and what copiers earned them. */
  async creatorDashboard(creatorId: string) {
    const mine = (await this.records(`s.creator_id = $1`, [creatorId])).sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    const { rows: fees } = await this.pool.query(
      `SELECT COALESCE(SUM(creator_fee), 0)::bigint AS earned,
              COALESCE(SUM(creator_fee) FILTER (WHERE creator_paid), 0)::bigint AS paid,
              COUNT(*)::int AS settlements
         FROM copy_fees WHERE creator_id = $1`, [creatorId]);
    return { strategies: mine, earned: Number(fees[0].earned), paid: Number(fees[0].paid), settlements: fees[0].settlements };
  }

  /** Strategies matching `where` (on s.*) with their track record, in public form. */
  private async records(where: string, params: unknown[]) {
    const { rows } = await this.pool.query(
      `SELECT s.*, ${TRACK_RECORD_SQL}
         FROM strategies s
         LEFT JOIN agent_deployments d ON d.strategy_id = s.strategy_id AND d.phase IN ('completed', 'failed')
         LEFT JOIN agent_hands h ON h.deployment_id = d.deployment_id
        WHERE ${where}
        GROUP BY s.strategy_id`, params);
    const now = this.clock();
    return rows.map((r: any) => toPublic(r, now));
  }

  /** The profile a copied Agent plays, and marks the deployment as copying it (the copier is the signed-in player). */
  async attachCopy(deploymentId: string, copierId: string, strategyId: string): Promise<Profile> {
    const s = await this.get(strategyId);
    // Others may copy only a listed strategy with a proven record; its creator may always run it (that builds the record).
    if (s.creatorId !== copierId && (!s.listed || !s.qualified))
      throw new StrategyError(403, "not_listed",
        `That strategy can't be copied yet: it needs ${LISTING.minHands.toLocaleString("en-US")} hands over ${LISTING.minDays} days and a result that beats Autopilot.`);
    await this.pool.query(
      `UPDATE agent_deployments SET strategy_id = $2, copier_verified = TRUE WHERE deployment_id = $1 AND owner_id = $3`,
      [deploymentId, strategyId, copierId]);
    return s.profile;
  }

  /**
   * Settles a finished copied session once (idempotent on the deployment): high-water-mark profit share, then pays the
   * creator's 8% into their Coins. The copier's client keeps the session result minus the fees (see result()).
   */
  async settle(deploymentId: string) {
    const client = await this.pool.connect();
    let fee: any = null;
    try {
      await client.query("BEGIN");
      const { rows: d } = await client.query(
        `SELECT d.deployment_id, d.owner_id, d.net_pnl, d.phase, d.strategy_id, d.copier_verified, s.creator_id
           FROM agent_deployments d JOIN strategies s ON s.strategy_id = d.strategy_id
          WHERE d.deployment_id = $1 FOR UPDATE OF d`, [deploymentId]);
      const row = d[0];
      if (!row || row.phase !== "completed" || !row.copier_verified || row.creator_id === row.owner_id) { await client.query("ROLLBACK"); return null; }
      const { rows: done } = await client.query(`SELECT * FROM copy_fees WHERE deployment_id = $1`, [deploymentId]);
      if (done[0]) { await client.query("COMMIT"); fee = done[0]; }
      else {
        await client.query(
          `INSERT INTO copy_positions (copier_id, strategy_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [row.owner_id, row.strategy_id]);
        const { rows: p } = await client.query(
          `SELECT cumulative_pnl, high_water FROM copy_positions WHERE copier_id = $1 AND strategy_id = $2 FOR UPDATE`, [row.owner_id, row.strategy_id]);
        const s = settleCopy({ cumulativePnl: Number(p[0].cumulative_pnl), highWater: Number(p[0].high_water) }, Number(row.net_pnl));
        await client.query(
          `UPDATE copy_positions SET cumulative_pnl = $3, high_water = $4, updated_at = NOW() WHERE copier_id = $1 AND strategy_id = $2`,
          [row.owner_id, row.strategy_id, s.next.cumulativePnl, s.next.highWater]);
        const { rows: ins } = await client.query(
          `INSERT INTO copy_fees (deployment_id, strategy_id, copier_id, creator_id, session_pnl, fee_base, creator_fee, platform_fee, creator_paid)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [deploymentId, row.strategy_id, row.owner_id, row.creator_id, s.sessionPnl, s.feeBase, s.creatorFee, s.platformFee, s.creatorFee === 0]);
        await client.query("COMMIT");
        fee = ins[0];
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (fee && !fee.creator_paid) await this.payCreator(fee);
    return fee;
  }

  /** Pays a settlement's creator fee into the creator's Coins (PlayFab dedupes on the deployment id). */
  async payCreator(fee: any) {
    if (!this.playfab) return;
    const { rows } = await this.pool.query(`SELECT title_player_account_id FROM pf_players WHERE playfab_id = $1`, [fee.creator_id]);
    const account = rows[0]?.title_player_account_id;
    if (!account) { await this.markPay(fee.deployment_id, false, "creator has no PlayFab account on file yet"); return; }
    try {
      await this.playfab.addChips(account, Number(fee.creator_fee), idempotencyIdFor(`copyfee|${fee.deployment_id}`));
      await this.markPay(fee.deployment_id, true, null);
    } catch (e) {
      await this.markPay(fee.deployment_id, false, e instanceof PlayFabError ? `${e.code}: ${e.message}` : String(e));
    }
  }

  private async markPay(deploymentId: string, paid: boolean, error: string | null) {
    await this.pool.query(`UPDATE copy_fees SET creator_paid = $2, pay_error = $3 WHERE deployment_id = $1`, [deploymentId, paid, error]);
  }

  /** Retries creator payouts that failed (PlayFab busy, creator not yet seen). */
  async retryPayouts() {
    const { rows } = await this.pool.query(`SELECT * FROM copy_fees WHERE NOT creator_paid AND creator_fee > 0 ORDER BY created_at LIMIT 50`);
    for (const f of rows) await this.payCreator(f);
    return rows.length;
  }

  /**
   * The copier's view of a settlement: what the creator and Nomad took. A copied session with no fee due (your own
   * strategy) says so with zeros; a settlement still owed returns null, so the client waits instead of paying nothing.
   */
  async feeFor(deploymentId: string) {
    const { rows } = await this.pool.query(`SELECT * FROM copy_fees WHERE deployment_id = $1`, [deploymentId]);
    const f = rows[0];
    if (f) return { strategyId: f.strategy_id, sessionPnl: Number(f.session_pnl), creatorFee: Number(f.creator_fee), platformFee: Number(f.platform_fee), feeBase: Number(f.fee_base) };
    const { rows: d } = await this.pool.query(
      `SELECT d.strategy_id, d.net_pnl, d.phase, d.owner_id, d.copier_verified, s.creator_id
         FROM agent_deployments d LEFT JOIN strategies s ON s.strategy_id = d.strategy_id WHERE d.deployment_id = $1`, [deploymentId]);
    const row = d[0];
    if (!row?.strategy_id || !["completed", "failed"].includes(row.phase)) return null;
    if (row.phase === "failed" || row.creator_id === row.owner_id || !row.copier_verified)
      return { strategyId: row.strategy_id, sessionPnl: Number(row.net_pnl), creatorFee: 0, platformFee: 0, feeBase: 0 };
    return null;
  }
}

// Track record of a strategy (review 20 Oct): every hand its Agents played (sessions that were stopped or failed
// included, so a creator can't hide the bad ones), in big blinds, so stakes don't decide the ranking.
/** What a strategy needs before others can copy it: hands, days since it was published, and a win rate that beats the
 *  house's Autopilot by more than its standard error. LISTING_MIN_HANDS / LISTING_MIN_DAYS change the first two. */
export const LISTING = {
  minHands: Number(process.env.LISTING_MIN_HANDS ?? 2000),
  minDays: Number(process.env.LISTING_MIN_DAYS ?? 7),
};
/** Autopilot's win rate at each Coins table type, big blinds per 100 hands (docs/AGENTS_V2.md section 10, measured
 *  against BotProfile.ForRoom fillers); HOUSE_BB100 overrides the mixed one once real Autopilot records exist. A
 *  strategy's bar is these weighted by where its hands were played, so the table types it happened to get don't
 *  decide whether it beats Autopilot. */
export const HOUSE_BY_ROOM: Record<AgentRoom, number> = {
  mixed: Number(process.env.HOUSE_BB100 ?? 371), tight: 312, loose: 757, wild: 378,
};
export const HOUSE_BB100 = HOUSE_BY_ROOM.mixed;
/** New and promising: younger than this, with at least this many hands. */
const NEW_DAYS = 30, NEW_MIN_HANDS = 300;
/** Hands at which the score counts for half (it's shrunk toward zero below that). */
const SCORE_HALF_HANDS = 2000;

/** The stake's big blind (StakeCatalog.cs tiers), else buy-in / 20. */
const BB_SQL = `CASE d.stake WHEN 50 THEN 2 WHEN 100 THEN 5 WHEN 500 THEN 25 WHEN 1000 THEN 50 WHEN 5000 THEN 250 WHEN 10000 THEN 500 ELSE GREATEST(1, d.stake / 20) END`;

const TRACK_RECORD_SQL = `
  COUNT(DISTINCT d.owner_id)::int AS copiers,
  COUNT(DISTINCT d.deployment_id)::int AS sessions,
  COUNT(h.id)::bigint AS hands,
  COALESCE(SUM(h.net_pnl), 0)::bigint AS net,
  AVG(h.net_pnl::float8 / (${BB_SQL})) AS mean_bb,
  STDDEV_SAMP(h.net_pnl::float8 / (${BB_SQL})) AS sd_bb,
  ${AGENT_ROOMS.map((r) => `
  COUNT(h.id) FILTER (WHERE d.room = '${r}')::bigint AS ${r}_hands,
  AVG(h.net_pnl::float8 / (${BB_SQL})) FILTER (WHERE d.room = '${r}') AS ${r}_mean,
  STDDEV_SAMP(h.net_pnl::float8 / (${BB_SQL})) FILTER (WHERE d.room = '${r}') AS ${r}_sd`).join(",")}`;

/** A record from hand count, mean and standard deviation in big blinds, against `house` bb/100. */
function stats(hands: number, mean: number, sd: number, house: number) {
  const bb100 = mean * 100, se100 = hands > 1 ? (sd / Math.sqrt(hands)) * 100 : Infinity;
  // Score: win rate per unit of swing (a copier with a stop loss lives the swings, not the average), counted fully
  // only with enough hands.
  const score = hands > 1 && sd > 0 ? (mean / sd) * (hands / (hands + SCORE_HALF_HANDS)) : null;
  return { hands, bb100, se100, sd, score, vsHouse: bb100 - house };
}
const rounded = (x: ReturnType<typeof stats>, house: number) => ({
  hands: x.hands, bb100: Math.round(x.bb100), se100: Number.isFinite(x.se100) ? Math.round(x.se100) : null,
  swing: Math.round(x.sd * 10) / 10, vsHouse: Math.round(x.vsHouse), house: Math.round(house),
  score: x.score == null ? null : Math.round(x.score * 1000) / 1000,
});

function toPublic(r: any, now: Date) {
  const profile = (typeof r.profile === "string" ? JSON.parse(r.profile) : r.profile) as Profile;
  const hands = Number(r.hands ?? 0);
  const num = (x: unknown) => (x == null ? 0 : Number(x));
  const byRoom = Object.fromEntries(AGENT_ROOMS.map((room) => [room,
    rounded(stats(num(r[`${room}_hands`]), num(r[`${room}_mean`]), num(r[`${room}_sd`]), HOUSE_BY_ROOM[room]), HOUSE_BY_ROOM[room])])) as
    Record<AgentRoom, ReturnType<typeof rounded>>;
  // Autopilot's expected result at the same mix of table types.
  const house = hands > 0 ? AGENT_ROOMS.reduce((t, room) => t + byRoom[room].hands * HOUSE_BY_ROOM[room], 0) / hands : HOUSE_BB100;
  const all = stats(hands, num(r.mean_bb), num(r.sd_bb), house);
  const { bb100, se100, sd, score, vsHouse } = all;
  const ageDays = (now.getTime() - new Date(r.created_at).getTime()) / 86_400_000;
  const b: Behaviour = behaviour(profile as any);
  return {
    strategyId: r.strategy_id, name: r.name, description: r.description, version: r.version,
    creatorId: r.creator_id, creatorName: r.creator_name, source: r.source, listed: r.listed,
    profile, tags: tags(profile), behaviour: b, style: styleCell(b),
    record: {
      copiers: Number(r.copiers ?? 0), sessions: Number(r.sessions ?? 0), hands, net: Number(r.net ?? 0),
      per100Hands: hands ? Math.round((Number(r.net) * 100) / hands) : 0,
      bb100: Math.round(bb100), se100: Number.isFinite(se100) ? Math.round(se100) : null, swing: Math.round(sd * 10) / 10,
      vsHouse: Math.round(vsHouse), house: Math.round(house), score: score == null ? null : Math.round(score * 1000) / 1000,
    },
    byRoom,
    verified: hands >= LISTING.minHands,
    qualified: hands >= LISTING.minHands && ageDays >= LISTING.minDays && Number.isFinite(se100) && vsHouse > se100,
    listing: { minHands: LISTING.minHands, minDays: LISTING.minDays, house: Math.round(house) },
    fees: { creatorPercent: 8, platformPercent: 2 },
    createdAt: r.created_at,
  };
}

export { PRESETS };
