import { FriendCode } from '@nomad/engine/social/friendCode';
import { FriendInviteRules } from '@nomad/engine/social/friendRules';
import type { FriendInfo, FriendRelationName, PlayerSearchResult, ProfileUpdateRequest, SocialActionResult, SocialResponse, TableInviteInfo } from '@nomad/contract';
import type { PlayerRow } from './types';

/**
 * Friends, table invites, presence and profile (migrations/0004_social.sql) — the rules of the title's friends.js
 * CloudScript, on D1: a request writes both sides, asking back accepts, removing drops both sides, only friends can be
 * invited, invites expire after FriendInviteRules.TtlSeconds and an invitee keeps at most 10. Players are addressed by
 * their public Friend ID; internal ids never appear in these payloads.
 */

export const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const PRESENCE_TOUCH_MS = 60 * 1000;
const MAX_INVITES = 10;
const MAX_SESSION_LENGTH = 64;

const ok = (relation?: FriendRelationName): SocialActionResult => (relation ? { ok: true, relation } : { ok: true });
const fail = (error: NonNullable<SocialActionResult['error']>): SocialActionResult => ({ ok: false, error });

async function byFriendCode(db: D1Database, code: string): Promise<PlayerRow | null> {
  return db.prepare('SELECT * FROM players WHERE friend_code = ?1').bind(code).first<PlayerRow>();
}

/** A Friend ID however it was typed, or an exact (case-insensitive) display name that only one player has. */
export async function resolvePlayer(db: D1Database, idOrName: string): Promise<{ player: PlayerRow } | { error: 'invalid_id' | 'not_found' | 'not_found_name' | 'ambiguous_name' }> {
  const input = (idOrName ?? '').trim();
  if (!input) return { error: 'invalid_id' };
  const code = FriendCode.tryParse(input);
  if (code) {
    const p = await byFriendCode(db, code);
    return p ? { player: p } : { error: 'not_found' };
  }
  if (input.length > 24) return { error: 'invalid_id' };
  const rows = await db.prepare('SELECT * FROM players WHERE display_name = ?1 COLLATE NOCASE LIMIT 2').bind(input).all<PlayerRow>();
  if (rows.results.length === 0) return { error: 'not_found_name' };
  if (rows.results.length > 1) return { error: 'ambiguous_name' };
  return { player: rows.results[0]! };
}

async function relationOf(db: D1Database, me: string, other: string): Promise<FriendRelationName | null> {
  return db.prepare('SELECT relation FROM friendships WHERE player_id = ?1 AND friend_id = ?2').bind(me, other).first<FriendRelationName>('relation');
}

const setPair = (db: D1Database, a: string, b: string, aSees: FriendRelationName, bSees: FriendRelationName, now: number) => [
  db
    .prepare('INSERT INTO friendships (player_id, friend_id, relation, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (player_id, friend_id) DO UPDATE SET relation = excluded.relation')
    .bind(a, b, aSees, now),
  db
    .prepare('INSERT INTO friendships (player_id, friend_id, relation, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (player_id, friend_id) DO UPDATE SET relation = excluded.relation')
    .bind(b, a, bSees, now),
];

/** sendFriendRequest: a request, or a friendship when they had already asked. */
export async function sendRequest(db: D1Database, me: PlayerRow, idOrName: string, now = Date.now()): Promise<SocialActionResult> {
  const found = await resolvePlayer(db, idOrName);
  if ('error' in found) return fail(found.error);
  const target = found.player;
  if (target.id === me.id) return fail('self');
  const relation = await relationOf(db, me.id, target.id);
  if (relation === 'friend') return fail('already_friends');
  if (relation === 'pending_out') return fail('already_requested');
  if (relation === 'pending_in') {
    await db.batch(setPair(db, me.id, target.id, 'friend', 'friend', now));
    return ok('friend');
  }
  await db.batch(setPair(db, me.id, target.id, 'pending_out', 'pending_in', now));
  return ok('pending_out');
}

export async function acceptRequest(db: D1Database, me: PlayerRow, friendCode: string, now = Date.now()): Promise<SocialActionResult> {
  const code = FriendCode.tryParse(friendCode);
  if (!code) return fail('invalid_id');
  const other = await byFriendCode(db, code);
  if (!other) return fail('not_found');
  const relation = await relationOf(db, me.id, other.id);
  if (relation === 'friend') return ok('friend');
  if (relation !== 'pending_in') return fail('no_request');
  await db.batch(setPair(db, me.id, other.id, 'friend', 'friend', now));
  return ok('friend');
}

/** Decline, cancel and unfriend: the pair comes off both lists (and any invites between them go). */
export async function removeFriend(db: D1Database, me: PlayerRow, friendCode: string): Promise<SocialActionResult> {
  const code = FriendCode.tryParse(friendCode);
  if (!code) return fail('invalid_id');
  const other = await byFriendCode(db, code);
  if (!other) return ok();
  await db.batch([
    db.prepare('DELETE FROM friendships WHERE (player_id = ?1 AND friend_id = ?2) OR (player_id = ?2 AND friend_id = ?1)').bind(me.id, other.id),
    db.prepare('DELETE FROM table_invites WHERE (to_player = ?1 AND from_player = ?2) OR (to_player = ?2 AND from_player = ?1)').bind(me.id, other.id),
  ]);
  return ok();
}

/** sendInvite: friends only; replaces an earlier invite from the same sender; an invitee keeps the newest 10. */
export async function sendInvite(db: D1Database, me: PlayerRow, friendCode: string, session: string, money: boolean, now = Date.now()): Promise<SocialActionResult> {
  const code = FriendCode.tryParse(friendCode);
  if (!code) return fail('invalid_id');
  const s = (session ?? '').trim();
  if (!s || s.length > MAX_SESSION_LENGTH) return fail('invalid_session');
  const other = await byFriendCode(db, code);
  if (!other) return fail('not_found');
  if ((await relationOf(db, me.id, other.id)) !== 'friend') return fail('not_friends');
  await db.batch([
    db.prepare('DELETE FROM table_invites WHERE to_player = ?1 AND created_at < ?2').bind(other.id, now - FriendInviteRules.TtlSeconds * 1000),
    db
      .prepare(
        `INSERT INTO table_invites (to_player, from_player, session, money, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (to_player, from_player) DO UPDATE SET session = excluded.session, money = excluded.money, created_at = excluded.created_at`,
      )
      .bind(other.id, me.id, s, money ? 1 : 0, now),
    db
      .prepare(
        `DELETE FROM table_invites WHERE to_player = ?1 AND from_player NOT IN
           (SELECT from_player FROM table_invites WHERE to_player = ?1 ORDER BY created_at DESC LIMIT ?2)`,
      )
      .bind(other.id, MAX_INVITES),
  ]);
  return ok();
}

export async function dismissInvite(db: D1Database, me: PlayerRow, fromCode: string): Promise<SocialActionResult> {
  const code = FriendCode.tryParse(fromCode);
  if (!code) return fail('invalid_id');
  await db.prepare('DELETE FROM table_invites WHERE to_player = ?1 AND from_player = (SELECT id FROM players WHERE friend_code = ?2)').bind(me.id, code).run();
  return ok();
}

/** Marks the player active (at most once a minute) — the "online" half of presence. */
export async function touchPresence(db: D1Database, playerId: string, now = Date.now()): Promise<void> {
  await db.prepare('UPDATE players SET last_seen_at = ?2 WHERE id = ?1 AND last_seen_at < ?3').bind(playerId, now, now - PRESENCE_TOUCH_MS).run();
}

/** Friends with presence (online, and the table a friend sits at: their seat lock's room) and the live invites. */
export async function social(db: D1Database, me: PlayerRow, now = Date.now()): Promise<SocialResponse> {
  await touchPresence(db, me.id, now);
  const [friends, invites] = await Promise.all([
    db
      .prepare(
        `SELECT p.friend_code, p.display_name, f.relation, p.last_seen_at, p.avatar, p.picture, s.room
         FROM friendships f JOIN players p ON p.id = f.friend_id LEFT JOIN seat_locks s ON s.player_id = p.id
         WHERE f.player_id = ?1 ORDER BY p.display_name COLLATE NOCASE`,
      )
      .bind(me.id)
      .all<{ friend_code: string; display_name: string; relation: FriendRelationName; last_seen_at: number; avatar: number; picture: string | null; room: string | null }>(),
    db
      .prepare(
        `SELECT p.friend_code, p.display_name, i.session, i.money, i.created_at
         FROM table_invites i JOIN players p ON p.id = i.from_player
         WHERE i.to_player = ?1 AND i.created_at >= ?2 ORDER BY i.created_at`,
      )
      .bind(me.id, now - FriendInviteRules.TtlSeconds * 1000)
      .all<{ friend_code: string; display_name: string; session: string; money: number; created_at: number }>(),
  ]);
  return {
    friendCode: me.friend_code ?? '',
    friends: friends.results.map(
      (r): FriendInfo => ({
        id: r.friend_code,
        name: r.display_name,
        relation: r.relation,
        lastSeen: r.last_seen_at,
        avatar: r.avatar,
        online: now - r.last_seen_at < ONLINE_WINDOW_MS,
        table: r.relation === 'friend' ? r.room : null,
        picture: r.picture ?? null,
      }),
    ),
    invites: invites.results.map(
      (r): TableInviteInfo => ({ fromId: r.friend_code, fromName: r.display_name, session: r.session, money: r.money === 1, sentAtUnix: Math.floor(r.created_at / 1000) }),
    ),
    serverTime: Math.floor(now / 1000),
  };
}

/**
 * Add-friend suggestions: players whose display name starts with `query` (2+ characters, case-insensitive), not you.
 * Signed-in players before guests, then exact matches, then the most recently active; at most `limit`.
 */
export async function searchPlayers(db: D1Database, me: PlayerRow, query: string, limit = 8, now = Date.now()): Promise<PlayerSearchResult[]> {
  const q = (query ?? '').trim();
  if (q.length < 2 || q.length > 24) return [];
  // LIKE wildcards in the typed name are matched literally (escaped with '!').
  const pattern = q.replace(/[!%_]/g, (c) => `!${c}`) + '%';
  const rows = await db
    .prepare(
      `SELECT p.friend_code, p.display_name, p.avatar, p.picture, p.last_seen_at, f.relation
       FROM players p LEFT JOIN friendships f ON f.player_id = ?1 AND f.friend_id = p.id
       WHERE p.id <> ?1 AND p.friend_code IS NOT NULL AND p.display_name LIKE ?2 ESCAPE '!'
       ORDER BY (p.kind = 'guest'), (p.display_name = ?3 COLLATE NOCASE) DESC, p.last_seen_at DESC
       LIMIT ?4`,
    )
    .bind(me.id, pattern, q, Math.max(1, Math.min(20, limit)))
    .all<{ friend_code: string; display_name: string; avatar: number; picture: string | null; last_seen_at: number; relation: FriendRelationName | null }>();
  return rows.results.map((r) => ({
    id: r.friend_code,
    name: r.display_name,
    avatar: r.avatar,
    relation: r.relation ?? null,
    online: now - (r.last_seen_at ?? 0) < ONLINE_WINDOW_MS,
    picture: r.picture ?? null,
  }));
}

/** Display name (2–24 characters, no control characters) and avatar (AvatarCatalog value). */
export async function updateProfile(db: D1Database, me: PlayerRow, req: ProfileUpdateRequest, avatarCount: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const sets: string[] = [];
  const args: unknown[] = [me.id];
  if (req.displayName !== undefined) {
    const name = String(req.displayName).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (name.length < 2 || name.length > 24) return { ok: false, error: 'Names are 2 to 24 characters.' };
    args.push(name);
    sets.push(`display_name = ?${args.length}`);
  }
  if (req.avatar !== undefined) {
    const a = Number(req.avatar);
    if (!Number.isInteger(a) || a < 0 || a >= avatarCount) return { ok: false, error: 'No such avatar.' };
    args.push(a);
    sets.push(`avatar = ?${args.length}`);
  }
  if (sets.length) await db.prepare(`UPDATE players SET ${sets.join(', ')} WHERE id = ?1`).bind(...args).run();
  return { ok: true };
}

/** Points the player at a new uploaded picture (null: back to their avatar). Returns the key it replaced. */
export async function setPicture(db: D1Database, playerId: string, key: string | null): Promise<string | null> {
  const old = await db.prepare('SELECT picture FROM players WHERE id = ?1').bind(playerId).first<string | null>('picture');
  await db.prepare('UPDATE players SET picture = ?2 WHERE id = ?1').bind(playerId, key).run();
  return old ?? null;
}
