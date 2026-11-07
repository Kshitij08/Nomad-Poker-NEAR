/**
 * The Agent farm's book-keeping, in memory: a port of the backend's AgentDeploymentService (backend/src/services/
 * agentDeployments.ts) and of the /api/agent/* + /internal/agent/* routes' rules, without Postgres. Owners queue Agents
 * (start), tables claim them (claim), tables post progress, hands and completions, owners poll progress / stop / result
 * and read their history. Responses use the Unity wire shapes (AgentDeploymentProgress, AgentDeploymentSummary,
 * AgentSessionHistory, AgentHandHistory), so the client service reads them exactly as it reads the real backend's.
 *
 * No browser APIs. The browser's local backend runs one; the web table server can run one too (or proxy to the real
 * backend instead). State can be saved and restored as JSON (`snapshot()` / `AgentFarm.restore()`).
 */
import {
  newAgentDeploymentConfig, newAgentHandRecord, newAgentProgress, newAgentSummary,
  type AgentDeploymentConfig, type AgentDeploymentProgress, type AgentDeploymentSummary, type AgentHandHistory,
  type AgentHandRecord, type AgentSessionHistory, type StreetProfileSnapshot,
} from '../../core/agents';
import type { AgentProgressBody } from './agentTableHost';

export type AgentPhase = 'queued' | 'seated' | 'playing' | 'stop_requested' | 'settling' | 'completed' | 'failed';
const ACTIVE_PHASES: ReadonlySet<AgentPhase> = new Set(['queued', 'seated', 'playing', 'stop_requested', 'settling']);

/** AgentDeployService.StartRequest: the body of POST /api/agent/start. */
export interface AgentStartRequest {
  session: string;
  ownerId: string;
  deploymentId: string;
  agentName: string;
  profile: string;
  strategyVersion: string;
  bankroll: number;
  maxHands: number;
  maxRuntime: number;
  stopLoss: number;
  profitTarget: number;
  stake: number;
  hasCustom: boolean;
  foldBelow: number;
  raiseAbove: number;
  aggression: number;
  bluffChance: number;
  raiseFractionOfPot: number;
  positionWeight: number;
  brain: number;
  streets: StreetProfileSnapshot[] | null;
  strategyId: string | null;
}

/** AgentDeployService.PostAgentStartAsync's payload from a config. */
export function startRequestOf(config: AgentDeploymentConfig, session: string): AgentStartRequest {
  const p = config.Profile;
  return {
    session,
    ownerId: config.OwnerPlayFabId ?? '',
    deploymentId: config.DeploymentId ?? session,
    agentName: config.AgentName ?? 'Agent',
    profile: config.StrategyPreset ?? 'balanced',
    strategyVersion: config.StrategyVersion ?? 'v1',
    bankroll: config.Bankroll,
    maxHands: config.MaxHands,
    maxRuntime: config.MaxRuntimeSeconds,
    stopLoss: config.StopLoss,
    profitTarget: config.ProfitTarget,
    stake: config.MinBuyIn,
    hasCustom: p.HasCustom,
    foldBelow: p.FoldBelow,
    raiseAbove: p.RaiseAbove,
    aggression: p.Aggression,
    bluffChance: p.BluffChance,
    raiseFractionOfPot: p.RaiseFractionOfPot,
    positionWeight: p.PositionWeight,
    brain: p.Brain,
    streets: p.Streets,
    strategyId: config.StrategyId ? config.StrategyId : null,
  };
}

/** A deployment as the farm keeps it (one agent_deployments row). */
export interface DeploymentRow {
  deploymentId: string;
  ownerId: string;
  agentName: string;
  profile: string;
  strategyVersion: string;
  strategyId: string | null;
  strategy: Pick<AgentStartRequest, 'hasCustom' | 'foldBelow' | 'raiseAbove' | 'aggression' | 'bluffChance' | 'raiseFractionOfPot' | 'positionWeight' | 'brain' | 'streets'>;
  bankroll: number;
  maxHands: number;
  maxRuntimeSeconds: number;
  stopLoss: number;
  profitTarget: number;
  stake: number;
  phase: AgentPhase;
  stopRequested: boolean;
  stopReason: string;
  handsPlayed: number;
  stack: number;
  netPnl: number;
  runtimeSeconds: number;
  wins: number;
  losses: number;
  showdowns: number;
  assignedTable: string | null;
  createdUnix: number;
  updatedUnix: number;
  completedUnix: number;
  result: AgentDeploymentSummary | null;
  /** The farm took the bankroll from the owner's Coins (AgentMoney.fund): it pays the stack back on completion. */
  funded: boolean;
}

/** The farm's hold on owners' Coins (backend agentMoney.ts). Null: deployments are not funded (a demo). */
export interface AgentMoney {
  /** Takes the bankroll; throws (with a player-facing message) when it can't. */
  fund(deploymentId: string, ownerId: string, bankroll: number): void;
  /** The start failed after funding: give it straight back. */
  refund(deploymentId: string, ownerId: string, bankroll: number): void;
  /** The deployment ended: pay `amount` (the ending stack, minus any copy fee) back to the owner. */
  settle(deploymentId: string, ownerId: string, amount: number): void;
}

export class AgentFarmError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export interface AgentFarmOptions {
  /** Unix seconds. */
  now?: () => number;
  /** How long a queued Agent waits for a table that already has Agents before an empty table may take it. */
  joinWaitSeconds?: number;
  money?: AgentMoney | null;
  /** Hands kept per deployment (the backend keeps them all; a browser store stays small). 0 = all. */
  maxHandsKept?: number;
  /** Completed deployments kept per owner. 0 = all. */
  maxSessionsKept?: number;
}

interface HandRow {
  hand: AgentHandRecord;
  replayJson: string | null;
}

/** Party session code (backend isPartySessionName): 4-16 letters/digits. */
export const isAgentSessionCode = (s: string): boolean => /^[A-Za-z0-9]{4,16}$/.test(s);

export class AgentFarm {
  private readonly rows = new Map<string, DeploymentRow>();
  private readonly handRows = new Map<string, HandRow[]>();
  private readonly now: () => number;

  constructor(private readonly opts: AgentFarmOptions = {}) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // ---- persistence

  snapshot(): string {
    return JSON.stringify({ v: 1, rows: [...this.rows.values()], hands: [...this.handRows.entries()] });
  }

  static restore(json: string | null | undefined, opts: AgentFarmOptions = {}): AgentFarm {
    const farm = new AgentFarm(opts);
    farm.load(json);
    return farm;
  }

  /** Replaces the whole state with a snapshot (another process saved a newer one). A corrupt save loads as empty. */
  load(json: string | null | undefined): void {
    this.rows.clear();
    this.handRows.clear();
    if (!json) return;
    try {
      const o = JSON.parse(json) as { v: number; rows: DeploymentRow[]; hands: [string, HandRow[]][] };
      if (o.v !== 1) return;
      for (const r of o.rows ?? []) this.rows.set(r.deploymentId, r);
      for (const [id, hands] of o.hands ?? []) this.handRows.set(id, hands);
    } catch {
      /* start empty */
    }
  }

  /** Every row (for the local table runner and tests). */
  get deployments(): readonly DeploymentRow[] {
    return [...this.rows.values()];
  }

  row(deploymentId: string): DeploymentRow | null {
    return this.rows.get(deploymentId) ?? null;
  }

  // ---- owner API (/api/agent/*)

  /** POST /api/agent/start: one Agent at a time per owner; the bankroll leaves the owner's Coins before it's queued. */
  start(req: AgentStartRequest, ownerId: string): { session: string; status: 'ready'; kind: 'agent'; strategyId: string | null } {
    const session = String(req.session ?? '');
    if (!isAgentSessionCode(session)) throw new AgentFarmError(400, 'Invalid agent session code');
    if (!ownerId) throw new AgentFarmError(401, 'Sign in to deploy your Agent.');
    const running = this.running(ownerId, session);
    if (running) throw new AgentFarmError(409, 'Your Agent is already playing. Stop it before deploying again.', 'already_running');
    if (this.rows.has(session)) throw new AgentFarmError(409, 'That Agent session already exists.', 'duplicate');
    const stake = Math.max(50, Number(req.stake) || 1000);
    const bankroll = Math.max(stake, Math.floor(Number(req.bankroll) || 5000));
    const money = this.opts.money;
    if (money) money.fund(session, ownerId, bankroll);
    const now = this.now();
    try {
      this.rows.set(session, {
        deploymentId: session,
        ownerId,
        agentName: String(req.agentName ?? 'Agent'),
        profile: String(req.profile ?? 'balanced'),
        strategyVersion: String(req.strategyVersion ?? 'v1'),
        strategyId: req.strategyId ?? null,
        strategy: {
          hasCustom: !!req.hasCustom, foldBelow: num(req.foldBelow), raiseAbove: num(req.raiseAbove), aggression: num(req.aggression),
          bluffChance: num(req.bluffChance), raiseFractionOfPot: num(req.raiseFractionOfPot), positionWeight: num(req.positionWeight),
          brain: Math.trunc(num(req.brain)), streets: Array.isArray(req.streets) ? req.streets : null,
        },
        bankroll,
        maxHands: Math.trunc(num(req.maxHands)) || 100,
        maxRuntimeSeconds: Math.trunc(num(req.maxRuntime)) || 3600,
        stopLoss: Math.max(0, Math.trunc(num(req.stopLoss))),
        profitTarget: Math.max(0, Math.trunc(num(req.profitTarget))),
        stake,
        phase: 'queued',
        stopRequested: false,
        stopReason: '',
        handsPlayed: 0,
        stack: bankroll,
        netPnl: 0,
        runtimeSeconds: 0,
        wins: 0,
        losses: 0,
        showdowns: 0,
        assignedTable: null,
        createdUnix: now,
        updatedUnix: now,
        completedUnix: 0,
        result: null,
        funded: !!money,
      });
    } catch (e) {
      money?.refund(session, ownerId, bankroll);
      throw e;
    }
    return { session, status: 'ready', kind: 'agent', strategyId: req.strategyId ?? null };
  }

  /** GET /api/agent/progress: the live snapshot with its last 10 hands (no replay text). */
  progress(session: string, ownerId: string): AgentDeploymentProgress | null {
    const row = this.owned(session, ownerId);
    return row ? this.toProgress(row, this.recentHands(session, 10)) : null;
  }

  /** POST /api/agent/stop: a queued Agent completes at once with its bankroll; a seated one leaves after the hand. */
  stop(session: string, ownerId: string): AgentDeploymentProgress {
    const row = this.owned(session, ownerId);
    if (!row) throw new AgentFarmError(404, 'Unknown agent deployment');
    const now = this.now();
    if (row.phase === 'queued') {
      row.result = newAgentSummary({
        DeploymentId: session, OwnerPlayFabId: row.ownerId, StrategyPreset: row.profile, StrategyVersion: row.strategyVersion,
        StopReason: 'owner_stop', StartingBankroll: row.bankroll, EndingStack: row.bankroll, SessionName: '', CompletedUnix: now,
      });
      row.phase = 'completed';
      row.stopRequested = false;
      row.stopReason = 'owner_stop';
      row.completedUnix = now;
      this.settle(row);
    } else if (row.phase !== 'completed' && row.phase !== 'failed') {
      row.stopRequested = true;
      row.phase = 'stop_requested';
    }
    row.updatedUnix = now;
    return this.toProgress(row, null);
  }

  /** GET /api/agent/result: the summary once the deployment has completed (or failed), else null. */
  result(session: string, ownerId: string): AgentDeploymentSummary | null {
    const row = this.owned(session, ownerId);
    if (!row || (row.phase !== 'completed' && row.phase !== 'failed')) return null;
    return { ...this.summaryOf(row), ...(row.result ?? {}), ServerSettled: row.funded };
  }

  /** GET /api/agent/active: the owner's Agent still queued or playing (newest first). */
  active(ownerId: string): { deploymentId: string; bankroll: number } | null {
    const r = this.running(ownerId);
    return r ? { deploymentId: r.deploymentId, bankroll: r.bankroll } : null;
  }

  /** GET /api/agent/history: completed sessions, newest first. */
  history(ownerId: string, limit = 20, offset = 0): AgentSessionHistory {
    const done = this.ownerRows(ownerId).filter((r) => r.phase === 'completed' || r.phase === 'failed');
    const page = done.slice(Math.max(0, offset), Math.max(0, offset) + clampLimit(limit));
    return { Sessions: page.map((r) => ({ ...this.summaryOf(r), ...(r.result ?? {}) })), Total: done.length };
  }

  /** GET /api/agent/hands: a session's hands, newest first, with their replays. */
  hands(ownerId: string, deploymentId: string, limit = 100, offset = 0): AgentHandHistory {
    if (!this.owned(deploymentId, ownerId)) throw new AgentFarmError(403, 'Deployment does not belong to owner');
    const all = [...(this.handRows.get(deploymentId) ?? [])].sort((a, b) => b.hand.HandNumber - a.hand.HandNumber);
    const page = all.slice(Math.max(0, offset), Math.max(0, offset) + clampLimit(limit));
    return { Hands: page.map((h) => ({ ...h.hand, ReplayJson: h.replayJson ?? '', HasReplay: !!h.replayJson })), Total: all.length };
  }

  /** GET /api/agent/hand: one hand with its replay. */
  hand(ownerId: string, deploymentId: string, handNumber: number): AgentHandRecord | null {
    if (!this.owned(deploymentId, ownerId)) throw new AgentFarmError(403, 'Deployment does not belong to owner');
    const h = (this.handRows.get(deploymentId) ?? []).find((x) => x.hand.HandNumber === handNumber);
    return h ? { ...h.hand, ReplayJson: h.replayJson ?? '', HasReplay: !!h.replayJson } : null;
  }

  // ---- table API (/internal/agent/*)

  /**
   * GET /internal/agent/claim: the oldest queued Agent at this stake for `table`. `seating` (Agents here / room for) makes
   * queued Agents wait a little for a table that already has Agents (they play each other) before an empty one takes them.
   */
  claim(table: string, stake: number, seating?: { agents: number; cap: number }): AgentDeploymentConfig | null {
    const now = this.now();
    // Lost tables: a deployment no table has touched for 2 minutes fails with what it had; an unplayed claim is re-queued.
    for (const r of this.rows.values()) {
      if ((r.phase === 'playing' || r.phase === 'stop_requested' || r.phase === 'settling') && r.updatedUnix < now - 120) {
        r.phase = 'failed';
        r.stopRequested = false;
        r.stopReason = 'server_lost';
        r.result = { ...this.summaryOf(r), StopReason: 'server_lost', CompletedUnix: now };
        r.assignedTable = null;
        r.completedUnix = now;
        r.updatedUnix = now;
        this.settle(r);
      } else if (r.phase === 'seated' && r.handsPlayed === 0 && r.updatedUnix < now - 120) {
        r.phase = 'queued';
        r.assignedTable = null;
        r.updatedUnix = now;
      }
    }
    if (seating && seating.agents >= seating.cap) return null;
    let waitSeconds = 0;
    if (seating && seating.agents === 0) {
      const counts = new Map<string, number>();
      for (const r of this.rows.values())
        if ((r.phase === 'seated' || r.phase === 'playing' || r.phase === 'stop_requested') && (r.stake === stake || r.stake === 0)
          && r.assignedTable && r.assignedTable !== table && r.updatedUnix > now - 60)
          counts.set(r.assignedTable, (counts.get(r.assignedTable) ?? 0) + 1);
      if ([...counts.values()].some((n) => n < seating.cap)) waitSeconds = this.opts.joinWaitSeconds ?? 45;
    }
    const queued = [...this.rows.values()]
      .filter((r) => r.phase === 'queued' && (r.stake === stake || r.stake === 0) && r.createdUnix <= now - waitSeconds)
      .sort((a, b) => (a.stake === stake ? 0 : 1) - (b.stake === stake ? 0 : 1) || a.createdUnix - b.createdUnix);
    const r = queued[0];
    if (!r) return null;
    r.phase = 'seated';
    r.assignedTable = table;
    r.updatedUnix = now;
    return configOfRow(r);
  }

  /** POST /internal/agent/progress, fenced to the table that owns the claim. */
  updateProgress(body: Partial<AgentProgressBody> & { session: string }, table?: string | null): void {
    const r = this.rows.get(body.session);
    if (!r || r.phase === 'completed' || r.phase === 'failed') return;
    if (table && r.assignedTable && r.assignedTable !== table) return;
    if (body.HandsPlayed != null) r.handsPlayed = body.HandsPlayed;
    if (body.Stack != null) r.stack = body.Stack;
    if (body.NetPnl != null) r.netPnl = body.NetPnl;
    if (body.RuntimeSeconds != null) r.runtimeSeconds = body.RuntimeSeconds;
    if (body.Wins != null) r.wins = body.Wins;
    if (body.Losses != null) r.losses = body.Losses;
    if (body.Showdowns != null) r.showdowns = body.Showdowns;
    if (body.AssignedTable) r.assignedTable = body.AssignedTable;
    const phase = body.phase as AgentPhase | undefined;
    if (phase && ACTIVE_PHASES.has(phase) && !(r.stopRequested && phase === 'playing')) r.phase = phase;
    r.updatedUnix = this.now();
  }

  /** GET /internal/agent/control: has the owner asked to stop, and is this table's claim still good? */
  control(deploymentId: string, table?: string | null): { stopRequested: boolean; validClaim: boolean; phase: AgentPhase } {
    const r = this.rows.get(deploymentId);
    if (!r) throw new AgentFarmError(404, 'Unknown agent deployment');
    return { stopRequested: r.stopRequested, validClaim: !!table && ACTIVE_PHASES.has(r.phase) && (r.assignedTable ?? '') === table, phase: r.phase };
  }

  /** POST /internal/agent/release: the table couldn't seat it; back to the queue. */
  release(deploymentId: string, table: string): void {
    const r = this.rows.get(deploymentId);
    if (!r || r.phase !== 'seated' || r.assignedTable !== table) return;
    r.phase = 'queued';
    r.assignedTable = null;
    r.updatedUnix = this.now();
  }

  /** The highest hand number recorded for a deployment (0: none). A table that adopts it numbers on from here. */
  lastHandNumber(deploymentId: string): number {
    return (this.handRows.get(deploymentId) ?? []).reduce((m, h) => Math.max(m, h.hand.HandNumber), 0);
  }

  /** POST /internal/agent/hand: idempotent per (deployment, hand number). */
  upsertHand(hand: AgentHandRecord, replayJson: string | null, table?: string | null): void {
    const id = hand.DeploymentId ?? '';
    const r = this.rows.get(id);
    if (!r) return;
    if (table && r.assignedTable && r.assignedTable !== table) return;
    let list = this.handRows.get(id);
    if (!list) this.handRows.set(id, (list = []));
    const row: HandRow = { hand: { ...newAgentHandRecord(), ...hand, ReplayJson: '' }, replayJson: replayJson || null };
    const i = list.findIndex((h) => h.hand.HandNumber === hand.HandNumber);
    if (i >= 0) list[i] = row;
    else list.push(row);
    const keep = this.opts.maxHandsKept ?? 0;
    if (keep > 0 && list.length > keep) list.splice(0, list.length - keep);
    if (r.phase === 'seated') r.phase = 'playing';
    r.updatedUnix = this.now();
  }

  /** POST /internal/agent/complete: the authoritative result; the stack goes back to the owner. */
  complete(summary: AgentDeploymentSummary, table?: string | null): AgentDeploymentSummary | null {
    const r = this.rows.get(summary.DeploymentId ?? '');
    if (!r) return null;
    if (table && r.assignedTable && r.assignedTable !== table && r.phase !== 'completed' && r.phase !== 'failed') return null;
    if (r.phase !== 'completed' && r.phase !== 'failed') {
      r.phase = 'completed';
      r.handsPlayed = summary.HandsPlayed;
      r.stack = summary.EndingStack;
      r.netPnl = summary.NetPnl;
      r.runtimeSeconds = summary.RuntimeSeconds;
      r.stopReason = summary.StopReason ?? '';
      r.wins = summary.Wins;
      r.losses = summary.Losses;
      r.showdowns = summary.Showdowns;
      r.result ??= { ...summary };
      r.stopRequested = false;
      r.completedUnix ||= this.now();
      r.updatedUnix = this.now();
      this.settle(r);
      this.prune(r.ownerId);
    }
    return this.result(r.deploymentId, r.ownerId);
  }

  // ---- internals

  private settle(r: DeploymentRow): void {
    if (!r.funded || !this.opts.money) return;
    const stack = r.result?.EndingStack ?? r.stack;
    const fee = r.result?.CopyFee ? Math.max(0, r.result.CopyFee.creatorFee) + Math.max(0, r.result.CopyFee.platformFee) : 0;
    this.opts.money.settle(r.deploymentId, r.ownerId, stack > 0 ? Math.max(0, stack - fee) : 0);
  }

  private prune(ownerId: string): void {
    const keep = this.opts.maxSessionsKept ?? 0;
    if (keep <= 0) return;
    const done = this.ownerRows(ownerId).filter((r) => r.phase === 'completed' || r.phase === 'failed');
    for (const r of done.slice(keep)) {
      this.rows.delete(r.deploymentId);
      this.handRows.delete(r.deploymentId);
    }
  }

  private ownerRows(ownerId: string): DeploymentRow[] {
    return [...this.rows.values()].filter((r) => r.ownerId === ownerId).sort((a, b) => b.createdUnix - a.createdUnix || (b.deploymentId < a.deploymentId ? -1 : 1));
  }

  private running(ownerId: string, exceptDeploymentId = ''): DeploymentRow | null {
    return this.ownerRows(ownerId).find((r) => ACTIVE_PHASES.has(r.phase) && r.deploymentId !== exceptDeploymentId) ?? null;
  }

  private owned(deploymentId: string, ownerId: string): DeploymentRow | null {
    const r = this.rows.get(deploymentId);
    if (!r) return null;
    if (ownerId && r.ownerId !== ownerId) throw new AgentFarmError(403, 'Deployment does not belong to owner');
    return r;
  }

  private recentHands(deploymentId: string, limit: number): AgentHandRecord[] {
    const all = [...(this.handRows.get(deploymentId) ?? [])].sort((a, b) => b.hand.HandNumber - a.hand.HandNumber).slice(0, limit);
    return all.reverse().map((h) => ({ ...h.hand, ReplayJson: '', HasReplay: !!h.replayJson }));
  }

  private summaryOf(r: DeploymentRow): AgentDeploymentSummary {
    return newAgentSummary({
      DeploymentId: r.deploymentId, OwnerPlayFabId: r.ownerId, StrategyPreset: r.profile, StrategyVersion: r.strategyVersion,
      StopReason: r.stopReason, HandsPlayed: r.handsPlayed, StartingBankroll: r.bankroll, EndingStack: r.stack, NetPnl: r.netPnl,
      RuntimeSeconds: r.runtimeSeconds, SessionName: r.assignedTable ?? '', CompletedUnix: r.completedUnix, Wins: r.wins,
      Losses: r.losses, Showdowns: r.showdowns, ServerSettled: r.funded,
    });
  }

  private toProgress(r: DeploymentRow, recent: AgentHandRecord[] | null): AgentDeploymentProgress {
    return newAgentProgress({
      running: ACTIVE_PHASES.has(r.phase), stopRequested: r.stopRequested, HandsPlayed: r.handsPlayed, MaxHands: r.maxHands,
      StartingBankroll: r.bankroll, Stack: r.stack, NetPnl: r.netPnl, RuntimeSeconds: r.runtimeSeconds, phase: r.phase,
      AssignedTable: r.assignedTable ?? '', CurrentHand: r.handsPlayed + 1, Wins: r.wins, Losses: r.losses, Showdowns: r.showdowns,
      stake: r.stake, updatedUnix: r.updatedUnix, createdUnix: r.createdUnix, RecentHands: recent,
    });
  }
}

/** AgentFarmLink.TryClaim: the claim body as the config the table seats. */
export function configOfRow(r: DeploymentRow): AgentDeploymentConfig {
  const s = r.strategy;
  return newAgentDeploymentConfig({
    DeploymentId: r.deploymentId, OwnerPlayFabId: r.ownerId, AgentName: r.agentName, StrategyPreset: r.profile,
    StrategyVersion: r.strategyVersion, Bankroll: r.bankroll, MinBuyIn: r.stake, MaxHands: r.maxHands,
    MaxRuntimeSeconds: r.maxRuntimeSeconds, StopLoss: r.stopLoss, ProfitTarget: r.profitTarget, StrategyId: r.strategyId,
    Profile: s.hasCustom
      ? {
          FoldBelow: s.foldBelow, RaiseAbove: s.raiseAbove, Aggression: s.aggression, BluffChance: s.bluffChance,
          RaiseFractionOfPot: s.raiseFractionOfPot, HasCustom: true, PositionWeight: s.positionWeight, Brain: s.brain,
          Streets: s.streets && s.streets.length > 0 ? s.streets : null,
        }
      : { FoldBelow: 0, RaiseAbove: 0, Aggression: 0, BluffChance: 0, RaiseFractionOfPot: 0, HasCustom: false, PositionWeight: 0, Brain: 0, Streets: null },
  });
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit) || 20, 100));
}
