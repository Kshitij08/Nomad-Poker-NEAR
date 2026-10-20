import type { Pool } from "pg";
import { PlayFabError, idempotencyIdFor, type PlayFabEconomy } from "./playfab.js";

/**
 * Coins Agents' bankroll on the server (review A2/H2; migrations/007_agent_money.sql).
 *
 * - fund(): before an Agent is queued, its bankroll leaves the owner's PlayFab Coins. A short balance refuses the
 *   deployment; PlayFab being busy leaves the debit pending and the start is refused ("try again"); a debit that
 *   lands for a deployment that never got queued is refunded by the worker.
 * - settle(): when a funded deployment has ended (completed, failed, stopped while queued), its ending stack minus a
 *   copied strategy's profit share goes back to the owner's Coins. Copied sessions wait for their fee settlement.
 * - runDue(): retries pending moves (credits never give up), settles ended deployments, refunds orphaned debits.
 *
 * Every move is an agent_money row with a deterministic key; PlayFab dedupes on the IdempotencyId derived from it, so
 * a retry after a timeout or a crash moves Coins once.
 */
export type AgentMoneyKind = "bankroll_debit" | "return_credit" | "refund_credit";
export type AgentMoveState = "pending" | "done" | "failed";

const LEASE_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** A debit that landed but whose deployment never got queued (a crash in between) is refunded after this long. */
const ORPHAN_MS = 10 * 60_000;

export class AgentMoneyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export const debitKey = (deploymentId: string) => `agent:${deploymentId}:bankroll`;
export const returnKey = (deploymentId: string) => `agent:${deploymentId}:return`;
export const refundKey = (deploymentId: string) => `agent:${deploymentId}:refund`;

export class AgentMoneyService {
  constructor(
    private readonly pool: Pool,
    private readonly playfab: PlayFabEconomy | null,
    private readonly clock: () => Date = () => new Date()
  ) {}

  get enabled() {
    return this.playfab != null;
  }

  /**
   * Takes the bankroll from the owner's Coins. Resolves when it's taken; throws AgentMoneyError when it can't be
   * (402 not enough Coins, 503 PlayFab busy or not configured, 401 the owner has never signed in here).
   */
  async fund(deploymentId: string, playFabId: string, bankroll: number): Promise<void> {
    if (!this.playfab) throw new AgentMoneyError(503, "coins_unavailable", "Coins aren't available right now. Try again later.");
    if (!Number.isSafeInteger(bankroll) || bankroll <= 0) throw new AgentMoneyError(400, "bad_bankroll", "Bad bankroll.");
    const id = await this.enqueue(deploymentId, playFabId, "bankroll_debit", bankroll, debitKey(deploymentId));
    const state = await this.run(id);
    if (state === "done") return;
    if (state === "failed") {
      const { rows } = await this.pool.query(`SELECT last_error FROM agent_money WHERE id = $1`, [id]);
      const code = String(rows[0]?.last_error ?? "");
      if (code.startsWith("InsufficientFunds"))
        throw new AgentMoneyError(402, "insufficient_coins", "Not enough Coins for that bankroll.");
      if (code.startsWith("NoAccount"))
        throw new AgentMoneyError(401, "sign_in", "Sign in again to deploy your Agent.");
      throw new AgentMoneyError(400, "debit_refused", "Your Coins couldn't be charged for the bankroll.");
    }
    throw new AgentMoneyError(503, "coins_busy", "Coins are busy right now. Try again in a moment.");
  }

  /** The Agent's queueing failed after its bankroll was taken: give it back now. */
  async refund(deploymentId: string): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT playfab_id, amount FROM agent_money WHERE idempotency_key = $1 AND state = 'done'`, [debitKey(deploymentId)]);
    if (!rows[0]) return;
    const id = await this.enqueue(deploymentId, rows[0].playfab_id, "refund_credit", Number(rows[0].amount), refundKey(deploymentId));
    await this.run(id);
  }

  /**
   * Pays an ended, funded deployment's stack back (once). Returns the amount owed (0 when there's nothing), or null
   * when it can't be settled yet (still running, or a copied strategy's fee isn't settled).
   */
  async settle(deploymentId: string): Promise<number | null> {
    const { rows } = await this.pool.query(
      `SELECT d.deployment_id, d.owner_id, d.phase, d.stack, d.funded, d.strategy_id, d.copier_verified, s.creator_id,
              f.creator_fee, f.platform_fee, f.deployment_id AS fee_row
         FROM agent_deployments d
         LEFT JOIN strategies s ON s.strategy_id = d.strategy_id
         LEFT JOIN copy_fees f ON f.deployment_id = d.deployment_id
        WHERE d.deployment_id = $1`, [deploymentId]);
    const d = rows[0];
    if (!d || !d.funded) return 0;
    if (d.phase !== "completed" && d.phase !== "failed") return null;
    // A copied session pays its creator 8% and Nomad 2% of new profit: return the stack only once that's settled.
    const owesFee = d.strategy_id && d.copier_verified && d.creator_id && d.creator_id !== d.owner_id && d.phase === "completed";
    if (owesFee && !d.fee_row) return null;
    const fees = d.fee_row ? Math.max(0, Number(d.creator_fee)) + Math.max(0, Number(d.platform_fee)) : 0;
    const owed = Math.max(0, Number(d.stack) - fees);
    if (owed > 0) {
      const id = await this.enqueue(deploymentId, String(d.owner_id), "return_credit", owed, returnKey(deploymentId));
      await this.run(id);
    }
    return owed;
  }

  /** Worker pass: pending moves that are due, ended deployments not yet paid back, and orphaned debits. */
  async runDue(limit = 25): Promise<number> {
    const now = this.clock();
    let n = 0;
    const due = await this.pool.query(
      `SELECT id FROM agent_money WHERE state = 'pending' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT $2`, [now, limit]);
    for (const r of due.rows) { await this.run(Number(r.id)); n++; }
    const ended = await this.pool.query(
      `SELECT d.deployment_id FROM agent_deployments d
        WHERE d.funded AND d.phase IN ('completed', 'failed')
          AND NOT EXISTS (SELECT 1 FROM agent_money m WHERE m.idempotency_key = 'agent:' || d.deployment_id || ':return')
        ORDER BY d.completed_at NULLS FIRST LIMIT $1`, [limit]);
    for (const r of ended.rows) {
      try { await this.settle(String(r.deployment_id)); n++; }
      catch (e: any) { console.warn(`[agent-money] settle ${r.deployment_id}: ${e?.message ?? e}`); }
    }
    const orphans = await this.pool.query(
      `SELECT m.deployment_id FROM agent_money m
        WHERE m.kind = 'bankroll_debit' AND m.state = 'done' AND m.done_at < $1
          AND NOT EXISTS (SELECT 1 FROM agent_deployments d WHERE d.deployment_id = m.deployment_id)
          AND NOT EXISTS (SELECT 1 FROM agent_money r WHERE r.idempotency_key = 'agent:' || m.deployment_id || ':refund')
        LIMIT $2`, [new Date(now.getTime() - ORPHAN_MS), limit]);
    for (const r of orphans.rows) { await this.refund(String(r.deployment_id)); n++; }
    return n;
  }

  /** What the backend took and paid back for a deployment (for the owner's screens). */
  async summary(deploymentId: string) {
    const { rows } = await this.pool.query(
      `SELECT kind, amount, state FROM agent_money WHERE deployment_id = $1 ORDER BY id`, [deploymentId]);
    const sum = (kind: AgentMoneyKind, state?: AgentMoveState) =>
      rows.filter((r) => r.kind === kind && (!state || r.state === state)).reduce((s, r) => s + Number(r.amount), 0);
    return {
      taken: sum("bankroll_debit", "done"),
      returned: sum("return_credit", "done") + sum("refund_credit", "done"),
      returnPending: sum("return_credit", "pending") + sum("refund_credit", "pending"),
    };
  }

  // ------------------------------------------------------------------------------------------------ moves

  private async enqueue(deploymentId: string, playFabId: string, kind: AgentMoneyKind, amount: number, key: string): Promise<number> {
    const now = this.clock();
    const inserted = await this.pool.query(
      `INSERT INTO agent_money (deployment_id, playfab_id, kind, amount, idempotency_key, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [deploymentId, playFabId, kind, amount, key, now]);
    if (inserted.rows[0]) return Number(inserted.rows[0].id);
    const existing = await this.pool.query(`SELECT id FROM agent_money WHERE idempotency_key = $1`, [key]);
    return Number(existing.rows[0].id);
  }

  /** Runs one move if it's due and nobody else holds it; returns its state afterwards. */
  private async run(moveId: number): Promise<AgentMoveState> {
    const now = this.clock();
    const leased = await this.pool.query(
      `UPDATE agent_money SET attempts = attempts + 1, next_attempt_at = $2, updated_at = $3
        WHERE id = $1 AND state = 'pending' AND next_attempt_at <= $3 RETURNING *`,
      [moveId, new Date(now.getTime() + LEASE_MS), now]);
    if (!leased.rows[0]) {
      const cur = await this.pool.query(`SELECT state FROM agent_money WHERE id = $1`, [moveId]);
      return (cur.rows[0]?.state ?? "pending") as AgentMoveState;
    }
    const move = leased.rows[0];
    const debit = move.kind === "bankroll_debit";
    if (!this.playfab) { await this.retryLater(move, "PlayFab is not configured"); return "pending"; }
    const { rows: p } = await this.pool.query(`SELECT title_player_account_id FROM pf_players WHERE playfab_id = $1`, [move.playfab_id]);
    const tpa = p[0]?.title_player_account_id;
    if (!tpa) {
      // The owner signed in (their token says so) but this backend has no PlayFab account on file for them: a debit
      // can't go ahead; a credit waits until they sign in again.
      if (debit) { await this.finish(move, "failed", "NoAccount: no title player account on file"); return "failed"; }
      await this.retryLater(move, `No title player account recorded for ${move.playfab_id}`);
      return "pending";
    }
    try {
      const idem = idempotencyIdFor(move.idempotency_key);
      if (debit) await this.playfab.subtractChips(tpa, Number(move.amount), idem);
      else await this.playfab.addChips(tpa, Number(move.amount), idem);
    } catch (err) {
      const e = err instanceof PlayFabError ? err : new PlayFabError(String(err), "Unknown", false);
      if (debit && e.final) { await this.finish(move, "failed", `${e.code}: ${e.message}`); return "failed"; }
      if (!debit && e.final) console.error(`[agent-money] credit ${move.idempotency_key} refused (${e.code}); will keep retrying.`);
      // A pending move is what turns a start into "Coins are busy": say what PlayFab answered.
      else console.warn(`[agent-money] ${move.kind} ${move.idempotency_key} attempt ${move.attempts} pending: ${e.code}: ${e.message}`);
      await this.retryLater(move, `${e.code}: ${e.message}`);
      return "pending";
    }
    await this.finish(move, "done", null);
    return "done";
  }

  private async finish(move: any, state: "done" | "failed", error: string | null) {
    const now = this.clock();
    await this.pool.query(
      `UPDATE agent_money SET state = $2, last_error = $3, done_at = $4, updated_at = $4 WHERE id = $1 AND state = 'pending'`,
      [move.id, state, error?.slice(0, 500) ?? null, now]);
  }

  private async retryLater(move: any, error: string) {
    const attempts = Number(move.attempts);
    const backoff = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.min(attempts, 10));
    await this.pool.query(
      `UPDATE agent_money SET last_error = $2, next_attempt_at = $3, updated_at = $4 WHERE id = $1 AND state = 'pending'`,
      [move.id, error.slice(0, 500), new Date(this.clock().getTime() + backoff), this.clock()]);
  }
}
