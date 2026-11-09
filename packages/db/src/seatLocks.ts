import { postingStatement, isInsufficientFunds, balances } from './ledger';
import { randomId } from './util';

/**
 * Seats and table sessions (migrations/0002_tables.sql). A buy-in writes the seat lock and the debit in one batch,
 * a cash-out writes the credit and drops the lock in one batch, so chips are always either in the balance or in
 * exactly one seat lock — never both, never neither.
 */

export interface SeatLockRow {
  player_id: string;
  lock_id: string;
  table_id: string;
  room: string;
  seat: number;
  buy_in: number;
  stack: number;
  hand_number: number;
  created_at: number;
  updated_at: number;
}

export type BuyInResult =
  | { ok: true; balance: number; lockId: string }
  | { ok: false; reason: 'seated_here' | 'seated_elsewhere' | 'insufficient' | 'bad_amount'; balance?: number };

export async function seatLock(db: D1Database, playerId: string): Promise<SeatLockRow | null> {
  return db.prepare('SELECT * FROM seat_locks WHERE player_id = ?1').bind(playerId).first<SeatLockRow>();
}

const isUnique = (err: unknown) => /UNIQUE constraint failed|PRIMARY KEY/i.test(String((err as Error)?.message ?? err));

export async function buyIn(
  db: D1Database,
  p: { playerId: string; tableId: string; room: string; seat: number; chips: number },
  now = Date.now(),
): Promise<BuyInResult> {
  if (!Number.isSafeInteger(p.chips) || p.chips <= 0) return { ok: false, reason: 'bad_amount' };
  const lockId = randomId('l_', 12);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO seat_locks (player_id, lock_id, table_id, room, seat, buy_in, stack, hand_number, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0, ?7, ?7)`,
        )
        .bind(p.playerId, lockId, p.tableId, p.room, p.seat, p.chips, now),
      postingStatement(db, { playerId: p.playerId, currency: 'coins', delta: -p.chips, reason: 'table:buy_in', ref: p.tableId, idempotencyKey: `buyin:${lockId}` }, now),
    ]);
  } catch (err) {
    if (isInsufficientFunds(err)) return { ok: false, reason: 'insufficient', balance: (await balances(db, p.playerId)).coins };
    if (isUnique(err)) {
      const held = await seatLock(db, p.playerId);
      return { ok: false, reason: held?.table_id === p.tableId ? 'seated_here' : 'seated_elsewhere' };
    }
    throw err;
  }
  // The buy-in is written. A refused balance read must not turn it into a failure: the table would leave the player
  // unseated with the chips in the lock (load test, 9 Nov). -1 = unknown; the table then skips the balance push.
  let balance = -1;
  try {
    balance = (await balances(db, p.playerId)).coins;
  } catch {
    /* D1 busy: the buy-in stands */
  }
  return { ok: true, balance, lockId };
}

/** Records the stack in front of the player after a hand (a set, not a delta). False when no lock for this table. */
export async function checkpoint(
  db: D1Database,
  p: { playerId: string; tableId: string; seat: number; stack: number; handNumber: number },
  now = Date.now(),
): Promise<boolean> {
  if (!Number.isSafeInteger(p.stack) || p.stack < 0) return false;
  const r = await db
    .prepare('UPDATE seat_locks SET stack = ?3, seat = ?4, hand_number = ?5, updated_at = ?6 WHERE player_id = ?1 AND table_id = ?2')
    .bind(p.playerId, p.tableId, p.stack, p.seat, p.handNumber, now)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Pays `chips` back and releases the lock — only a lock held for `tableId`. Replays are harmless: the credit's key is
 * the lock's, and the lock is gone after the first success. Null when there was no matching lock.
 */
export async function cashOut(
  db: D1Database,
  p: { playerId: string; tableId: string; chips: number; reason?: string },
  now = Date.now(),
): Promise<{ balance: number; paid: number } | null> {
  if (!Number.isSafeInteger(p.chips) || p.chips < 0) return null;
  const stmts: D1PreparedStatement[] = [];
  if (p.chips > 0) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO ledger_entries (player_id, currency, delta, reason, ref, idempotency_key, created_at)
           SELECT player_id, 'coins', ?3, ?4, table_id, 'cashout:' || lock_id, ?5 FROM seat_locks
           WHERE player_id = ?1 AND table_id = ?2
           ON CONFLICT (player_id, idempotency_key) DO NOTHING`,
        )
        .bind(p.playerId, p.tableId, p.chips, p.reason ?? 'table:cash_out', now),
    );
  }
  stmts.push(db.prepare('DELETE FROM seat_locks WHERE player_id = ?1 AND table_id = ?2 RETURNING lock_id').bind(p.playerId, p.tableId));
  const results = await db.batch<{ lock_id: string }>(stmts);
  if (results[results.length - 1].results.length === 0) return null;
  return { balance: (await balances(db, p.playerId)).coins, paid: p.chips };
}

// ---- Table sessions ----------------------------------------------------------------------------

export async function openTableSession(db: D1Database, t: { id: string; room: string; stake: number }, now = Date.now()): Promise<void> {
  await db
    .prepare('INSERT INTO table_sessions (id, room, stake, opened_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO NOTHING')
    .bind(t.id, t.room, t.stake, now)
    .run();
}

/** One settled hand: the bots' (house's) and the owned Agents' result at this table. */
export async function recordHand(db: D1Database, tableId: string, botDelta: number, agentDelta = 0): Promise<void> {
  await db
    .prepare('UPDATE table_sessions SET hands = hands + 1, bot_net = bot_net + ?2, agent_net = agent_net + ?3 WHERE id = ?1')
    .bind(tableId, botDelta, agentDelta)
    .run();
}

export async function closeTableSession(db: D1Database, tableId: string, now = Date.now()): Promise<void> {
  await db.prepare('UPDATE table_sessions SET closed_at = ?2 WHERE id = ?1 AND closed_at IS NULL').bind(tableId, now).run();
}

export interface TableAudit {
  tableId: string;
  hands: number;
  buyIns: number;
  cashOuts: number;
  botNet: number;
  /** Chips owned Agents won at this table (their money moves through their own ledger entries). */
  agentNet: number;
  /** Chips still in seat locks for this table (last checkpoint). */
  seatedStacks: number;
  seatedPlayers: number;
  /** cash-outs − buy-ins + bot_net + chips still seated. Zero means every chip is accounted for. */
  drift: number;
}

/** Where every chip that entered this table went. */
export async function auditTable(db: D1Database, tableId: string): Promise<TableAudit | null> {
  // One batch, so one consistent view: read one by one, a cash-out landing between the ledger sum and the seat locks
  // was counted in neither (a load test's audit showed drift -1,473 on a table whose books were exact, 9 Nov).
  const [ts, ls, ss] = await db.batch([
    db.prepare('SELECT hands, bot_net, agent_net FROM table_sessions WHERE id = ?1').bind(tableId),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN delta < 0 THEN -delta END), 0) AS buy_ins,
           COALESCE(SUM(CASE WHEN delta > 0 THEN delta END), 0) AS cash_outs
         FROM ledger_entries WHERE ref = ?1 AND currency = 'coins' AND reason LIKE 'table:%'`,
      )
      .bind(tableId),
    db.prepare('SELECT COALESCE(SUM(stack), 0) AS stacks, COUNT(*) AS n FROM seat_locks WHERE table_id = ?1').bind(tableId),
  ]);
  const t = ts!.results[0] as { hands: number; bot_net: number; agent_net: number } | undefined;
  if (!t) return null;
  const sums = ls!.results[0] as { buy_ins: number; cash_outs: number } | undefined;
  const seated = ss!.results[0] as { stacks: number; n: number } | undefined;
  const buyIns = sums?.buy_ins ?? 0;
  const cashOuts = sums?.cash_outs ?? 0;
  const seatedStacks = seated?.stacks ?? 0;
  return {
    tableId,
    hands: t.hands,
    buyIns,
    cashOuts,
    botNet: t.bot_net,
    agentNet: t.agent_net,
    seatedStacks,
    seatedPlayers: seated?.n ?? 0,
    drift: cashOuts + seatedStacks - buyIns + t.bot_net + t.agent_net,
  };
}
