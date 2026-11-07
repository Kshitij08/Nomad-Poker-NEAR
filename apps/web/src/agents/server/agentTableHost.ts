/**
 * The Agent half of a Quick Play table server: the parts of PokerServerGame.cs that seat AFK Agents, record each one's
 * hands (record + privacy-filtered replay), enforce its limits after every hand and report it, plus AgentFarmLink's
 * progress body. No browser APIs: runs in the web table server (Node) and in the browser's local backend alike.
 *
 * How a table server uses it (the hook; see web/src/agents/server/README.md):
 *   const agents = new AgentTableHost({ engine, seatCount, tableName: () => name, reporter });
 *   - claim:            agents.trySeatSharedAgent(config, ownerSeatedHere)          // parks it until a hand boundary
 *   - between hands:    for (const a of agents.activatePending(allocateSeat, ownerSeatedHere)) router.set(a.seat, new BotActionProvider(a.bot, ...))
 *   - before the deal:  agents.beginHand(); for (const s of agents.haltForOwners()) vacate(s.seat)
 *   - every event:      agents.observe(e)   (before broadcasting it)
 *   - after HandEnded:  agents.completeHand(); for (const s of agents.evaluateAfterHand()) vacate(s.seat)
 *   - shutting down:    agents.haltAll()
 */
import {
  AgentSessionHost, AgentStopReasons, defaultClock, defaultUnixClock, newAgentHandRecord,
  type AgentDeploymentConfig, type AgentDeploymentSummary, type AgentHandRecord, type AgentSession, type Clock, type UnixClock,
} from '../../core/agents';
import { HeuristicBot } from '../../core/bots/heuristicBot';
import type { IPokerBot } from '../../core/bots/botContext';
import type { PokerEngine } from '../../core/engine/pokerEngine';
import { ActionType } from '../../core/actions/actions';
import type { PokerEvent } from '../../core/events/pokerEvent';

/** Where finished hands and deployments go (AgentCompleteReporter: the backend's /internal/agent/hand and /complete). */
export interface AgentReporter {
  /** One settled hand, with its replay JSON ('' when there is none). */
  reportHand(hand: AgentHandRecord, replayJson: string): void;
  /** A deployment ended (after its "settling" progress). */
  reportComplete(summary: AgentDeploymentSummary, tableName: string): void;
}

/** AgentFarmLink.ProgressBody: what the table posts every few seconds for each Agent (/internal/agent/progress). */
export interface AgentProgressBody {
  session: string;
  running: boolean;
  HandsPlayed: number;
  MaxHands: number;
  StartingBankroll: number;
  Stack: number;
  NetPnl: number;
  RuntimeSeconds: number;
  phase: string;
  AssignedTable: string;
  CurrentHand: number;
  Wins: number;
  Losses: number;
  Showdowns: number;
  updatedUnix: number;
  RecentHands: AgentHandRecord[];
}

/** An Agent that left the table this call: the server vacates `seat` (now, or after the hand if seats are locked). */
export interface StoppedAgent {
  session: AgentSession;
  summary: AgentDeploymentSummary;
  seat: number;
  /** The engine's player id at that seat (`agent-<deploymentId>`): vacate only if it still matches. */
  playerId: string;
}

export interface SeatedAgent {
  session: AgentSession;
  seat: number;
  /** The Agent's brain: wrap it in a BotActionProvider for this seat. */
  bot: IPokerBot;
}

export interface AgentTableHostOptions {
  engine: PokerEngine;
  seatCount: number;
  tableName: () => string;
  reporter?: AgentReporter | null;
  clock?: Clock;
  unixClock?: UnixClock;
  /** settings.useFixedSeed ? seed + seat * 101 : null (PokerServerGame.SeatAgent). */
  botSeed?: (seat: number) => number | null;
  /** The table's starting stack, for a config without a bankroll. */
  startingStack?: number;
}

export const agentPlayerId = (deploymentId: string): string => `agent-${deploymentId}`;

const sameOwner = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export class AgentTableHost {
  readonly agents: AgentSessionHost;
  /** Claimed Agents waiting for a hand boundary to sit (review 20 Oct: several Agents per table). */
  private readonly pending: AgentDeploymentConfig[] = [];
  private handActions: string[] = [];
  private boardCards = '';
  private readonly unixClock: UnixClock;

  constructor(private readonly opts: AgentTableHostOptions) {
    this.unixClock = opts.unixClock ?? defaultUnixClock;
    this.agents = new AgentSessionHost(opts.clock ?? defaultClock, this.unixClock);
  }

  private get engine(): PokerEngine {
    return this.opts.engine;
  }

  /** How many Agents are here or claimed for here. PokerServerGame.AgentsSeated. */
  get agentsSeated(): number {
    return this.agents.sessions.length + this.pending.length;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Room for one more Agent: up to every seat but one, and a chair (empty, or a filler bot's) for each claim. */
  canAcceptSharedAgent(seatsForAgents: number): boolean {
    return this.agentsSeated < AgentSessionHost.maxAgentsPerTable(this.opts.seatCount) && seatsForAgents > this.pending.length;
  }

  /** Claims an Agent for this table. Never with its owner (review H2), one Agent per owner. Parks it until activatePending. */
  trySeatSharedAgent(config: AgentDeploymentConfig, ownerSeatedHere: (owner: string | null) => boolean = () => false): boolean {
    if (!config) return false;
    if (this.agents.byDeployment(config.DeploymentId) || this.pendingOf(config.DeploymentId)) return false;
    if (ownerSeatedHere(config.OwnerPlayFabId) || this.agents.hasAgentOf(config.OwnerPlayFabId)) return false;
    if (this.pending.some((p) => sameOwner(p.OwnerPlayFabId, config.OwnerPlayFabId))) return false;
    this.pending.push(config);
    return true;
  }

  cancelPending(deploymentId: string): boolean {
    const p = this.pendingOf(deploymentId);
    if (!p) return false;
    this.pending.splice(this.pending.indexOf(p), 1);
    return true;
  }

  isPending(deploymentId: string): boolean {
    return this.pendingOf(deploymentId) != null;
  }

  pendingConflictsWithOwner(deploymentId: string, ownerSeatedHere: (owner: string | null) => boolean): boolean {
    const p = this.pendingOf(deploymentId);
    return p != null && ownerSeatedHere(p.OwnerPlayFabId);
  }

  private pendingOf(deploymentId: string | null): AgentDeploymentConfig | null {
    return this.pending.find((p) => p.DeploymentId === deploymentId) ?? null;
  }

  /**
   * Seats the parked Agents (call when seats are not locked: between hands). `allocateSeat` returns an empty chair, or a
   * filler bot's chair after the server has dropped that bot (TryActivatePendingAgent bumps it), or -1 when full.
   */
  activatePending(allocateSeat: () => number, ownerSeatedHere: (owner: string | null) => boolean = () => false, stackOf?: (config: AgentDeploymentConfig) => number): SeatedAgent[] {
    const seated: SeatedAgent[] = [];
    for (const config of [...this.pending]) {
      if (ownerSeatedHere(config.OwnerPlayFabId)) continue; // the farm releases it back to the queue
      const seat = allocateSeat();
      if (seat < 0) break;
      this.pending.splice(this.pending.indexOf(config), 1);
      const session = this.agents.bind(config);
      seated.push({ session, seat, bot: this.seatAgent(seat, session, stackOf?.(config)) });
    }
    return seated;
  }

  /** PokerServerGame.SeatAgent: the engine seat (isAgent) and the Agent's HeuristicBot with its own profile. */
  seatAgent(seat: number, session: AgentSession, stack?: number): IPokerBot {
    const config = session.config;
    const bot = new HeuristicBot(session.resolveProfile(), this.opts.botSeed?.(seat) ?? null);
    const name = config.AgentName || 'Agent';
    const chips = stack ?? (config.Bankroll > 0 ? config.Bankroll : this.opts.startingStack ?? 5000);
    this.engine.seatPlayer(seat, agentPlayerId(session.deploymentId), name, true, chips, true);
    session.seat = seat;
    return bot;
  }

  isAgentSeat(seat: number): boolean {
    return this.agents.bySeat(seat) != null;
  }

  /** The owner asked to stop (control poll said stopRequested, or the claim is no longer valid). */
  requestStop(deploymentId: string): boolean {
    const s = this.agents.byDeployment(deploymentId);
    s?.requestOwnerStop();
    return s != null;
  }

  private currentStack(session: AgentSession): number {
    const seat = session.seat;
    const seats = this.engine.table.seats;
    if (seat >= 0 && seat < seats.length && seats[seat]!.isOccupied) return seats[seat]!.stack;
    return session.lastStack;
  }

  /** BeginAgentHandTelemetry: every seated Agent starts this hand's notes and replay. */
  beginHand(): void {
    this.handActions = [];
    this.boardCards = '';
    for (const agent of this.agents.sessions) {
      agent.inHand = true;
      agent.handStartingStack = this.currentStack(agent);
      agent.handPotWon = 0;
      agent.holeCards = '';
      agent.wentToShowdown = false;
      agent.replay.clear();
      agent.replay.begin(agent.seat);
    }
  }

  /** Every engine event, in order (ProcessEventsUntilHandEnds' Agent lines). Recording never breaks the hand. */
  observe(e: PokerEvent): void {
    for (const agent of this.agents.sessions) {
      try {
        agent.replay.observe(e);
      } catch (ex) {
        console.warn('[AgentSession] Hand replay recording failed: ' + String(ex));
        agent.replay.clear();
      }
    }
    const any = this.agents.hasActiveDeployment;
    switch (e.type) {
      case 'HandStarted':
        for (const agent of this.agents.sessions) agent.replay.setBlinds(this.engine.table.smallBlind, this.engine.table.bigBlind);
        break;
      case 'HoleCardsDealt': {
        const a = this.agents.bySeat(e.seat);
        if (a) a.holeCards = `${e.card0.short} ${e.card1.short}`;
        break;
      }
      case 'BlindPosted':
        if (any) this.handActions.push(`{"seat":${e.seat},"action":"${e.isSmallBlind ? 'small_blind' : 'big_blind'}","amount":${e.amount}}`);
        break;
      case 'CommunityDealt':
        if (any && e.board) this.boardCards = e.board.map((c) => c.short).join(' ');
        break;
      case 'PlayerActed':
        if (any) this.handActions.push(`{"seat":${e.seat},"action":"${ActionType[e.action]}","amount":${e.amount}}`);
        break;
      case 'Showdown':
        for (const entry of e.entries ?? []) {
          const a = this.agents.bySeat(entry.seat);
          if (a) a.wentToShowdown = true;
        }
        break;
      case 'PotAwarded': {
        const a = this.agents.bySeat(e.seat);
        if (a) a.handPotWon += e.amount;
        break;
      }
      default:
        break;
    }
  }

  /** CompleteAgentHandTelemetry: one record (and replay) per Agent dealt into the hand, recorded and reported. */
  completeHand(): AgentHandRecord[] {
    const out: AgentHandRecord[] = [];
    for (const agent of this.agents.sessions) {
      if (!agent.active || !agent.inHand) continue;
      const ending = this.currentStack(agent);
      const net = ending - agent.handStartingStack;
      const hand = newAgentHandRecord({
        DeploymentId: agent.deploymentId,
        AssignedTable: this.opts.tableName(),
        HandNumber: this.engine.table?.handNumber ?? agent.handsPlayed + 1,
        StartingStack: agent.handStartingStack,
        EndingStack: ending,
        NetPnl: net,
        HoleCards: agent.holeCards,
        BoardCards: this.boardCards,
        Pot: agent.handPotWon,
        Result: net > 0 ? 'win' : net < 0 ? 'loss' : 'push',
        Showdown: agent.wentToShowdown,
        PublicActionsJson: '[' + this.handActions.join(',') + ']',
        CompletedUnix: this.unixClock(),
      });
      // The replay goes only to the reporter: the in-memory list (and the progress built from it) stays small.
      const replayJson = this.replayJson(agent);
      hand.HasReplay = replayJson.length > 0;
      agent.recordHand(hand);
      this.opts.reporter?.reportHand(hand, replayJson);
      out.push(hand);
    }
    return out;
  }

  private replayJson(agent: AgentSession): string {
    try {
      const json = agent.replay.finishJson();
      if (json == null && agent.replay.hasHand) console.warn('[AgentSession] Hand replay over the size cap; reporting the hand without it.');
      return json ?? '';
    } catch (e) {
      console.warn('[AgentSession] Hand replay failed: ' + String(e));
      return '';
    } finally {
      agent.replay.clear();
    }
  }

  /** EvaluateAgentLimitsAfterHand: Agents whose limits ended them leave (reported); the server vacates their seats. */
  evaluateAfterHand(): StoppedAgent[] {
    const stopped: StoppedAgent[] = [];
    for (const agent of [...this.agents.sessions]) {
      if (!agent.inHand) continue; // sat down after this hand; its first hand is the next one
      agent.inHand = false;
      const stack = this.currentStack(agent);
      const reason = agent.evaluateAfterHand(stack);
      if (reason == null) continue;
      agent.stop(reason, stack, this.opts.tableName());
      stopped.push(this.onStopped(agent));
    }
    return stopped;
  }

  /** TryHaltAgentsForOwners: owner stops between hands, or before the first deal. Mid-hand stops wait for the showdown. */
  haltForOwners(): StoppedAgent[] {
    const stopped: StoppedAgent[] = [];
    for (const agent of [...this.agents.sessions]) {
      if (!agent.ownerStopRequested) continue;
      agent.stop(AgentStopReasons.OwnerStop, this.currentStack(agent), this.opts.tableName());
      stopped.push(this.onStopped(agent));
    }
    return stopped;
  }

  /** The table is going away (OnDestroy / halt): report every Agent instead of orphaning it. */
  haltAll(reason: string = AgentStopReasons.Halted): StoppedAgent[] {
    const stopped: StoppedAgent[] = [];
    for (const agent of [...this.agents.sessions]) {
      agent.stop(reason, this.currentStack(agent), this.opts.tableName());
      stopped.push(this.onStopped(agent));
    }
    return stopped;
  }

  private onStopped(agent: AgentSession): StoppedAgent {
    const summary = agent.lastSummary!;
    this.opts.reporter?.reportComplete(summary, this.opts.tableName());
    this.agents.remove(agent);
    return { session: agent, summary, seat: agent.seat, playerId: agentPlayerId(agent.deploymentId) };
  }

  /** AgentFarmLink.SyncOnce's body for one Agent. */
  progressBody(agent: AgentSession): AgentProgressBody {
    const stack = agent.lastStack;
    const hands = agent.handRecords;
    return {
      session: agent.deploymentId,
      running: true,
      HandsPlayed: agent.handsPlayed,
      MaxHands: agent.config.MaxHands,
      StartingBankroll: agent.startingBankroll,
      Stack: stack,
      NetPnl: stack - agent.startingBankroll,
      RuntimeSeconds: Math.max(0, agent.runtimeSeconds),
      phase: agent.ownerStopRequested ? 'stop_requested' : 'playing',
      AssignedTable: this.opts.tableName(),
      CurrentHand: agent.handsPlayed + 1,
      Wins: agent.wins,
      Losses: agent.losses,
      Showdowns: agent.showdowns,
      updatedUnix: this.unixClock(),
      RecentHands: hands.slice(Math.max(0, hands.length - 10)),
    };
  }
}
