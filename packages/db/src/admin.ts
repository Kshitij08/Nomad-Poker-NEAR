import { CURRENCIES, type Currency } from '@nomad/contract';
import { balances, entries, isInsufficientFunds, postingStatement } from './ledger';
import type { PlayerRow } from './types';
import { fail } from './util';

/**
 * Support tools (migrations/0006): look a player up, adjust a balance, ban and unban, and the audit log of all of it.
 * Admins are player accounts listed in admin_users (added by an operator in D1, never through the API). Every write is
 * one D1 batch together with its audit row, so nothing happens without a record of who did it.
 */

export type AdminRole = 'support' | 'admin';

export interface AdminRow {
  player_id: string;
  role: AdminRole;
}

export async function adminRole(db: D1Database, playerId: string): Promise<AdminRole | null> {
  const r = await db.prepare('SELECT role FROM admin_users WHERE player_id = ?1').bind(playerId).first<{ role: AdminRole }>();
  return r?.role ?? null;
}

const auditStatement = (db: D1Database, adminId: string, action: string, targetId: string | null, details: unknown, now: number) =>
  db.prepare('INSERT INTO admin_audit (admin_id, action, target_id, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(adminId, action, targetId, JSON.stringify(details), now);

type Found = PlayerRow & { banned_at: number | null; ban_reason: string | null };

/** By internal id, Friend ID (any spelling) or display name (prefix, case-insensitive). At most 20. */
export async function searchPlayers(db: D1Database, q: string): Promise<{ id: string; name: string; friendCode: string | null; kind: string; banned: boolean; lastSeen: string }[]> {
  const term = q.trim();
  if (!term) return [];
  const code = term.replace(/-/g, '').toUpperCase();
  const r = await db
    .prepare(
      `SELECT * FROM players WHERE id = ?1 OR friend_code = ?2 OR display_name LIKE ?3 ESCAPE '\\' COLLATE NOCASE
       ORDER BY last_seen_at DESC LIMIT 20`,
    )
    .bind(term, code, term.replace(/[\\%_]/g, (c) => '\\' + c) + '%')
    .all<Found>();
  return r.results.map((p) => ({
    id: p.id, name: p.display_name, friendCode: p.friend_code ?? null, kind: p.kind, banned: !!p.banned_at, lastSeen: new Date(p.last_seen_at).toISOString(),
  }));
}

/** Everything support needs about one player: profile, balances, recent ledger, seat, Agent, tournaments, audit. */
export async function playerDetail(db: D1Database, adminId: string, playerId: string, now = Date.now()) {
  const p = await db.prepare('SELECT * FROM players WHERE id = ?1').bind(playerId).first<Found>();
  if (!p) fail(404, 'not_found', 'No such player.');
  const [seat, agent, trn, audit, identities] = await db.batch([
    db.prepare('SELECT room, table_id, stack, buy_in, updated_at FROM seat_locks WHERE player_id = ?1').bind(playerId),
    db.prepare(`SELECT id, phase, room, stack, bankroll, hands_played FROM agent_deployments WHERE owner_id = ?1 ORDER BY created_at DESC LIMIT 5`).bind(playerId),
    db.prepare(`SELECT tournament_id, status, paid_amount, place, prize FROM tournament_entries WHERE player_id = ?1 ORDER BY created_at DESC LIMIT 10`).bind(playerId),
    db.prepare('SELECT admin_id, action, details, created_at FROM admin_audit WHERE target_id = ?1 ORDER BY id DESC LIMIT 20').bind(playerId),
    db.prepare('SELECT provider, subject, created_at FROM identities WHERE player_id = ?1').bind(playerId),
  ]);
  await db.batch([auditStatement(db, adminId, 'view', playerId, {}, now)]);
  return {
    player: {
      id: p!.id, name: p!.display_name, kind: p!.kind, friendCode: p!.friend_code ?? null, createdAt: new Date(p!.created_at).toISOString(),
      lastSeen: new Date(p!.last_seen_at).toISOString(), banned: !!p!.banned_at, banReason: p!.ban_reason ?? null,
    },
    identities: identities!.results,
    balances: await balances(db, playerId),
    ledger: (await entries(db, playerId, { limit: 50 })).entries,
    seat: seat!.results[0] ?? null,
    agents: agent!.results,
    tournaments: trn!.results,
    audit: audit!.results,
  };
}

/**
 * Credits or debits a balance (admins only, never support). Keyed by `requestId`, so a retried request adjusts once;
 * a debit that would overdraw is refused. Returns the new balances.
 */
export async function adjustBalance(
  db: D1Database,
  admin: AdminRow,
  playerId: string,
  input: { currency?: unknown; delta?: unknown; reason?: unknown; requestId?: unknown },
  now = Date.now(),
) {
  if (admin.role !== 'admin') fail(403, 'forbidden', 'Only admins can adjust balances.');
  const currency = String(input.currency ?? 'coins') as Currency;
  if (!CURRENCIES.includes(currency)) fail(400, 'bad_request', `currency must be one of ${CURRENCIES.join(', ')}.`);
  const delta = Number(input.delta);
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 100_000_000) fail(400, 'bad_request', 'delta must be a non-zero whole number up to 100,000,000.');
  const reason = String(input.reason ?? '').trim().slice(0, 200);
  if (reason.length < 3) fail(400, 'bad_request', 'Say why (a reason of 3+ characters is recorded).');
  const requestId = String(input.requestId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) fail(400, 'bad_request', 'requestId (8–64 letters, digits, - or _) makes a retry safe.');
  const p = await db.prepare('SELECT id FROM players WHERE id = ?1').bind(playerId).first();
  if (!p) fail(404, 'not_found', 'No such player.');
  try {
    await db.batch([
      postingStatement(db, { playerId, currency, delta, reason: 'admin:adjust', ref: admin.player_id, idempotencyKey: `admin:${requestId}` }, now),
      db
        .prepare(
          `INSERT INTO admin_audit (admin_id, action, target_id, details, created_at)
           SELECT ?1, 'adjust', ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM admin_audit WHERE action = 'adjust' AND target_id = ?2 AND json_extract(details, '$.requestId') = ?5)`,
        )
        .bind(admin.player_id, playerId, JSON.stringify({ currency, delta, reason, requestId }), now, requestId),
    ]);
  } catch (err) {
    if (isInsufficientFunds(err)) fail(409, 'insufficient_funds', 'That debit would take the balance below zero.');
    throw err;
  }
  return balances(db, playerId);
}

/** Bans (signs out everywhere, refuses sign-in) or lifts a ban. Seat stacks pay back at the table as usual. */
export async function setBan(db: D1Database, admin: AdminRow, playerId: string, banned: boolean, reason: string, now = Date.now()) {
  const why = reason.trim().slice(0, 200);
  if (banned && why.length < 3) fail(400, 'bad_request', 'Say why (a reason of 3+ characters is recorded).');
  if (playerId === admin.player_id) fail(400, 'bad_request', "You can't ban yourself.");
  const target = await db.prepare('SELECT id FROM players WHERE id = ?1').bind(playerId).first();
  if (!target) fail(404, 'not_found', 'No such player.');
  const targetRole = await adminRole(db, playerId);
  if (targetRole === 'admin' && admin.role !== 'admin') fail(403, 'forbidden', 'Only an admin can ban an admin.');
  const stmts = [
    banned
      ? db.prepare('UPDATE players SET banned_at = ?2, ban_reason = ?3 WHERE id = ?1').bind(playerId, now, why)
      : db.prepare('UPDATE players SET banned_at = NULL, ban_reason = NULL WHERE id = ?1').bind(playerId),
    auditStatement(db, admin.player_id, banned ? 'ban' : 'unban', playerId, { reason: why }, now),
  ];
  if (banned) stmts.push(db.prepare('DELETE FROM sessions WHERE player_id = ?1').bind(playerId));
  await db.batch(stmts);
  return { banned };
}

export async function auditLog(db: D1Database, opts: { before?: number; limit?: number } = {}) {
  const lim = Math.max(1, Math.min(200, Math.trunc(opts.limit ?? 50) || 50));
  const r = await db
    .prepare('SELECT * FROM admin_audit WHERE id < ?1 ORDER BY id DESC LIMIT ?2')
    .bind(opts.before ?? Number.MAX_SAFE_INTEGER, lim)
    .all<{ id: number; admin_id: string; action: string; target_id: string | null; details: string; created_at: number }>();
  return {
    entries: r.results.map((e) => ({ ...e, details: JSON.parse(e.details) as unknown, at: new Date(e.created_at).toISOString() })),
    nextBefore: r.results.length === lim ? r.results[r.results.length - 1]!.id : undefined,
  };
}
