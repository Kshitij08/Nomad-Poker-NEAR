import type { BotProfile } from '../../src/core/bots/botProfile';
import type { WireEvent } from '../../src/core/events/pokerEventCodec';
import type { EngineEvent } from '../../src/core/events/pokerEvent';

/**
 * The seam for owned AFK agents (Net/Agents in Unity, `web/src/agents/server/` here — the agents porter's). Unity keeps
 * agent sessions in a process-wide static (one Fusion process = one table); this server hosts many tables in one
 * process, so each PokerServerGame owns its agents and reports to an optional {@link AgentHooks} implementation.
 *
 * PokerServerGame already ports the seating rules: an agent takes an empty chair or bumps a filler bot, never sits at
 * its owner's table, keeps a Quick Play table alive with no humans, gets the filler pack when it is alone, and is
 * evaluated/stopped only at a hand boundary. What the hooks add is the agent's own policy and reporting.
 */
export interface AgentDeploymentConfig {
  deploymentId: string;
  ownerPlayFabId: string;
  agentName: string;
  /** Chips the agent sits with (0 → the table's starting stack). */
  bankroll: number;
  strategyPreset?: string;
  /** The bot personality the agent plays with (AgentSession.ResolveProfile). Omitted → a random HeuristicBot. */
  profile?: BotProfile;
}

/** One seated (or pending) agent at a table — the parts of AgentSession the table reads and writes. */
export interface AgentSession {
  readonly config: AgentDeploymentConfig;
  readonly deploymentId: string;
  seat: number;
  inHand: boolean;
  handStartingStack: number;
  handPotWon: number;
  holeCards: string;
  wentToShowdown: boolean;
  handsPlayed: number;
  lastStack: number;
  ownerStopRequested: boolean;
  active: boolean;
}

export interface AgentHandRecord {
  deploymentId: string;
  assignedTable: string;
  handNumber: number;
  startingStack: number;
  endingStack: number;
  netPnl: number;
  holeCards: string;
  boardCards: string;
  pot: number;
  result: 'win' | 'loss' | 'push';
  showdown: boolean;
  publicActionsJson: string;
  completedUnix: number;
}

export interface AgentHooks {
  /** Every engine event, in order, for replays/telemetry (AgentSession.Replay.Observe). Never throw. */
  observe?(agent: AgentSession, e: EngineEvent | WireEvent): void;
  /** A finished hand for this agent (AgentCompleteReporter.ReportHand). */
  handComplete?(agent: AgentSession, record: AgentHandRecord): void;
  /** AgentSession.EvaluateAfterHand: a stop reason (stop-loss, hand cap…) or null to keep playing. */
  evaluateAfterHand?(agent: AgentSession, stack: number): string | null;
  /** The agent left the table (AgentStopReasons.*), with its final stack. */
  stopped?(agent: AgentSession, reason: string, stack: number, table: string): void;
}

/** AgentSessionHost.MaxAgentsPerTable: every seat but one. */
export function maxAgentsPerTable(seatCount: number): number {
  return Math.max(1, seatCount - 1);
}

export const AgentStopReasons = {
  Halted: 'halted',
  OwnerStop: 'owner_stop',
} as const;

export function newAgentSession(config: AgentDeploymentConfig): AgentSession {
  return {
    config,
    deploymentId: config.deploymentId,
    seat: -1,
    inHand: false,
    handStartingStack: 0,
    handPotWon: 0,
    holeCards: '',
    wentToShowdown: false,
    handsPlayed: 0,
    lastStack: config.bankroll,
    ownerStopRequested: false,
    active: true,
  };
}
