import {
  newAgentHandRecord, newAgentProgress, newAgentSummary,
  type AgentDeploymentProgress, type AgentDeploymentSummary, type AgentHandHistory, type AgentHandRecord, type AgentSessionHistory,
  type CopyFeeInfo, type StreetProfileSnapshot,
} from '@nomad/engine/agents';
import { balances, conditionalPostingStatement, isInsufficientFunds, postingStatement } from './ledger';
import { settleCopy } from './style/fees';
import { StakeCatalog } from '@nomad/engine/stakes/stakes';
import { fail } from './util';

/**
 * Agent sessions (migrations/0005). The game server seats them at its Quick Play tables; this module is their
 * book-keeping and their money:
 * - start: the row and the bankroll debit are one batch, so an Agent exists exactly when its bankroll has left;
 * - every hand: the record and a stack checkpoint;
 * - complete: the row closes and the stack goes back (minus a copied strategy's fees, which go to its creator) in one
 *   batch, keyed so a repeat pays nothing.
 * A table that dies with an Agent seated leaves a 'playing' row nobody updates; `staleDeployments` finds them and the
 * game server completes them with the last checkpoint once the room says it no longer holds them.
 */

export type AgentPhase = 'queued' | 'playing' | 'completed' | 'failed';

export interface AgentStrategy {
  hasCustom: boolean;
  foldBelow: number;
  raiseAbove: number;
  aggression: number;
  bluffChance: number;
  raiseFractionOfPot: number;
  positionWeight: number;
  brain: number;
  streets: StreetProfileSnapshot[] | null;
}

export interface AgentRow {
  id: string;
  owner_id: string;
  agent_name: string;
  profile: string;
  strategy_version: string;
  strategy_id: string | null;
  strategy: string;
  bankroll: number;
  stake: number;
  max_hands: number;
  max_runtime: number;
  stop_loss: number;
  profit_target: number;
  phase: AgentPhase;
  stop_requested: number;
  stop_reason: string;
  room: string | null;
  hands_played: number;
  stack: number;
  net_pnl: number;
  runtime_seconds: number;
  wins: number;
  losses: number;
  showdowns: number;
  returned: number;
  copy_fee: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

/** POST /v1/agents/start: AgentDeployService.StartRequest, as the client sends it. */
export interface AgentStartInput {
  session: string;
  agentName?: string;
  profile?: string;
  strategyVersion?: string;
  bankroll?: number;
  maxHands?: number;
  maxRuntime?: number;
  stopLoss?: number;
  profitTarget?: number;
  stake?: number;
  hasCustom?: boolean;
  foldBelow?: number;
  raiseAbove?: number;
  aggression?: number;
  bluffChance?: number;
  raiseFractionOfPot?: number;
  positionWeight?: number;
  brain?: number;
  streets?: StreetProfileSnapshot[] | null;
  strategyId?: string | null;
}

export const AGENT_SESSION = /^[A-Za-z0-9]{4,16}$/;
/** A table that hasn't checkpointed an Agent for this long may have died with it (it is asked before anything is paid). */
export const AGENT_STALE_MS = 120_000;
export const MAX_AGENT_BANKROLL = 10_000_000;

const ACTIVE = `('queued', 'playing')`;
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const int = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.trunc(num(v));
  return n ? Math.max(lo, Math.min(hi, n)) : dflt;
};
const isUnique = (err: unknown) => /UNIQUE constraint failed|PRIMARY KEY/i.test(String((err as Error)?.message ?? err));

export async function agentRow(db: D1Database, id: string): Promise<AgentRow | null> {
  return db.prepare('SELECT * FROM agent_deployments WHERE id = ?1').bind(id).first<AgentRow>();
}

export async function activeAgent(db: D1Database, ownerId: string): Promise<AgentRow | null> {
  return db.prepare(`SELECT * FROM agent_deployments WHERE owner_id = ?1 AND phase IN ${ACTIVE} ORDER BY created_at DESC LIMIT 1`).bind(ownerId).first<AgentRow>();
}

/** The owner's own deployment, or a 403/404. */
export async function ownedAgent(db: D1Database, id: string, ownerId: string): Promise<AgentRow> {
  const row = await agentRow(db, id);
  if (!row) fail(404, 'not_found', 'Unknown agent deployment.');
  if (row.owner_id !== ownerId) fail(403, 'forbidden', 'Deployment does not belong to you.');
  return row;
}

export function strategyOf(row: AgentRow): AgentStrategy {
  try {
    return JSON.parse(row.strategy) as AgentStrategy;
  } catch {
    return { hasCustom: false, foldBelow: 0, raiseAbove: 0, aggression: 0, bluffChance: 0, raiseFractionOfPot: 0, positionWeight: 0, brain: 0, streets: null };
  }
}

/**
 * Queues an Agent and takes its bankroll, atomically. `profile` overrides the strategy numbers (a copied market
 * strategy plays its published numbers, not whatever the client sent).
 */
export async function startAgent(
  db: D1Database,
  ownerId: string,
  input: AgentStartInput,
  opts: { strategy?: AgentStrategy | null; now?: number } = {},
): Promise<AgentRow> {
  const now = opts.now ?? Date.now();
  const id = String(input.session ?? '');
  if (!AGENT_SESSION.test(id)) fail(400, 'bad_request', 'Invalid agent session code.');
  const bankroll = Math.trunc(num(input.bankroll)) || 5000;
  const lowest = StakeCatalog.Lowest.minBuyIn;
  if (bankroll < lowest || bankroll > MAX_AGENT_BANKROLL) fail(400, 'bad_request', `The bankroll must be between ${lowest} and ${MAX_AGENT_BANKROLL}.`);
  // The table is sized to the bankroll (a tenth of it at most as the table's minimum buy-in), whatever stake the
  // client asked for: an Agent sits with its whole bankroll, so a deep stack at a small table survives a bad hand.
  const stake = StakeCatalog.forAgentBankroll(bankroll).minBuyIn;
  const strategy: AgentStrategy = opts.strategy ?? {
    hasCustom: !!input.hasCustom,
    foldBelow: num(input.foldBelow),
    raiseAbove: num(input.raiseAbove),
    aggression: num(input.aggression),
    bluffChance: num(input.bluffChance),
    raiseFractionOfPot: num(input.raiseFractionOfPot),
    positionWeight: num(input.positionWeight),
    brain: Math.trunc(num(input.brain)),
    streets: Array.isArray(input.streets) ? input.streets.slice(0, 4) : null,
  };
  const text = (v: unknown, max: number, dflt: string) => (String(v ?? '').trim().slice(0, max) || dflt);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO agent_deployments (id, owner_id, agent_name, profile, strategy_version, strategy_id, strategy, bankroll, stake,
             max_hands, max_runtime, stop_loss, profit_target, phase, stack, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'queued', ?8, ?14, ?14)`,
        )
        .bind(
          id, ownerId, text(input.agentName, 24, 'Agent'), text(input.profile, 24, 'balanced'), text(input.strategyVersion, 40, 'v1'),
          input.strategyId ? String(input.strategyId) : null, JSON.stringify(strategy), bankroll, stake,
          // Same caps as the engine (AgentDeploymentConfig.normalize): 5,000 hands, 24 hours.
          int(input.maxHands, 1, 5_000, 100), int(input.maxRuntime, 60, 86_400, 3600),
          Math.max(0, Math.trunc(num(input.stopLoss))), Math.max(0, Math.trunc(num(input.profitTarget))), now,
        ),
      postingStatement(db, { playerId: ownerId, currency: 'coins', delta: -bankroll, reason: 'agent:bankroll', ref: id, idempotencyKey: `agent:${id}:bankroll` }, now),
    ]);
  } catch (err) {
    if (isInsufficientFunds(err)) fail(409, 'insufficient_funds', `Your Agent needs ${bankroll.toLocaleString('en-US')} coins; you have ${(await balances(db, ownerId)).coins.toLocaleString('en-US')}.`);
    if (isUnique(err)) {
      if (await activeAgent(db, ownerId)) fail(409, 'conflict', 'Your Agent is already playing. Stop it before deploying again.');
      fail(409, 'conflict', 'That Agent session already exists.');
    }
    throw err;
  }
  return (await agentRow(db, id))!;
}

/** A table took the Agent. False when it is no longer queued (stopped meanwhile). */
export async function markSeated(db: D1Database, id: string, room: string, now = Date.now()): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE agent_deployments SET phase = 'playing', room = ?2, updated_at = ?3 WHERE id = ?1 AND phase = 'queued'`)
    .bind(id, room, now)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** The table couldn't seat it after all: back to the queue. */
export async function markUnseated(db: D1Database, id: string, room: string, now = Date.now()): Promise<void> {
  await db
    .prepare(`UPDATE agent_deployments SET phase = 'queued', room = NULL, updated_at = ?3 WHERE id = ?1 AND phase = 'playing' AND room = ?2 AND hands_played = 0`)
    .bind(id, room, now)
    .run();
}

export interface HandCheckpoint {
  record: AgentHandRecord;
  replayJson: string | null;
  handsPlayed: number;
  stack: number;
  runtimeSeconds: number;
  wins: number;
  losses: number;
  showdowns: number;
}

/** One finished hand: its record (idempotent per hand number) and the stack checkpoint, fenced to the seating room. */
export async function recordAgentHand(db: D1Database, id: string, room: string, h: HandCheckpoint, now = Date.now()): Promise<void> {
  const record = { ...newAgentHandRecord(), ...h.record, ReplayJson: '', HasReplay: !!h.replayJson };
  await db.batch([
    db
      .prepare(
        `INSERT INTO agent_hands (deployment_id, hand_number, net, record, replay, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM agent_deployments WHERE id = ?1 AND room = ?7 AND phase = 'playing')
         ON CONFLICT (deployment_id, hand_number) DO NOTHING`,
      )
      .bind(id, record.HandNumber, record.NetPnl, JSON.stringify(record), h.replayJson || null, now, room),
    db
      .prepare(
        `UPDATE agent_deployments SET hands_played = ?3, stack = ?4, net_pnl = ?4 - bankroll, runtime_seconds = ?5, wins = ?6,
           losses = ?7, showdowns = ?8, updated_at = ?9
         WHERE id = ?1 AND room = ?2 AND phase = 'playing'`,
      )
      .bind(id, room, h.handsPlayed, h.stack, h.runtimeSeconds, h.wins, h.losses, h.showdowns, now),
  ]);
}

/** A table is still running these Agents: keep their rows fresh between hands (no hand = no checkpoint otherwise). */
export async function touchAgents(db: D1Database, room: string, ids: string[], now = Date.now()): Promise<void> {
  if (!ids.length) return;
  await db.batch(ids.map((id) => db.prepare(`UPDATE agent_deployments SET updated_at = ?3 WHERE id = ?1 AND room = ?2 AND phase = 'playing'`).bind(id, room, now)));
}

export async function requestAgentStop(db: D1Database, id: string, now = Date.now()): Promise<void> {
  await db.prepare(`UPDATE agent_deployments SET stop_requested = 1, updated_at = ?2 WHERE id = ?1 AND phase IN ${ACTIVE}`).bind(id, now).run();
}

export interface AgentCompletion {
  stopReason: string;
  endingStack: number;
  /** 'failed': the table was lost (no copy fee is charged). */
  phase?: 'completed' | 'failed';
  handsPlayed?: number;
  runtimeSeconds?: number;
  wins?: number;
  losses?: number;
  showdowns?: number;
  /** Fence: only the room that seated it may complete a playing Agent (null: a queued Agent, or the stale-row sweep). */
  room?: string | null;
  /**
   * The phase the caller saw (default: the phase read here). The completion applies only if the row is still in it, so
   * a queued Agent stopped by its owner can't be paid back after a table has seated it meanwhile (security review).
   */
  from?: 'queued' | 'playing';
}

/**
 * Ends a deployment and pays its stack back, once. A copied strategy (someone else's, completed normally) pays the
 * profit share first: the creator's 8 % is credited to them in the same batch; the platform's 2 % is withheld.
 * Returns the row as it stands afterwards (a repeat call changes nothing and pays nothing).
 */
export async function completeAgent(db: D1Database, id: string, c: AgentCompletion, now = Date.now()): Promise<AgentRow | null> {
  const row = await agentRow(db, id);
  if (!row) return null;
  if (row.phase === 'completed' || row.phase === 'failed') return row;
  if (c.room && row.room && row.room !== c.room) return row;
  const from = c.from ?? row.phase;
  if (row.phase !== from) return row;
  const phase = c.phase ?? 'completed';
  const ending = Math.max(0, Math.trunc(c.endingStack));

  // The profit share, from the copier's high-water mark for this strategy.
  let fee: CopyFeeInfo | null = null;
  let creatorId: string | null = null;
  let position: { cumulativePnl: number; highWater: number } | null = null;
  if (phase === 'completed' && row.strategy_id) {
    const s = await db.prepare('SELECT creator_id FROM strategies WHERE id = ?1').bind(row.strategy_id).first<{ creator_id: string }>();
    if (s && s.creator_id !== row.owner_id) {
      creatorId = s.creator_id;
      const prev = await db
        .prepare('SELECT cumulative_pnl, high_water FROM copy_positions WHERE copier_id = ?1 AND strategy_id = ?2')
        .bind(row.owner_id, row.strategy_id)
        .first<{ cumulative_pnl: number; high_water: number }>();
      const st = settleCopy({ cumulativePnl: prev?.cumulative_pnl ?? 0, highWater: prev?.high_water ?? 0 }, ending - row.bankroll);
      fee = { strategyId: row.strategy_id, sessionPnl: st.sessionPnl, feeBase: st.feeBase, creatorFee: st.creatorFee, platformFee: st.platformFee };
      position = st.next;
    }
  }
  const fees = fee ? fee.creatorFee + fee.platformFee : 0;
  const returned = Math.max(0, ending - fees);

  // Every statement after the UPDATE is conditional on it having happened: no coins move for a completion that lost a
  // race (the phase changed under it, another completion won, another room holds it).
  const done = `EXISTS (SELECT 1 FROM agent_deployments WHERE id = ?1 AND phase = '${phase}' AND completed_at = ?2)`;
  const did = `EXISTS (SELECT 1 FROM agent_deployments WHERE id = ?8 AND phase = '${phase}' AND completed_at = ?9 AND returned = ?10)`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE agent_deployments SET phase = ?2, stop_reason = ?3, stack = ?4, net_pnl = ?4 - bankroll, returned = ?5, copy_fee = ?6,
           hands_played = COALESCE(?7, hands_played), runtime_seconds = COALESCE(?8, runtime_seconds), wins = COALESCE(?9, wins),
           losses = COALESCE(?10, losses), showdowns = COALESCE(?11, showdowns), stop_requested = 0, completed_at = ?12, updated_at = ?12
         WHERE id = ?1 AND phase = ?13 AND (?14 IS NULL OR room = ?14)`,
      )
      .bind(id, phase, c.stopReason, ending, returned, fee ? JSON.stringify(fee) : null, c.handsPlayed ?? null, c.runtimeSeconds ?? null,
        c.wins ?? null, c.losses ?? null, c.showdowns ?? null, now, from, c.room ?? null),
  ];
  if (fee && creatorId && position) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO copy_positions (copier_id, strategy_id, cumulative_pnl, high_water, updated_at)
           SELECT ?3, ?4, ?5, ?6, ?2 WHERE ${done} AND NOT EXISTS (SELECT 1 FROM copy_fees WHERE deployment_id = ?1)
           ON CONFLICT (copier_id, strategy_id) DO UPDATE SET cumulative_pnl = excluded.cumulative_pnl, high_water = excluded.high_water, updated_at = excluded.updated_at`,
        )
        .bind(id, now, row.owner_id, row.strategy_id, position.cumulativePnl, position.highWater),
      db
        .prepare(
          `INSERT INTO copy_fees (deployment_id, strategy_id, copier_id, creator_id, session_pnl, fee_base, creator_fee, platform_fee, created_at)
           SELECT ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?2 WHERE ${done}
           ON CONFLICT (deployment_id) DO NOTHING`,
        )
        .bind(id, now, row.strategy_id, row.owner_id, creatorId, fee.sessionPnl, fee.feeBase, fee.creatorFee, fee.platformFee),
    );
    if (fee.creatorFee > 0) {
      stmts.push(
        conditionalPostingStatement(
          db,
          { playerId: creatorId, currency: 'coins', delta: fee.creatorFee, reason: 'strategy:copy_fee', ref: id, idempotencyKey: `copyfee:${id}` },
          did,
          [id, now, returned],
          now,
        ),
      );
    }
  }
  if (returned > 0) {
    stmts.push(
      conditionalPostingStatement(
        db,
        { playerId: row.owner_id, currency: 'coins', delta: returned, reason: 'agent:return', ref: id, idempotencyKey: `agent:${id}:return` },
        did,
        [id, now, returned],
        now,
      ),
    );
  }
  await db.batch(stmts);
  return agentRow(db, id);
}

/** Playing Agents whose table has gone quiet (the game server asks each room before completing them). */
export async function staleAgents(db: D1Database, now = Date.now()): Promise<AgentRow[]> {
  const r = await db
    .prepare(`SELECT * FROM agent_deployments WHERE phase = 'playing' AND updated_at < ?1 ORDER BY updated_at LIMIT 50`)
    .bind(now - AGENT_STALE_MS)
    .all<AgentRow>();
  return r.results;
}

/** Agents still waiting for a seat (the game server tries to place them again). */
export async function queuedAgents(db: D1Database, olderThanMs = 15_000, now = Date.now()): Promise<AgentRow[]> {
  const r = await db
    .prepare(`SELECT * FROM agent_deployments WHERE phase = 'queued' AND updated_at < ?1 ORDER BY created_at LIMIT 50`)
    .bind(now - olderThanMs)
    .all<AgentRow>();
  return r.results;
}

// ---- What the owner reads (Unity wire shapes, so the client's Agent screens read them unchanged) ------------------

const unix = (ms: number | null | undefined) => (ms ? Math.floor(ms / 1000) : 0);

export function summaryOf(row: AgentRow): AgentDeploymentSummary {
  let fee: CopyFeeInfo | null = null;
  try {
    fee = row.copy_fee ? (JSON.parse(row.copy_fee) as CopyFeeInfo) : null;
  } catch {
    fee = null;
  }
  return newAgentSummary({
    DeploymentId: row.id, OwnerPlayFabId: row.owner_id, StrategyPreset: row.profile, StrategyVersion: row.strategy_version,
    StopReason: row.stop_reason, HandsPlayed: row.hands_played, StartingBankroll: row.bankroll, EndingStack: row.stack,
    NetPnl: row.stack - row.bankroll, RuntimeSeconds: row.runtime_seconds, SessionName: row.room ?? '', CompletedUnix: unix(row.completed_at),
    Wins: row.wins, Losses: row.losses, Showdowns: row.showdowns, CopyFee: fee, ServerSettled: true,
  });
}

function handOf(r: { record: string; replay: string | null }, withReplay: boolean): AgentHandRecord {
  let rec: AgentHandRecord;
  try {
    rec = { ...newAgentHandRecord(), ...(JSON.parse(r.record) as AgentHandRecord) };
  } catch {
    rec = newAgentHandRecord();
  }
  return { ...rec, ReplayJson: withReplay ? r.replay ?? '' : '', HasReplay: !!r.replay };
}

export async function agentProgress(db: D1Database, row: AgentRow): Promise<AgentDeploymentProgress> {
  const recent = await db
    .prepare('SELECT record, replay FROM agent_hands WHERE deployment_id = ?1 ORDER BY hand_number DESC LIMIT 10')
    .bind(row.id)
    .all<{ record: string; replay: string | null }>();
  const active = row.phase === 'queued' || row.phase === 'playing';
  return newAgentProgress({
    running: active,
    stopRequested: !!row.stop_requested,
    HandsPlayed: row.hands_played,
    MaxHands: row.max_hands,
    StartingBankroll: row.bankroll,
    Stack: row.stack,
    NetPnl: row.stack - row.bankroll,
    RuntimeSeconds: row.runtime_seconds,
    // The farm's phases: 'queued' (looking for a table), 'playing', 'stop_requested', 'completed' / 'failed'.
    phase: active && row.stop_requested ? 'stop_requested' : row.phase,
    AssignedTable: row.room ?? '',
    CurrentHand: row.hands_played + 1,
    Wins: row.wins,
    Losses: row.losses,
    Showdowns: row.showdowns,
    stake: row.stake,
    updatedUnix: unix(row.updated_at),
    createdUnix: unix(row.created_at),
    RecentHands: recent.results.reverse().map((h) => handOf(h, false)),
  });
}

export function agentResult(row: AgentRow): AgentDeploymentSummary | null {
  return row.phase === 'completed' || row.phase === 'failed' ? summaryOf(row) : null;
}

export async function agentHistory(db: D1Database, ownerId: string, limit: number, offset: number): Promise<AgentSessionHistory> {
  const lim = Math.max(1, Math.min(Math.trunc(limit) || 20, 100));
  const off = Math.max(0, Math.trunc(offset) || 0);
  const [rows, total] = await db.batch([
    db
      .prepare(`SELECT * FROM agent_deployments WHERE owner_id = ?1 AND phase IN ('completed', 'failed') ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`)
      .bind(ownerId, lim, off),
    db.prepare(`SELECT count(*) AS n FROM agent_deployments WHERE owner_id = ?1 AND phase IN ('completed', 'failed')`).bind(ownerId),
  ]);
  return { Sessions: (rows!.results as AgentRow[]).map(summaryOf), Total: Number((total!.results[0] as { n: number }).n) };
}

export async function agentHands(db: D1Database, deploymentId: string, limit: number, offset: number): Promise<AgentHandHistory> {
  const lim = Math.max(1, Math.min(Math.trunc(limit) || 100, 100));
  const off = Math.max(0, Math.trunc(offset) || 0);
  const [rows, total] = await db.batch([
    db.prepare('SELECT record, replay FROM agent_hands WHERE deployment_id = ?1 ORDER BY hand_number DESC LIMIT ?2 OFFSET ?3').bind(deploymentId, lim, off),
    db.prepare('SELECT count(*) AS n FROM agent_hands WHERE deployment_id = ?1').bind(deploymentId),
  ]);
  return {
    Hands: (rows!.results as { record: string; replay: string | null }[]).map((h) => handOf(h, true)),
    Total: Number((total!.results[0] as { n: number }).n),
  };
}
