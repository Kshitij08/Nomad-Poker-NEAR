// Agents v2 (docs/AGENTS_V2.md): playstyle records, "My Twin", coaching, and the Coins copy-strategy marketplace
// with its profit share (8% of new profit to the creator, 2% to Nomad, high-water mark per copier and strategy).
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { idempotencyIdFor, PlayFabError, type PlayFabEconomy } from "../services/playfab.js";
import { claudeNote, coach, type HandResult, type Report } from "./coach.js";
import { settleCopy } from "./fees.js";
import { clampProfile, PRESETS, tags, type Profile } from "./profile.js";
import { fitTwin, type Action, type Decision, type Twin } from "./style.js";

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

  /** Listed strategies with their track record (Agent sessions that ran them), best first. */
  async list(sort = "top", limit = 30) {
    const order = sort === "new" ? "s.created_at DESC" : sort === "popular" ? "copiers DESC, s.created_at DESC" : "score DESC NULLS LAST, s.created_at DESC";
    const { rows } = await this.pool.query(
      `SELECT s.*, ${TRACK_RECORD_SQL}
         FROM strategies s
         LEFT JOIN agent_deployments d ON d.strategy_id = s.strategy_id AND d.phase = 'completed'
        WHERE s.listed
        GROUP BY s.strategy_id
        ORDER BY ${order}
        LIMIT $1`, [Math.min(100, Math.max(1, limit))]);
    return rows.map(toPublic);
  }

  async get(strategyId: string) {
    const { rows } = await this.pool.query(
      `SELECT s.*, ${TRACK_RECORD_SQL}
         FROM strategies s
         LEFT JOIN agent_deployments d ON d.strategy_id = s.strategy_id AND d.phase = 'completed'
        WHERE s.strategy_id = $1
        GROUP BY s.strategy_id`, [strategyId]);
    if (!rows[0]) throw new StrategyError(404, "not_found", "That strategy doesn't exist.");
    return toPublic(rows[0]);
  }

  /** The creator's dashboard: their strategies and what copiers earned them. */
  async creatorDashboard(creatorId: string) {
    const { rows: mine } = await this.pool.query(
      `SELECT s.*, ${TRACK_RECORD_SQL}
         FROM strategies s
         LEFT JOIN agent_deployments d ON d.strategy_id = s.strategy_id AND d.phase = 'completed'
        WHERE s.creator_id = $1
        GROUP BY s.strategy_id ORDER BY s.created_at DESC`, [creatorId]);
    const { rows: fees } = await this.pool.query(
      `SELECT COALESCE(SUM(creator_fee), 0)::bigint AS earned,
              COALESCE(SUM(creator_fee) FILTER (WHERE creator_paid), 0)::bigint AS paid,
              COUNT(*)::int AS settlements
         FROM copy_fees WHERE creator_id = $1`, [creatorId]);
    return { strategies: mine.map(toPublic), earned: Number(fees[0].earned), paid: Number(fees[0].paid), settlements: fees[0].settlements };
  }

  /** The profile a copied Agent plays, and marks the deployment as copying it (the copier is the signed-in player). */
  async attachCopy(deploymentId: string, copierId: string, strategyId: string): Promise<Profile> {
    const s = await this.get(strategyId);
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

// Track record of a strategy: completed Agent sessions that ran it (not self-reported). Score = profit per 100 hands,
// shrunk toward zero while the sample is small.
const TRACK_RECORD_SQL = `
  COUNT(DISTINCT d.owner_id)::int AS copiers,
  COUNT(d.deployment_id)::int AS sessions,
  COALESCE(SUM(d.hands_played), 0)::bigint AS hands,
  COALESCE(SUM(d.net_pnl), 0)::bigint AS net,
  CASE WHEN COALESCE(SUM(d.hands_played), 0) = 0 THEN NULL
       ELSE (SUM(d.net_pnl)::float8 * 100 / SUM(d.hands_played)) * (SUM(d.hands_played)::float8 / (SUM(d.hands_played) + 500)) END AS score`;

function toPublic(r: any) {
  const profile = typeof r.profile === "string" ? JSON.parse(r.profile) : r.profile;
  const hands = Number(r.hands ?? 0);
  return {
    strategyId: r.strategy_id, name: r.name, description: r.description, version: r.version,
    creatorId: r.creator_id, creatorName: r.creator_name, source: r.source, listed: r.listed,
    profile: profile as Profile, tags: tags(profile),
    record: { copiers: Number(r.copiers ?? 0), sessions: Number(r.sessions ?? 0), hands, net: Number(r.net ?? 0), per100Hands: hands ? Math.round((Number(r.net) * 100) / hands) : 0 },
    verified: hands >= 2000,
    fees: { creatorPercent: 8, platformPercent: 2 },
    createdAt: r.created_at,
  };
}

export { PRESETS };
