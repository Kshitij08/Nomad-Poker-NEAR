import { CURRENCIES, type Balances, type Currency, type LedgerEntry } from '@nomad/contract';
import { fail, iso } from './util';

/**
 * The play-money ledger. Entries are append-only; a trigger applies each one to `balances` inside the same
 * statement, and a balance below zero aborts the entry (see migrations/0001_init.sql).
 */

export interface LedgerPosting {
  playerId: string;
  currency: Currency;
  /** Whole units, non-zero. */
  delta: number;
  reason: string;
  ref?: string | null;
  /** Replaying the same key for the same player is a no-op, so retries never double-pay. */
  idempotencyKey: string;
}

const INSERT_ENTRY = `INSERT INTO ledger_entries (player_id, currency, delta, reason, ref, idempotency_key, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT (player_id, idempotency_key) DO NOTHING
RETURNING id`;

/** The statement for one posting, for callers that need it inside a larger atomic batch. */
export function postingStatement(db: D1Database, p: LedgerPosting, now = Date.now()): D1PreparedStatement {
  if (!Number.isSafeInteger(p.delta) || p.delta === 0) throw new Error(`ledger: bad delta ${p.delta}`);
  if (!CURRENCIES.includes(p.currency)) throw new Error(`ledger: bad currency ${p.currency}`);
  return db.prepare(INSERT_ENTRY).bind(p.playerId, p.currency, p.delta, p.reason, p.ref ?? null, p.idempotencyKey, now);
}

/**
 * A posting that applies only when `condition` (SQL, numbered from ?8 with `params`) holds when the batch reaches it.
 * Lets a batch pay for a state change only if that change actually happened (a seat was free, a status still open).
 */
export function conditionalPostingStatement(
  db: D1Database,
  p: LedgerPosting,
  condition: string,
  params: unknown[],
  now = Date.now(),
): D1PreparedStatement {
  if (!Number.isSafeInteger(p.delta) || p.delta === 0) throw new Error(`ledger: bad delta ${p.delta}`);
  if (!CURRENCIES.includes(p.currency)) throw new Error(`ledger: bad currency ${p.currency}`);
  return db
    .prepare(
      `INSERT INTO ledger_entries (player_id, currency, delta, reason, ref, idempotency_key, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${condition}
       ON CONFLICT (player_id, idempotency_key) DO NOTHING`,
    )
    .bind(p.playerId, p.currency, p.delta, p.reason, p.ref ?? null, p.idempotencyKey, now, ...params);
}

export function isInsufficientFunds(err: unknown): boolean {
  return /CHECK constraint failed.*amount/i.test(String((err as Error)?.message ?? err));
}

/**
 * Posts entries atomically (all or none). Returns the new entry id for each posting, or null where the
 * idempotency key had already been used. Fails with insufficient_funds if any debit would overdraw.
 */
export async function post(db: D1Database, postings: LedgerPosting[], now = Date.now()): Promise<(number | null)[]> {
  if (postings.length === 0) return [];
  try {
    const results = await db.batch<{ id: number }>(postings.map((p) => postingStatement(db, p, now)));
    return results.map((r) => r.results[0]?.id ?? null);
  } catch (err) {
    if (isInsufficientFunds(err)) fail(409, 'insufficient_funds', 'Not enough balance.');
    throw err;
  }
}

export function emptyBalances(): Balances {
  return { coins: 0, gems: 0, xp: 0, streak_tokens: 0 };
}

export async function balances(db: D1Database, playerId: string): Promise<Balances> {
  const rows = await db
    .prepare('SELECT currency, amount FROM balances WHERE player_id = ?1')
    .bind(playerId)
    .all<{ currency: Currency; amount: number }>();
  const out = emptyBalances();
  for (const r of rows.results) out[r.currency] = r.amount;
  return out;
}

export async function entries(
  db: D1Database,
  playerId: string,
  opts: { before?: number; limit: number },
): Promise<{ entries: LedgerEntry[]; nextBefore?: number }> {
  const rows = await db
    .prepare(
      `SELECT id, currency, delta, reason, ref, created_at FROM ledger_entries
       WHERE player_id = ?1 AND id < ?2 ORDER BY id DESC LIMIT ?3`,
    )
    .bind(playerId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit + 1)
    .all<{ id: number; currency: Currency; delta: number; reason: string; ref: string | null; created_at: number }>();
  const page = rows.results.slice(0, opts.limit);
  return {
    entries: page.map((r) => ({ id: r.id, currency: r.currency, delta: r.delta, reason: r.reason, ref: r.ref, createdAt: iso(r.created_at) })),
    nextBefore: rows.results.length > opts.limit ? page[page.length - 1].id : undefined,
  };
}
