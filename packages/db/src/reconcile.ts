/**
 * The ledger reconciliation (Phase 7): every invariant the money depends on, checked from the database alone.
 * Run on demand (GET /v1/admin/reconcile) and hourly by the game server's cron, which logs a warning when anything is
 * off. The beta's exit gate is this report staying clean.
 */

export interface Check {
  name: string;
  ok: boolean;
  /** How many rows were looked at. */
  checked: number;
  /** The first few problems, for a person to follow up. */
  problems: unknown[];
  note: string;
}

export interface ReconcileReport {
  ok: boolean;
  at: string;
  checks: Check[];
}

const SAMPLE = 20;
const HOUR = 3_600_000;

async function rows<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}

export async function reconcile(db: D1Database, opts: { sinceMs?: number; now?: number } = {}): Promise<ReconcileReport> {
  const now = opts.now ?? Date.now();
  const since = opts.sinceMs ?? now - 30 * 86_400_000;
  const checks: Check[] = [];
  const add = (name: string, checked: number, problems: unknown[], note: string) =>
    checks.push({ name, ok: problems.length === 0, checked, problems: problems.slice(0, SAMPLE), note });

  // 1. Every balance equals the sum of its ledger entries (the trigger keeps them together; this proves it).
  const bal = await rows<{ player_id: string; currency: string; amount: number; sum: number }>(
    db,
    `SELECT b.player_id, b.currency, b.amount, coalesce((SELECT sum(delta) FROM ledger_entries l WHERE l.player_id = b.player_id AND l.currency = b.currency), 0) AS sum
     FROM balances b`,
  );
  add('balances match the ledger', bal.length, bal.filter((r) => r.amount !== r.sum), 'balance = sum of ledger entries, per player and currency');
  const orphan = await rows<{ player_id: string; currency: string; sum: number }>(
    db,
    `SELECT player_id, currency, sum(delta) AS sum FROM ledger_entries l
     WHERE NOT EXISTS (SELECT 1 FROM balances b WHERE b.player_id = l.player_id AND b.currency = l.currency)
     GROUP BY player_id, currency HAVING sum(delta) <> 0`,
  );
  add('no ledger entries without a balance', orphan.length, orphan, 'entries whose balance row is missing');

  // 2. Table sessions: cash-outs + seated stacks − buy-ins + the bots' result = 0.
  const tables = await rows<{ id: string; room: string; closed_at: number | null; bot_net: number; agent_net: number; buy_ins: number; cash_outs: number; seated: number }>(
    db,
    `SELECT t.id, t.room, t.closed_at, t.bot_net, t.agent_net,
       coalesce((SELECT sum(-delta) FROM ledger_entries WHERE ref = t.id AND currency = 'coins' AND reason LIKE 'table:%' AND delta < 0), 0) AS buy_ins,
       coalesce((SELECT sum(delta) FROM ledger_entries WHERE ref = t.id AND currency = 'coins' AND reason LIKE 'table:%' AND delta > 0), 0) AS cash_outs,
       coalesce((SELECT sum(stack) FROM seat_locks WHERE table_id = t.id), 0) AS seated
     FROM table_sessions t WHERE t.opened_at >= ?1`,
    since,
  );
  const drift = tables.map((t) => ({ ...t, drift: t.cash_outs + t.seated - t.buy_ins + t.bot_net + t.agent_net })).filter((t) => t.drift !== 0);
  add('tables have zero drift', tables.length, drift, 'per table session: cash-outs + seated stacks − buy-ins + bot net + Agent net');

  // 3. Seats held by tables nobody has checkpointed for an hour (paid back at the player's next sit-down, but visible).
  const stale = await rows<{ player_id: string; room: string; stack: number; updated_at: number }>(
    db,
    'SELECT player_id, room, stack, updated_at FROM seat_locks WHERE updated_at < ?1',
    now - HOUR,
  );
  add('no seat held by a quiet table', stale.length, stale, 'seat locks not checkpointed for an hour (stranded stacks waiting for recovery)');

  // 4. Agents: every finished deployment took its bankroll and paid back exactly what it says.
  const agents = await rows<{ id: string; phase: string; bankroll: number; returned: number; debit: number; credit: number; fee: number }>(
    db,
    `SELECT d.id, d.phase, d.bankroll, d.returned,
       coalesce((SELECT -sum(delta) FROM ledger_entries WHERE ref = d.id AND reason = 'agent:bankroll'), 0) AS debit,
       coalesce((SELECT sum(delta) FROM ledger_entries WHERE ref = d.id AND reason = 'agent:return'), 0) AS credit,
       coalesce((SELECT creator_fee FROM copy_fees WHERE deployment_id = d.id), 0) AS fee
     FROM agent_deployments d WHERE d.created_at >= ?1`,
    since,
  );
  const badAgents = agents.filter((a) => a.debit !== a.bankroll || ((a.phase === 'completed' || a.phase === 'failed') && a.credit !== a.returned));
  add('Agents paid exactly', agents.length, badAgents, 'bankroll debited once; the return credited equals the recorded return');
  const lost = await rows<{ id: string; room: string | null; updated_at: number }>(
    db,
    `SELECT id, room, updated_at FROM agent_deployments WHERE phase = 'playing' AND updated_at < ?1`,
    now - 10 * 60_000,
  );
  add('no Agent stuck on a lost table', lost.length, lost, "playing Agents not checkpointed for 10 minutes (the cron's sweep should have paid them back)");

  // 5. Tournaments: once over, what came in went out (finished: entries + host prize = prizes; cancelled: refunded).
  const trn = await rows<{ id: string; status: string; net: number }>(
    db,
    `SELECT t.id, t.status, coalesce((SELECT sum(delta) FROM ledger_entries WHERE ref = t.id), 0) AS net
     FROM tournaments t WHERE t.status IN ('finished', 'cancelled', 'aborted') AND t.updated_at >= ?1`,
    since,
  );
  add('ended tournaments net to zero', trn.length, trn.filter((t) => t.net !== 0), 'per ended tournament: sum of its ledger entries = 0');
  const stuck = await rows<{ id: string; status: string; starts_at: number }>(
    db,
    `SELECT id, status, starts_at FROM tournaments WHERE status IN ('locked', 'running') AND starts_at < ?1`,
    now - 6 * HOUR,
  );
  add('no tournament stuck', stuck.length, stuck, 'locked or running six hours after the start');

  return { ok: checks.every((c) => c.ok), at: new Date(now).toISOString(), checks };
}
