/**
 * Port of Assets/Scripts/Net/Agents/AgentSessionHost.cs: one AFK Agent deployment seated at a Quick Play table (its
 * limits, running totals and this hand's notes), and the Agents seated at one table.
 *
 * Differences from the C#: the clock is injected (Unity's Time.realtimeSinceStartup), and AgentSessionHost is an instance
 * per table instead of a process-wide static (a Unity dedicated server hosts one table; a web table server hosts many).
 */
import { BotProfile } from '../bots/botProfile';
import {
  AgentStopReasons, clampAgentConfig, newAgentSummary,
  type AgentDeploymentConfig, type AgentDeploymentSummary, type AgentHandRecord,
} from './agentDeploymentConfig';
import { AgentHandReplayRecorder } from './agentHandReplay';

const f = Math.fround;

/** Seconds since some fixed start (Time.realtimeSinceStartup). */
export type Clock = () => number;
/** Unix seconds (DateTimeOffset.UtcNow.ToUnixTimeSeconds). */
export type UnixClock = () => number;

export const defaultClock: Clock = () =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
export const defaultUnixClock: UnixClock = () => Math.floor(Date.now() / 1000);

/** The strategy an Agent plays: its custom numbers (with per-street overrides), else its preset. AgentSession.ResolveProfile. */
export function resolveAgentProfile(config: AgentDeploymentConfig): BotProfile {
  const c = config.Profile;
  if (c?.HasCustom) {
    let profile = BotProfile.numbers(c.FoldBelow, c.RaiseAbove, c.Aggression, c.BluffChance, c.RaiseFractionOfPot);
    profile.positionWeight = f(c.PositionWeight);
    profile.brain = Math.trunc(c.Brain);
    for (let i = 0; c.Streets && i < c.Streets.length && i < 4; i++) {
      const st = c.Streets[i];
      if (!st || !st.HasValue) continue;
      profile = profile.withStreet(i, BotProfile.numbers(st.FoldBelow, st.RaiseAbove, st.Aggression, st.BluffChance, st.RaiseFractionOfPot));
    }
    return profile.clamped();
  }
  return BotProfile.fromPreset(config.StrategyPreset);
}

export class AgentSession {
  readonly config: AgentDeploymentConfig;
  lastSummary: AgentDeploymentSummary | null = null;
  active = true;
  handsPlayed = 0;
  /** Clock reading when it sat down (settable so a restored deployment keeps its runtime). */
  startedRealtime: number;
  readonly startingBankroll: number;
  lastStack: number;
  ownerStopRequested = false;
  seat = -1;
  wins = 0;
  losses = 0;
  showdowns = 0;
  private readonly hands: AgentHandRecord[] = [];

  // This hand, for its record and replay (the table fills them from the engine's events). InHand: seated when it began.
  // An Agent that sits down after a hand ends but before the table has written it up must not get that hand.
  inHand = false;
  handStartingStack = 0;
  handPotWon = 0;
  holeCards = '';
  wentToShowdown = false;
  readonly replay = new AgentHandReplayRecorder();

  constructor(config: AgentDeploymentConfig, private readonly clock: Clock = defaultClock, private readonly unixClock: UnixClock = defaultUnixClock) {
    this.config = clampAgentConfig(config);
    this.startedRealtime = f(clock());
    this.startingBankroll = this.config.Bankroll;
    this.lastStack = this.config.Bankroll;
  }

  get deploymentId(): string {
    return this.config.DeploymentId ?? '';
  }

  get handRecords(): readonly AgentHandRecord[] {
    return this.hands;
  }

  /** Seconds since the deployment sat down (float, like Unity). */
  get runtimeSeconds(): number {
    return f(f(this.clock()) - this.startedRealtime);
  }

  noteStack(stack: number): void {
    this.lastStack = stack;
  }

  recordHand(hand: AgentHandRecord | null): void {
    if (!this.active || !hand) return;
    this.hands.push(hand);
    if (hand.NetPnl > 0) this.wins++;
    else if (hand.NetPnl < 0) this.losses++;
    if (hand.Showdown) this.showdowns++;
    this.noteStack(hand.EndingStack);
  }

  /** Owner asked to cash out. The Agent leaves after the current hand. */
  requestOwnerStop(): void {
    this.ownerStopRequested = true;
  }

  resolveProfile(): BotProfile {
    return resolveAgentProfile(this.config);
  }

  /** Call once per completed hand. Returns a stop reason when the deployment should end. */
  evaluateAfterHand(agentStack: number): string | null {
    if (!this.active) return null;
    this.noteStack(agentStack);
    this.handsPlayed++;

    if (this.ownerStopRequested) return AgentStopReasons.OwnerStop;

    // What happened to the money on the last hand wins over a limit it also reached: busting, or crossing the stop
    // loss or the profit target, on the final allowed hand is reported as that (not as "hand limit"). Unity checked the
    // limits first, which filed a bust on hand 100 of 100 as a normal finish.
    if (agentStack <= 0) return AgentStopReasons.Bust;
    const net = agentStack - this.startingBankroll;
    if (this.config.StopLoss > 0 && net <= -this.config.StopLoss) return AgentStopReasons.StopLoss;
    if (this.config.ProfitTarget > 0 && net >= this.config.ProfitTarget) return AgentStopReasons.ProfitTarget;

    if (this.handsPlayed >= this.config.MaxHands) return AgentStopReasons.MaxHands;
    if (this.runtimeSeconds >= this.config.MaxRuntimeSeconds) return AgentStopReasons.MaxRuntime;
    return null;
  }

  stop(reason: string | null, endingStack: number, sessionName: string | null): AgentDeploymentSummary {
    if (!this.active && this.lastSummary) return this.lastSummary;
    const ending = Math.max(0, endingStack);
    const summary = newAgentSummary({
      DeploymentId: this.config.DeploymentId,
      OwnerPlayFabId: this.config.OwnerPlayFabId,
      StrategyPreset: this.config.StrategyPreset,
      StrategyVersion: this.config.StrategyVersion,
      StopReason: reason ?? AgentStopReasons.Halted,
      HandsPlayed: this.handsPlayed,
      StartingBankroll: this.startingBankroll,
      EndingStack: ending,
      NetPnl: ending - this.startingBankroll,
      RuntimeSeconds: this.runtimeSeconds,
      SessionName: sessionName ?? '',
      CompletedUnix: this.unixClock(),
      Wins: this.wins,
      Losses: this.losses,
      Showdowns: this.showdowns,
    });
    this.lastSummary = summary;
    this.active = false;
    this.ownerStopRequested = false;
    return summary;
  }
}

/**
 * The AFK deployments seated at one public Quick Play table (review 20 Oct, option 2: Agents play each other, so a table
 * holds several; filler bots only fill the seats left). Port of the static AgentSessionHost, one instance per table.
 */
export class AgentSessionHost {
  /** Agents at one table: every seat but one, which stays for a person (or a filler bot). */
  static maxAgentsPerTable(seatCount: number): number {
    return Math.max(1, seatCount - 1);
  }

  private readonly list: AgentSession[] = [];

  constructor(private readonly clock: Clock = defaultClock, private readonly unixClock: UnixClock = defaultUnixClock) {}

  /** The Agents playing here now. */
  get sessions(): readonly AgentSession[] {
    return this.list;
  }

  get hasActiveDeployment(): boolean {
    return this.list.length > 0;
  }

  bind(config: AgentDeploymentConfig): AgentSession {
    const session = new AgentSession(config, this.clock, this.unixClock);
    this.list.push(session);
    return session;
  }

  remove(session: AgentSession): void {
    const i = this.list.indexOf(session);
    if (i >= 0) this.list.splice(i, 1);
  }

  bySeat(seat: number): AgentSession | null {
    return this.list.find((s) => s.seat === seat) ?? null;
  }

  byDeployment(deploymentId: string | null | undefined): AgentSession | null {
    return this.list.find((s) => s.deploymentId === deploymentId) ?? null;
  }

  anyOwnerStopRequested(): boolean {
    return this.list.some((s) => s.ownerStopRequested);
  }

  /** An Agent here belongs to this player (never seat an owner with their own Agent: review H2). */
  hasAgentOf(ownerPlayFabId: string | null | undefined): boolean {
    if (!ownerPlayFabId) return false;
    const o = ownerPlayFabId.toLowerCase();
    return this.list.some((s) => (s.config.OwnerPlayFabId ?? '').toLowerCase() === o);
  }
}
