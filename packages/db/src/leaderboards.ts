import { FreePlayLeaderboardMath, LeaderboardKind } from '@nomad/engine/leaderboards/freePlayLeaderboardMath';
import type { LeaderboardPage } from '@nomad/contract';

/**
 * Leaderboards from recorded hands (hand_results, written by the game server). Weekly earnings and hands won reset on
 * FreePlayLeaderboardMath's Monday-start UTC weeks, the season is the calendar month, hands won is all time; the
 * friends board is the weekly earnings of the player and their friends. Coins only — never SOL tables.
 */

interface BoardSpec {
  period: (now: number) => number;
  /** SQL for the period filter (?2 is the period) and the scored expression. */
  where: string;
  score: string;
  friendsOnly?: boolean;
}

const BOARDS: Record<LeaderboardKind, BoardSpec> = {
  [LeaderboardKind.WeeklyEarnings]: { period: (n) => FreePlayLeaderboardMath.weekId(n), where: 'r.week = ?2', score: 'SUM(r.net)' },
  [LeaderboardKind.WeeklyHandsWon]: { period: (n) => FreePlayLeaderboardMath.weekId(n), where: 'r.week = ?2', score: 'SUM(r.won)' },
  [LeaderboardKind.SeasonEarnings]: { period: (n) => FreePlayLeaderboardMath.seasonId(n), where: 'r.season = ?2', score: 'SUM(r.net)' },
  [LeaderboardKind.HandsWon]: { period: () => 0, where: '?2 = 0', score: 'SUM(r.won)' },
  [LeaderboardKind.FriendsWeekly]: { period: (n) => FreePlayLeaderboardMath.weekId(n), where: 'r.week = ?2', score: 'SUM(r.net)', friendsOnly: true },
};

export function isLeaderboardKind(n: number): n is LeaderboardKind {
  return Number.isInteger(n) && n in BOARDS;
}

export async function leaderboard(db: D1Database, playerId: string, kind: LeaderboardKind, pageIndex: number, now = Date.now()): Promise<LeaderboardPage> {
  const spec = BOARDS[kind];
  const period = spec.period(now);
  const pageSize = FreePlayLeaderboardMath.PageSize;
  const page = Math.max(0, Math.trunc(pageIndex) || 0);
  // ?1 = the viewer: the friends board keeps them and their friends.
  const scope = spec.friendsOnly ? `AND (r.player_id = ?1 OR r.player_id IN (SELECT friend_id FROM friendships WHERE player_id = ?1 AND relation = 'friend'))` : '';
  const scores = `SELECT r.player_id, ${spec.score} AS score FROM hand_results r WHERE ${spec.where} ${scope} GROUP BY r.player_id`;
  const [rows, mine] = await Promise.all([
    db
      .prepare(
        `SELECT s.player_id, p.display_name, s.score FROM (${scores}) s JOIN players p ON p.id = s.player_id
         ORDER BY s.score DESC, p.display_name COLLATE NOCASE, s.player_id LIMIT ?3 OFFSET ?4`,
      )
      .bind(playerId, period, pageSize + 1, page * pageSize)
      .all<{ player_id: string; display_name: string; score: number }>(),
    db
      .prepare(`SELECT COALESCE((SELECT score FROM (${scores}) WHERE player_id = ?1), 0) AS mine, (SELECT COUNT(*) FROM (${scores}) WHERE score > COALESCE((SELECT score FROM (${scores}) WHERE player_id = ?1), 0)) AS above`)
      .bind(playerId, period)
      .first<{ mine: number; above: number }>(),
  ]);
  const list = rows.results.slice(0, pageSize);
  return {
    kind,
    period,
    localScore: mine?.mine ?? 0,
    localRank: (mine?.above ?? 0) + 1,
    pageIndex: page,
    pageSize,
    hasMore: rows.results.length > pageSize,
    rows: list.map((r, i) => ({ rank: page * pageSize + i + 1, displayName: r.display_name, score: r.score, isLocal: r.player_id === playerId })),
  };
}

/** The statement recording one hand for the boards (keyed per player, table and hand: a replay adds nothing). */
export function handResultStatement(db: D1Database, playerId: string, f: { tableId: string; hand: number; net: number; won: boolean }, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO hand_results (player_id, table_id, hand, net, won, week, season, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (player_id, table_id, hand) DO NOTHING`,
    )
    .bind(playerId, f.tableId, f.hand, Math.trunc(f.net), f.won ? 1 : 0, FreePlayLeaderboardMath.weekId(now), FreePlayLeaderboardMath.seasonId(now), now);
}
