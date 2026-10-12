import type { Pool, PoolClient } from "pg";
import { PlayFabError, idempotencyIdFor, type PlayFabEconomy } from "../services/playfab.js";

/**
 * Every chip a tournament moves goes through here.
 *
 * A move is written as a pending money_moves row in the same transaction as the record change it pays
 * for (an entry, a cancellation, a result), then run against PlayFab. Running takes a 30-second lease
 * on the row first, so two processes never send the same move at once, and the PlayFab call carries an
 * IdempotencyId derived from the row's key, so a retry after a crash or a timeout moves the chips once.
 *
 * Debits can fail for good (not enough chips): the entry is rejected or the host's tournament is not
 * funded. Credits — refunds and prizes — never give up; they back off and keep trying until PlayFab
 * takes them.
 */

export type MoneyKind = "host_prize_debit" | "prize_raise_debit" | "entry_debit" | "refund" | "payout";
export type MoveOutcome = "done" | "failed" | "pending";

const DEBITS = new Set<MoneyKind>(["host_prize_debit", "prize_raise_debit", "entry_debit"]);
const LEASE_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface NewMove {
  tournamentId: string;
  entryId?: number | null;
  playFabId: string;
  kind: MoneyKind;
  amount: number;
  key: string;
}

export function entryDebitKey(tournamentId: string, playFabId: string, attempt: number): string {
  return `trn:${tournamentId}:entry:${playFabId}:${attempt}:debit`;
}

export function refundKey(debitKey: string): string {
  return `${debitKey}:refund`;
}

/**
 * Inside the caller's transaction: records a move and returns its id, or null for a zero amount.
 * Recording the same key twice returns the first move — which is what makes a refund safe to
 * request from every path that might need one.
 */
export async function enqueueMove(client: PoolClient, move: NewMove, now: Date): Promise<number | null> {
  if (!Number.isSafeInteger(move.amount) || move.amount <= 0) return null;
  const inserted = await client.query(
    `INSERT INTO money_moves
       (tournament_id, entry_id, playfab_id, kind, amount, idempotency_key, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [move.tournamentId, move.entryId ?? null, move.playFabId, move.kind, move.amount, move.key, now]
  );
  if (inserted.rowCount) return Number(inserted.rows[0].id);
  const existing = await client.query(`SELECT id FROM money_moves WHERE idempotency_key = $1`, [move.key]);
  return Number(existing.rows[0].id);
}

export class MoneyService {
  constructor(
    private readonly pool: Pool,
    private readonly playfab: PlayFabEconomy | null,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** Runs one move if it is due and nobody else holds it, then any refunds its outcome calls for. */
  async run(moveId: number): Promise<MoveOutcome> {
    const outcome = await this.runOne(moveId);
    return outcome.state;
  }

  async runAll(moveIds: (number | null | undefined)[]): Promise<void> {
    for (const id of moveIds) if (id) await this.run(id);
  }

  /** Worker pass: everything pending whose retry time has come. */
  async runDue(limit = 25): Promise<number> {
    const due = await this.pool.query(
      `SELECT id FROM money_moves WHERE state = 'pending' AND next_attempt_at <= $1
       ORDER BY next_attempt_at LIMIT $2`,
      [this.clock(), limit]
    );
    for (const row of due.rows) await this.run(Number(row.id));
    return due.rowCount ?? 0;
  }

  private async runOne(moveId: number): Promise<{ state: MoveOutcome }> {
    const now = this.clock();
    const leased = await this.pool.query(
      `UPDATE money_moves SET attempts = attempts + 1, next_attempt_at = $2, updated_at = $3
       WHERE id = $1 AND state = 'pending' AND next_attempt_at <= $3
       RETURNING *`,
      [moveId, new Date(now.getTime() + LEASE_MS), now]
    );
    if (!leased.rowCount) {
      const current = await this.pool.query(`SELECT state FROM money_moves WHERE id = $1`, [moveId]);
      return { state: (current.rows[0]?.state ?? "pending") as MoveOutcome };
    }

    const move = leased.rows[0];
    const kind = move.kind as MoneyKind;
    const amount = Number(move.amount);
    const debit = DEBITS.has(kind);

    if (!this.playfab) {
      await this.retryLater(move, "PlayFab is not configured on this backend");
      return { state: "pending" };
    }

    const player = await this.pool.query(
      `SELECT title_player_account_id FROM pf_players WHERE playfab_id = $1`,
      [move.playfab_id]
    );
    const tpa = player.rows[0]?.title_player_account_id;
    if (!tpa) {
      // Every tournament player signed in through /api/auth/playfab, which records this. Missing means
      // a bug, not a player problem — keep the move and say so.
      await this.retryLater(move, `No title player account recorded for ${move.playfab_id}`);
      return { state: "pending" };
    }

    try {
      const id = idempotencyIdFor(move.idempotency_key);
      if (debit) await this.playfab.subtractChips(tpa, amount, id);
      else await this.playfab.addChips(tpa, amount, id);
    } catch (err) {
      const pfErr = err instanceof PlayFabError ? err : new PlayFabError(String(err), "Unknown", false);
      if (debit && pfErr.final) {
        const followUps = await this.finalize(move, "failed", pfErr.code);
        await this.runAll(followUps);
        return { state: "failed" };
      }
      if (!debit && pfErr.final) {
        console.error(`[money] credit ${move.idempotency_key} refused (${pfErr.code}); will keep retrying.`);
      }
      await this.retryLater(move, pfErr.message);
      return { state: "pending" };
    }

    const followUps = await this.finalize(move, "done", null);
    await this.runAll(followUps);
    return { state: "done" };
  }

  private async retryLater(move: any, error: string) {
    const attempts = Number(move.attempts);
    const backoff = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.min(attempts, 10));
    await this.pool.query(
      `UPDATE money_moves SET last_error = $2, next_attempt_at = $3, updated_at = $4 WHERE id = $1 AND state = 'pending'`,
      [move.id, error.slice(0, 500), new Date(this.clock().getTime() + backoff), this.clock()]
    );
  }

  /**
   * Records the outcome and applies what it means, in one transaction with the tournament locked.
   * Returns refund moves created along the way (a payment that landed after its purpose was gone).
   */
  private async finalize(move: any, state: "done" | "failed", error: string | null): Promise<number[]> {
    const client = await this.pool.connect();
    const now = this.clock();
    const followUps: number[] = [];
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE money_moves SET state = $2, last_error = $3, done_at = $4, updated_at = $4
         WHERE id = $1 AND state = 'pending'`,
        [move.id, state, error, now]
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return followUps;
      }

      const t = (
        await client.query(`SELECT id, status FROM tournaments WHERE id = $1 FOR UPDATE`, [move.tournament_id])
      ).rows[0];
      const kind = move.kind as MoneyKind;
      const amount = Number(move.amount);
      const refund = async () => {
        const id = await enqueueMove(
          client,
          {
            tournamentId: move.tournament_id,
            entryId: move.entry_id,
            playFabId: move.playfab_id,
            kind: "refund",
            amount,
            key: refundKey(move.idempotency_key),
          },
          now
        );
        if (id) followUps.push(id);
      };

      if (kind === "host_prize_debit") {
        if (state === "done") {
          if (t.status === "funding") {
            await client.query(`UPDATE tournaments SET status = 'registering', updated_at = $2 WHERE id = $1`, [t.id, now]);
          } else if (t.status !== "registering") {
            await refund();   // cancelled while the prize was still being taken
          }
        } else if (t.status === "funding") {
          await client.query(
            `UPDATE tournaments SET status = 'funding_failed', cancel_reason = $2, updated_at = $3 WHERE id = $1`,
            [t.id, error, now]
          );
        }
      } else if (kind === "prize_raise_debit") {
        if (state === "done") {
          if (t.status === "registering" || t.status === "locked" || t.status === "running") {
            await client.query(
              `UPDATE tournaments SET host_prize = host_prize + $2, updated_at = $3 WHERE id = $1`,
              [t.id, amount, now]
            );
          } else {
            await refund();
          }
        }
      } else if (kind === "entry_debit") {
        const entry = (
          await client.query(`SELECT id, status FROM tournament_entries WHERE id = $1 FOR UPDATE`, [move.entry_id])
        ).rows[0];
        if (state === "done") {
          if (entry && entry.status === "paying" && t.status === "registering") {
            await client.query(
              `UPDATE tournament_entries SET status = 'registered', paid_amount = $2, updated_at = $3 WHERE id = $1`,
              [entry.id, amount, now]
            );
          } else {
            // Paid after the tournament started or was cancelled, or after the player left: give it back.
            if (entry && entry.status === "paying") {
              await client.query(
                `UPDATE tournament_entries SET status = 'excluded', updated_at = $2 WHERE id = $1`,
                [entry.id, now]
              );
            }
            await refund();
          }
        } else if (entry && entry.status === "paying") {
          await client.query(
            `UPDATE tournament_entries SET status = 'rejected', updated_at = $2 WHERE id = $1`,
            [entry.id, now]
          );
        }
      }
      // Refunds and payouts change nothing else when they land.

      await client.query("COMMIT");
      return followUps;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
