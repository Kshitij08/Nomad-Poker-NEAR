import {
  STARTER_GRANT,
  type Currency,
  type IdentityProvider,
  type LinkedIdentity,
  type PlayerProfile,
  type SessionResponse,
} from '@nomad/contract';
import type { PlayerRow } from './types';
import { postingStatement } from './ledger';
import { iso, randomBytes, randomId, sha256Hex, base64url } from './util';

/** Players, identities and sessions. */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sessions slide forward at most this often, so reads don't write on every request. */
const SESSION_TOUCH_MS = 60 * 60 * 1000;

export function profile(p: PlayerRow): PlayerProfile {
  return { id: p.id, displayName: p.display_name, kind: p.kind, createdAt: iso(p.created_at) };
}

export function guestName(): string {
  const n = randomBytes(2);
  return `Guest ${String(((n[0] << 8) | n[1]) % 10000).padStart(4, '0')}`;
}

export function cleanDisplayName(name: unknown, fallback: string): string {
  if (typeof name !== 'string') return fallback;
  const s = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return s.length >= 2 ? s : fallback;
}

export interface NewIdentity {
  provider: IdentityProvider;
  subject: string;
  label: string;
}

/** Creates a player (with an identity, if given) and pays the starter grant, in one atomic batch. */
export async function createPlayer(
  db: D1Database,
  opts: { displayName: string; identity?: NewIdentity },
  now = Date.now(),
): Promise<PlayerRow> {
  const player: PlayerRow = {
    id: randomId('p_', 12),
    display_name: opts.displayName,
    kind: opts.identity ? 'registered' : 'guest',
    created_at: now,
    last_seen_at: now,
  };
  const stmts: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO players (id, display_name, kind, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(player.id, player.display_name, player.kind, now, now),
  ];
  if (opts.identity) stmts.push(identityStatement(db, player.id, opts.identity, now));
  for (const [currency, amount] of Object.entries(STARTER_GRANT)) {
    if (amount) {
      stmts.push(
        postingStatement(db, { playerId: player.id, currency: currency as Currency, delta: amount, reason: 'starter', idempotencyKey: `starter:${currency}` }, now),
      );
    }
  }
  await db.batch(stmts);
  return player;
}

function identityStatement(db: D1Database, playerId: string, id: NewIdentity, now: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO identities (provider, subject, label, player_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id.provider, id.subject, id.label, playerId, now);
}

export async function findPlayer(db: D1Database, id: string): Promise<PlayerRow | null> {
  return db.prepare('SELECT * FROM players WHERE id = ?1').bind(id).first<PlayerRow>();
}

export async function identityOwner(db: D1Database, provider: IdentityProvider, subject: string): Promise<string | null> {
  return db.prepare('SELECT player_id FROM identities WHERE provider = ?1 AND subject = ?2').bind(provider, subject).first<string>('player_id');
}

export async function identities(db: D1Database, playerId: string): Promise<LinkedIdentity[]> {
  const rows = await db
    .prepare('SELECT provider, label, created_at FROM identities WHERE player_id = ?1 ORDER BY created_at')
    .bind(playerId)
    .all<{ provider: IdentityProvider; label: string; created_at: number }>();
  return rows.results.map((r) => ({ provider: r.provider, label: r.label, linkedAt: iso(r.created_at) }));
}

export async function createSession(db: D1Database, playerId: string, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
  const token = 'np_' + base64url(randomBytes(32));
  const expiresAt = now + SESSION_TTL_MS;
  await db
    .prepare('INSERT INTO sessions (token_hash, player_id, created_at, expires_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?3)')
    .bind(await sha256Hex(token), playerId, now, expiresAt)
    .run();
  return { token, expiresAt };
}

/** The player behind a bearer token, or null. Slides the session (and last-seen) forward at most hourly. */
export async function sessionPlayer(db: D1Database, token: string, now = Date.now()): Promise<{ player: PlayerRow; tokenHash: string } | null> {
  if (!token.startsWith('np_') || token.length > 100) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT p.*, s.expires_at AS s_expires, s.last_used_at AS s_used FROM sessions s
       JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?1`,
    )
    .bind(tokenHash)
    .first<PlayerRow & { s_expires: number; s_used: number }>();
  if (!row || row.s_expires <= now) return null;
  if (now - row.s_used > SESSION_TOUCH_MS) {
    await db.batch([
      db.prepare('UPDATE sessions SET last_used_at = ?2, expires_at = ?3 WHERE token_hash = ?1').bind(tokenHash, now, now + SESSION_TTL_MS),
      db.prepare('UPDATE players SET last_seen_at = ?2 WHERE id = ?1').bind(row.id, now),
    ]);
  }
  const { s_expires: _e, s_used: _u, ...player } = row;
  return { player, tokenHash };
}

export async function deleteSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
}

const isUniqueViolation = (err: unknown) => /UNIQUE constraint failed|PRIMARY KEY/i.test(String((err as Error)?.message ?? err));

/**
 * Finishes a wallet / Google / email sign-in:
 * - the identity is known: sign in to its player;
 * - unknown, and the caller sent a session: link it to the caller (a guest becomes registered, balance kept);
 * - unknown, no session: create a registered player with the starter grant.
 */
export async function completeSignIn(
  db: D1Database,
  identity: NewIdentity,
  displayName: string,
  caller: PlayerRow | null,
  now = Date.now(),
): Promise<SessionResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ownerId = await identityOwner(db, identity.provider, identity.subject);
    if (ownerId) {
      const owner = caller?.id === ownerId ? caller : await findPlayer(db, ownerId);
      if (!owner) break;
      return session(db, owner, false, false, now);
    }
    try {
      if (caller) {
        const stmts = [identityStatement(db, caller.id, identity, now)];
        if (caller.kind === 'guest') {
          stmts.push(db.prepare("UPDATE players SET kind = 'registered', display_name = ?2 WHERE id = ?1").bind(caller.id, displayName));
        }
        await db.batch(stmts);
        const updated: PlayerRow = caller.kind === 'guest' ? { ...caller, kind: 'registered', display_name: displayName } : caller;
        return session(db, updated, false, true, now);
      }
      return session(db, await createPlayer(db, { displayName, identity }, now), true, false, now);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // someone linked the same identity at the same moment: retry as a sign-in
    }
  }
  throw new Error('sign-in: identity owner vanished');
}

export async function session(db: D1Database, player: PlayerRow, created: boolean, linked: boolean, now = Date.now()): Promise<SessionResponse> {
  const s = await createSession(db, player.id, now);
  return { token: s.token, expiresAt: iso(s.expiresAt), player: profile(player), created, linked };
}
