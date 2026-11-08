/**
 * Game integrity signals (Phase 7): collusion and bot detection from what the game server records. These are leads
 * for a person to review (GET /v1/admin/integrity), never automatic bans.
 *
 * - Chip dumping: two players between whom chips flow one way, over many hands together.
 * - Marathons: accounts playing 18+ distinct hours of a day (people sleep; scripts don't).
 * - Robotic timing: decisions that are very fast and very even (think time recorded per decision).
 * - Win-rate outliers: a big edge over many hands (a strong player, or a bot / a team; worth a look).
 */

export interface IntegrityOptions {
  sinceMs?: number;
  now?: number;
  /** Chip dumping: coins moved one way between a pair before it is flagged. */
  minFlow?: number;
  /** Chip dumping: share of the pair's flow going one way (0.5 = balanced, 1 = all one way). */
  minOneWay?: number;
  minHandsTogether?: number;
}

const HOUR = 3_600_000;

export async function integrityReport(db: D1Database, opts: IntegrityOptions = {}) {
  const now = opts.now ?? Date.now();
  const since = opts.sinceMs ?? now - 30 * 86_400_000;
  const minFlow = opts.minFlow ?? 5000;
  const minOneWay = opts.minOneWay ?? 0.9;
  const minHands = opts.minHandsTogether ?? 10;

  // Chip flow between human pairs: in each hand, a loser's loss is shared among the human winners pro rata.
  const flows = (
    await db
      .prepare(
        `WITH w AS (SELECT table_id, hand, sum(net) AS wins FROM hand_results WHERE net > 0 AND created_at >= ?1 GROUP BY table_id, hand),
              f AS (
                SELECT l.player_id AS from_id, g.player_id AS to_id, (-l.net) * 1.0 * g.net / w.wins AS flow
                FROM hand_results l
                JOIN hand_results g ON g.table_id = l.table_id AND g.hand = l.hand AND g.net > 0
                JOIN w ON w.table_id = l.table_id AND w.hand = l.hand
                WHERE l.net < 0 AND l.created_at >= ?1),
              t AS (
                SELECT a.player_id AS p1, b.player_id AS p2, count(*) AS together
                FROM hand_results a JOIN hand_results b ON b.table_id = a.table_id AND b.hand = a.hand AND b.player_id > a.player_id
                WHERE a.created_at >= ?1 GROUP BY a.player_id, b.player_id)
         SELECT t.p1, t.p2, t.together,
           coalesce((SELECT sum(flow) FROM f WHERE f.from_id = t.p1 AND f.to_id = t.p2), 0) AS p1_to_p2,
           coalesce((SELECT sum(flow) FROM f WHERE f.from_id = t.p2 AND f.to_id = t.p1), 0) AS p2_to_p1
         FROM t WHERE t.together >= ?2`,
      )
      .bind(since, minHands)
      .all<{ p1: string; p2: string; together: number; p1_to_p2: number; p2_to_p1: number }>()
  ).results;
  const chipDumping = flows
    .map((r) => {
      const total = r.p1_to_p2 + r.p2_to_p1;
      const [from, to, amount] = r.p1_to_p2 >= r.p2_to_p1 ? [r.p1, r.p2, r.p1_to_p2] : [r.p2, r.p1, r.p2_to_p1];
      return { from, to, coins: Math.round(amount), oneWay: total ? Math.round((amount / total) * 100) / 100 : 0, handsTogether: r.together };
    })
    .filter((r) => r.coins >= minFlow && r.oneWay >= minOneWay)
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 50);

  // Marathons: distinct hours with a hand in the last 24 hours.
  const marathons = (
    await db
      .prepare(
        `SELECT player_id, count(DISTINCT created_at / ${HOUR}) AS hours, count(*) AS hands
         FROM hand_results WHERE created_at >= ?1 GROUP BY player_id HAVING hours >= 18 ORDER BY hours DESC LIMIT 50`,
      )
      .bind(now - 24 * HOUR)
      .all<{ player_id: string; hours: number; hands: number }>()
  ).results;

  // Robotic timing: many decisions, a fast median-ish average and very little spread.
  const timing = (
    await db
      .prepare(
        `SELECT player_id, count(*) AS n, avg(think_ms) AS avg_ms,
           avg(think_ms * think_ms) - avg(think_ms) * avg(think_ms) AS var_ms
         FROM style_decisions WHERE created_at >= ?1 AND think_ms IS NOT NULL GROUP BY player_id HAVING n >= 200`,
      )
      .bind(since)
      .all<{ player_id: string; n: number; avg_ms: number; var_ms: number }>()
  ).results;
  const robotic = timing
    .map((t) => ({ player: t.player_id, decisions: t.n, avgMs: Math.round(t.avg_ms), sdMs: Math.round(Math.sqrt(Math.max(0, t.var_ms))) }))
    .filter((t) => t.avgMs < 700 || t.sdMs < 150)
    .sort((a, b) => a.sdMs - b.sdMs)
    .slice(0, 50);

  // Win-rate outliers: big blinds per 100 hands over 500+ hands.
  const winners = (
    await db
      .prepare(
        `SELECT player_id, count(*) AS hands, sum(net * 1.0 / max(big_blind, 1)) * 100.0 / count(*) AS bb100
         FROM style_hands WHERE created_at >= ?1 GROUP BY player_id HAVING hands >= 500 AND bb100 >= 150 ORDER BY bb100 DESC LIMIT 50`,
      )
      .bind(since)
      .all<{ player_id: string; hands: number; bb100: number }>()
  ).results.map((w) => ({ player: w.player_id, hands: w.hands, bb100: Math.round(w.bb100) }));

  return {
    at: new Date(now).toISOString(),
    since: new Date(since).toISOString(),
    rules: { minFlow, minOneWay, minHandsTogether: minHands, marathonHours: 18, roboticAvgMs: 700, roboticSdMs: 150, winRateBb100: 150 },
    chipDumping,
    marathons: marathons.map((m) => ({ player: m.player_id, hoursInLastDay: m.hours, hands: m.hands })),
    robotic,
    winRateOutliers: winners,
  };
}
