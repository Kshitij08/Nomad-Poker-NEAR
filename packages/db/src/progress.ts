import { RewardKind, type RewardGrant } from '@nomad/engine/economy/rewards';
import { HandCategory } from '@nomad/engine/evaluation/handCategory';
import {
  DailySpinMath,
  LevelRewardCatalog,
  LoginClaimPreview,
  LoginStreakMath,
  MissionCatalog,
  MissionKind,
  MissionProgressMath,
  PlayerLevelMath,
  UtcDay,
  rewardPreview,
  type MissionBoardState,
} from '@nomad/engine/retention';
import type { Currency, LoginClaimResponse, MissionClaimResponse, ProgressSnapshot, SpinResponse } from '@nomad/contract';
import { balances, postingStatement } from './ledger';
import { handResultStatement } from './leaderboards';
import { utf8 } from './util';

/**
 * Retention, decided on the server (migrations/0003_progress.sql). The rules are the engine's — the same catalogues
 * and maths the Unity client and the web port use — but the server rolls the spin, reads the streak, counts hands and
 * pays. Every grant carries an idempotency key (per day, per mission period, per level, per hand), so a retried or
 * repeated request can never pay twice.
 */

export interface ProgressRow {
  player_id: string;
  last_spin_day: number;
  last_spin_coins: number;
  last_login_day: number;
  streak_day: number;
  mission_board: string;
  rewarded_level: number;
  version: number;
  updated_at: number;
}

const CURRENCY: Partial<Record<RewardKind, Currency>> = {
  [RewardKind.Coins]: 'coins',
  [RewardKind.Gems]: 'gems',
  [RewardKind.Xp]: 'xp',
  [RewardKind.StreakToken]: 'streak_tokens',
};

export const XP_PER_HAND_PLAYED = 10;
export const XP_PER_HAND_WON = 25;

const today = (now: number) => UtcDay.fromUtc(now);

async function row(db: D1Database, playerId: string, now: number): Promise<ProgressRow> {
  await db.prepare('INSERT INTO player_progress (player_id, updated_at) VALUES (?1, ?2) ON CONFLICT (player_id) DO NOTHING').bind(playerId, now).run();
  return (await db.prepare('SELECT * FROM player_progress WHERE player_id = ?1').bind(playerId).first<ProgressRow>())!;
}

function boardOf(r: ProgressRow, day: number): MissionBoardState {
  let board: MissionBoardState | null = null;
  try {
    board = r.mission_board ? (JSON.parse(r.mission_board) as MissionBoardState) : null;
  } catch {
    board = null;
  }
  return MissionProgressMath.ensureFresh(board, day);
}

/** Statements that pay `grants` (currencies to the ledger, cosmetics to owned_items), keyed `${key}:${i}`. */
export function grantStatements(db: D1Database, playerId: string, grants: readonly RewardGrant[], key: string, reason: string, now: number): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  grants.forEach((g, i) => {
    if (g.kind === RewardKind.Cosmetic) {
      if (g.itemId) {
        out.push(
          db.prepare('INSERT INTO owned_items (player_id, item_id, source, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING').bind(playerId, g.itemId, reason, now),
        );
      }
      return;
    }
    const currency = CURRENCY[g.kind];
    if (!currency || g.amount <= 0) return;
    out.push(postingStatement(db, { playerId, currency, delta: g.amount, reason, idempotencyKey: `${key}:${i}` }, now));
  });
  return out;
}

const saveBoard = (db: D1Database, r: ProgressRow, board: MissionBoardState, now: number) =>
  db
    .prepare('UPDATE player_progress SET mission_board = ?2, version = version + 1, updated_at = ?3 WHERE player_id = ?1 AND version = ?4')
    .bind(r.player_id, JSON.stringify(board), now, r.version);

/**
 * Pays every level reached but not yet rewarded (LevelRewardCatalog). Run after anything that adds XP. Returns the
 * levels it paid. Keys are per level, so two racing calls pay each level once.
 */
export async function settleLevels(db: D1Database, playerId: string, now = Date.now()): Promise<number[]> {
  const r = await row(db, playerId, now);
  const level = PlayerLevelMath.levelFromTotalXp((await balances(db, playerId)).xp);
  if (level <= r.rewarded_level) return [];
  const paid: number[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (let lv = Math.max(2, r.rewarded_level + 1); lv <= level; lv++) {
    stmts.push(...grantStatements(db, playerId, LevelRewardCatalog.rewardsForLevel(lv), `level_up:${lv}`, 'level_up', now));
    paid.push(lv);
  }
  stmts.push(
    db.prepare('UPDATE player_progress SET rewarded_level = ?2, updated_at = ?3 WHERE player_id = ?1 AND rewarded_level < ?2').bind(playerId, level, now),
  );
  await db.batch(stmts);
  return paid;
}

// ---- Daily spin ----------------------------------------------------------------------------------

/** The day's roll in [0, 999]: HMAC(secret, player:day). Unpredictable without the secret, and the same on a retry. */
export async function spinRoll(secret: string, playerId: string, day: number): Promise<number> {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new DataView(await crypto.subtle.sign('HMAC', key, utf8(`spin:${playerId}:${day}`)));
  return mac.getUint32(0) % 1000;
}

export async function spin(db: D1Database, playerId: string, secret: string, now = Date.now()): Promise<SpinResponse> {
  const day = today(now);
  const r = await row(db, playerId, now);
  if (!DailySpinMath.canSpin(r.last_spin_day, day)) {
    return { awarded: false, coins: r.last_spin_coins, label: '', error: 'Come back tomorrow for another spin.', progress: await snapshot(db, playerId, now) };
  }
  const prize = DailySpinMath.pickPrize(await spinRoll(secret, playerId, day));
  await db.batch([
    postingStatement(db, { playerId, currency: 'coins', delta: prize.coins, reason: 'daily_spin', idempotencyKey: `daily_spin:${day}` }, now),
    db.prepare('UPDATE player_progress SET last_spin_day = ?2, last_spin_coins = ?3, updated_at = ?4 WHERE player_id = ?1').bind(playerId, day, prize.coins, now),
  ]);
  return { awarded: true, coins: prize.coins, label: prize.label, error: '', progress: await snapshot(db, playerId, now) };
}

// ---- 7-day login track ---------------------------------------------------------------------------

export async function claimLogin(db: D1Database, playerId: string, now = Date.now()): Promise<LoginClaimResponse> {
  const day = today(now);
  const r = await row(db, playerId, now);
  const tokens = (await balances(db, playerId)).streak_tokens;
  const preview = LoginStreakMath.preview(r.last_login_day, day, r.streak_day, tokens);
  if (!preview.canClaim) {
    return { claimed: false, day: preview.day, tokenConsumed: false, reset: false, error: preview.error, progress: await snapshot(db, playerId, now) };
  }
  const reward = LoginClaimPreview.reward(preview);
  const grants = [reward.primary, reward.secondary, reward.tertiary].filter((g): g is RewardGrant => !!g);
  const stmts = grantStatements(db, playerId, grants, `login_reward:${day}`, 'login_reward', now);
  if (preview.tokenConsumed) {
    stmts.push(postingStatement(db, { playerId, currency: 'streak_tokens', delta: -1, reason: 'streak_shield', idempotencyKey: `streak_token:${day}` }, now));
  }
  stmts.push(
    db.prepare('UPDATE player_progress SET last_login_day = ?2, streak_day = ?3, updated_at = ?4 WHERE player_id = ?1').bind(playerId, day, preview.day, now),
  );
  await db.batch(stmts);
  await settleLevels(db, playerId, now);
  return { claimed: true, day: preview.day, tokenConsumed: preview.tokenConsumed, reset: preview.reset, error: '', progress: await snapshot(db, playerId, now) };
}

// ---- Missions ------------------------------------------------------------------------------------

/** The period a mission's claim belongs to: its UTC day (daily) or week (weekly). */
const periodOf = (id: string, day: number) => (MissionCatalog.tryGet(id)?.weekly ? `w${MissionProgressMath.weekFromDay(day)}` : `d${day}`);

export async function claimMission(db: D1Database, playerId: string, id: string, now = Date.now()): Promise<MissionClaimResponse> {
  const day = today(now);
  const def = MissionCatalog.tryGet(id);
  if (!def) return { ok: false, message: 'No such mission.', progress: await snapshot(db, playerId, now) };
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await row(db, playerId, now);
    const board = boardOf(r, day);
    const rewards = MissionProgressMath.tryClaim(board, id, day);
    if (!rewards) return { ok: false, message: 'Not ready to claim.', progress: await snapshot(db, playerId, now) };
    // Board first: if another writer moved it, nothing below is kept for long — the retry re-reads, finds the claim
    // (or not), and the grants' keys make any repeat a no-op.
    const results = await db.batch([saveBoard(db, r, board, now), ...grantStatements(db, playerId, rewards, `mission:${id}:${periodOf(id, day)}`, 'mission', now)]);
    if ((results[0]!.meta.changes ?? 0) === 0) continue;
    await settleLevels(db, playerId, now);
    const preview = rewardPreview(def);
    return { ok: true, message: preview ? `Claimed! ${preview}` : 'Mission claimed!', progress: await snapshot(db, playerId, now) };
  }
  return { ok: false, message: 'Busy — try again.', progress: await snapshot(db, playerId, now) };
}

// ---- Table progress (written by the game server) ---------------------------------------------------

export interface HandFacts {
  tableId: string;
  hand: number;
  won: boolean;
  /** The player's showdown hand category (HandCategory), or null without a showdown. */
  showdownCategory: number | null;
  /** Chips won (+) or lost (−) in the hand, for the leaderboards. */
  net: number;
}

/** One hand a human was dealt into: XP and mission progress. Idempotent per (table, hand). Returns levels paid. */
export async function recordHand(db: D1Database, playerId: string, f: HandFacts, now = Date.now()): Promise<number[]> {
  const day = today(now);
  const xp = XP_PER_HAND_PLAYED + (f.won ? XP_PER_HAND_WON : 0);
  const key = `xp:${f.tableId}:${f.hand}`;
  // A replayed hand (the table retrying its bookkeeping) changes nothing: its XP entry already exists.
  if (await db.prepare('SELECT 1 FROM ledger_entries WHERE player_id = ?1 AND idempotency_key = ?2').bind(playerId, key).first()) return [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await row(db, playerId, now);
    const board = boardOf(r, day);
    MissionProgressMath.advance(board, MissionKind.PlayHands, 1, day);
    MissionProgressMath.advance(board, MissionKind.WeeklyHands, 1, day);
    if (f.won) {
      MissionProgressMath.advance(board, MissionKind.WinHands, 1, day);
      // "Win with a pair or better": the winner's showdown hand (a loser's pair does not count).
      if (f.showdownCategory !== null && f.showdownCategory >= HandCategory.Pair) MissionProgressMath.advance(board, MissionKind.WinPairOrBetter, 1, day);
      if (f.showdownCategory !== null && f.showdownCategory >= HandCategory.TwoPair) MissionProgressMath.advance(board, MissionKind.WinTwoPairOrBetter, 1, day);
    }
    const results = await db.batch([
      saveBoard(db, r, board, now),
      postingStatement(db, { playerId, currency: 'xp', delta: xp, reason: f.won ? 'hand_won' : 'hand_played', ref: f.tableId, idempotencyKey: key }, now),
      handResultStatement(db, playerId, { tableId: f.tableId, hand: f.hand, net: f.net, won: f.won }, now),
    ]);
    if ((results[0]!.meta.changes ?? 0) === 0) continue;
    return settleLevels(db, playerId, now);
  }
  return [];
}

/** "Play 2 tables": counts a session once per UTC day. */
export async function recordTableJoined(db: D1Database, playerId: string, session: string, now = Date.now()): Promise<void> {
  const day = today(now);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await row(db, playerId, now);
    const board = boardOf(r, day);
    if (!MissionProgressMath.tryCountTable(board, session, day)) return;
    const res = await saveBoard(db, r, board, now).run();
    if ((res.meta.changes ?? 0) > 0) return;
  }
}

// ---- Snapshot ------------------------------------------------------------------------------------

export async function snapshot(db: D1Database, playerId: string, now = Date.now()): Promise<ProgressSnapshot> {
  const day = today(now);
  const [r, bal, items] = await Promise.all([
    row(db, playerId, now),
    balances(db, playerId),
    db.prepare('SELECT item_id FROM owned_items WHERE player_id = ?1 ORDER BY created_at').bind(playerId).all<{ item_id: string }>(),
  ]);
  const board = boardOf(r, day);
  const login = LoginStreakMath.preview(r.last_login_day, day, r.streak_day, bal.streak_tokens);
  return {
    balances: bal,
    items: items.results.map((x) => x.item_id),
    today: day,
    level: PlayerLevelMath.levelFromTotalXp(bal.xp),
    rewardedLevel: r.rewarded_level,
    spin: { canSpin: DailySpinMath.canSpin(r.last_spin_day, day), lastSpinDay: r.last_spin_day, lastSpinCoins: r.last_spin_coins },
    login: {
      lastLoginDay: r.last_login_day,
      streakDay: r.streak_day,
      canClaim: login.canClaim,
      day: login.day,
      tokensAfter: login.tokensAfter,
      tokenConsumed: login.tokenConsumed,
      reset: login.reset,
      error: login.error,
    },
    missions: { dayNumber: board.dayNumber, weekNumber: board.weekNumber, slots: board.slots.map((s) => ({ id: s.id, progress: s.progress, claimed: s.claimed })) },
  };
}
