import {
  AgentSession as EngineAgentSession, AgentStopReasons, newAgentDeploymentConfig, newAgentHandRecord, resolveAgentProfile,
  type AgentDeploymentConfig as EngineAgentConfig,
} from '@nomad/engine/agents';
import type { EngineEvent } from '@nomad/engine/events/pokerEvent';
import { completeAgent, markSeated, markUnseated, recordAgentHand, strategyOf, touchAgents, type AgentRow } from '@nomad/db/agents';
import type { AgentHandRecord, AgentHooks, AgentSession } from '@nomad/table-server/agents';
import type { PokerServerGame } from '@nomad/table-server/pokerServerGame';
import type { LogFn } from './tableHost';

/** One seated Agent's own state: its limits, win/loss counts and the replay of the hand in progress. */
interface Desk {
  row: AgentRow;
  session: EngineAgentSession;
}

export interface AgentDeskOptions {
  db: D1Database;
  /** The room (Durable Object name) the Agents sit in: the fence on every D1 write. */
  room: string;
  log: LogFn;
  /** Seconds, for runtime limits (the table's clock: qa rooms run fast). */
  clock: () => number;
  /** D1 writes go through the table's ordered, retried queue. */
  queue: (label: string, fn: () => Promise<void>) => void;
  blinds: () => { small: number; big: number };
}

/** The engine's deployment config for a D1 row: what the Agent plays (its custom numbers or its preset) and its limits. */
export function engineConfigOf(row: AgentRow): EngineAgentConfig {
  const s = strategyOf(row);
  return newAgentDeploymentConfig({
    DeploymentId: row.id, OwnerPlayFabId: row.owner_id, AgentName: row.agent_name, StrategyPreset: row.profile,
    StrategyVersion: row.strategy_version, Bankroll: row.bankroll, MinBuyIn: row.stake, MaxHands: row.max_hands,
    MaxRuntimeSeconds: row.max_runtime, StopLoss: row.stop_loss, ProfitTarget: row.profit_target, StrategyId: row.strategy_id,
    Profile: {
      FoldBelow: s.foldBelow, RaiseAbove: s.raiseAbove, Aggression: s.aggression, BluffChance: s.bluffChance,
      RaiseFractionOfPot: s.raiseFractionOfPot, HasCustom: !!s.hasCustom, PositionWeight: s.positionWeight, Brain: s.brain,
      Streets: s.streets && s.streets.length ? s.streets : null,
    },
  });
}

/**
 * The Agents at one table: PokerServerGame already seats them (an empty chair or a filler bot's, never with their owner,
 * filler bots when alone) and calls these hooks; the desk adds each Agent's limits, replays and its D1 book-keeping.
 * Replaces the backend farm's claim / progress / control / complete loop: the table IS the farm now.
 */
export class AgentDesk implements AgentHooks {
  private readonly desks = new Map<string, Desk>();
  private game: PokerServerGame | null = null;

  constructor(private readonly opts: AgentDeskOptions) {}

  bind(game: PokerServerGame): void {
    this.game = game;
  }

  get ids(): string[] {
    return [...this.desks.keys()];
  }

  holds(deploymentId: string): boolean {
    return this.desks.has(deploymentId) && !!this.game?.hostsAgent(deploymentId);
  }

  /** Takes a queued Agent: claims its row for this room, then parks it at the table for the next hand boundary. */
  async seat(row: AgentRow): Promise<boolean> {
    const game = this.game;
    if (!game || !game.canAcceptSharedAgent || this.desks.has(row.id)) return false;
    if (!(await markSeated(this.opts.db, row.id, this.opts.room))) return false; // stopped (or taken) meanwhile
    const config = engineConfigOf(row);
    const session = new EngineAgentSession(config, this.opts.clock);
    this.desks.set(row.id, { row, session });
    const ok = game.trySeatSharedAgent({
      deploymentId: row.id,
      ownerPlayFabId: row.owner_id,
      agentName: row.agent_name,
      bankroll: row.bankroll,
      strategyPreset: row.profile,
      profile: resolveAgentProfile(config),
    });
    if (!ok) {
      this.desks.delete(row.id);
      await markUnseated(this.opts.db, row.id, this.opts.room);
      return false;
    }
    this.opts.log('info', `[Agents] ${row.agent_name} (${row.id}) joins with ${row.bankroll}.`);
    return true;
  }

  /** The owner pressed Stop: a seated Agent leaves at the hand boundary; one still waiting for a seat leaves now. */
  stop(deploymentId: string): boolean {
    const game = this.game;
    const desk = this.desks.get(deploymentId);
    if (!game || !desk) return false;
    if (game.cancelPendingSharedAgent(deploymentId)) {
      this.desks.delete(deploymentId);
      const row = desk.row;
      this.opts.queue(`agent ${deploymentId} stop`, async () => {
        await completeAgent(this.opts.db, deploymentId, { stopReason: AgentStopReasons.OwnerStop, endingStack: row.bankroll, room: this.opts.room, handsPlayed: 0 });
      });
      return true;
    }
    desk.session.requestOwnerStop();
    game.requestAgentStop(deploymentId);
    return true;
  }

  /** Between hands nothing is checkpointed, so a quiet table says it still holds its Agents. */
  touch(): void {
    const ids = this.ids;
    if (ids.length) this.opts.queue('agents touch', () => touchAgents(this.opts.db, this.opts.room, ids));
  }

  // ---- AgentHooks (PokerServerGame calls these) ---------------------------------------------------------------------

  observe(agent: AgentSession, e: EngineEvent): void {
    const desk = this.desks.get(agent.deploymentId);
    if (!desk) return;
    const replay = desk.session.replay;
    if (e.type === 'HandStarted') {
      replay.clear();
      replay.begin(agent.seat);
      const b = this.opts.blinds();
      replay.setBlinds(b.small, b.big);
    }
    replay.observe(e);
  }

  handComplete(agent: AgentSession, r: AgentHandRecord): void {
    const desk = this.desks.get(agent.deploymentId);
    if (!desk) return;
    const record = newAgentHandRecord({
      DeploymentId: r.deploymentId, AssignedTable: r.assignedTable, HandNumber: r.handNumber, StartingStack: r.startingStack,
      EndingStack: r.endingStack, NetPnl: r.netPnl, HoleCards: r.holeCards, BoardCards: r.boardCards, Pot: r.pot, Result: r.result,
      Showdown: r.showdown, PublicActionsJson: r.publicActionsJson, CompletedUnix: r.completedUnix,
    });
    let replayJson: string | null = null;
    try {
      replayJson = desk.session.replay.finishJson();
    } catch (e) {
      this.opts.log('warn', `[Agents] replay failed: ${(e as Error).message}`);
    } finally {
      desk.session.replay.clear();
    }
    desk.session.recordHand(record);
    const s = desk.session;
    const checkpoint = {
      record, replayJson, handsPlayed: agent.handsPlayed, stack: r.endingStack, runtimeSeconds: Math.floor(s.runtimeSeconds),
      wins: s.wins, losses: s.losses, showdowns: s.showdowns,
    };
    this.opts.queue(`agent ${agent.deploymentId} hand ${r.handNumber}`, () => recordAgentHand(this.opts.db, agent.deploymentId, this.opts.room, checkpoint));
  }

  evaluateAfterHand(agent: AgentSession, stack: number): string | null {
    const desk = this.desks.get(agent.deploymentId);
    if (!desk) return null;
    if (agent.ownerStopRequested) desk.session.requestOwnerStop();
    return desk.session.evaluateAfterHand(stack);
  }

  stopped(agent: AgentSession, reason: string, stack: number): void {
    const desk = this.desks.get(agent.deploymentId);
    if (!desk) return;
    this.desks.delete(agent.deploymentId);
    const s = desk.session;
    const id = agent.deploymentId;
    this.opts.log('info', `[Agents] ${desk.row.agent_name} (${id}) leaves: ${reason}, stack ${stack}.`);
    this.opts.queue(`agent ${id} complete`, async () => {
      await completeAgent(this.opts.db, id, {
        stopReason: reason, endingStack: stack, room: this.opts.room, handsPlayed: agent.handsPlayed,
        runtimeSeconds: Math.floor(s.runtimeSeconds), wins: s.wins, losses: s.losses, showdowns: s.showdowns,
      });
    });
  }
}
