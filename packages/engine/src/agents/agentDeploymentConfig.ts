/**
 * Port of Assets/Scripts/Core/Agents/AgentDeploymentConfig.cs: the AFK Agent's limits and strategy, the summary written
 * when a deployment ends, the live progress snapshot, one settled hand, and the history wrappers.
 *
 * Field names are the C# ones (PascalCase, and the backend's mixed case on the progress snapshot): these objects are the
 * wire format JsonUtility writes and the backend's /api/agent/* routes return, so they round-trip unchanged.
 */

export interface StreetProfileSnapshot {
  HasValue: boolean;
  FoldBelow: number;
  RaiseAbove: number;
  Aggression: number;
  BluffChance: number;
  RaiseFractionOfPot: number;
}

/** Serializable BotProfile fields (Poker.Core cannot reference Poker.Bots). A C# struct: the default is all zeros. */
export interface BotProfileSnapshot {
  FoldBelow: number;
  RaiseAbove: number;
  Aggression: number;
  BluffChance: number;
  RaiseFractionOfPot: number;
  HasCustom: boolean;
  /** Agents v2: 0..1, how much position loosens / tightens play. */
  PositionWeight: number;
  /** 2 = equity and pot odds (HeuristicBot.DecideV2). */
  Brain: number;
  /** [preflop, flop, turn, river]; entries with HasValue play their own numbers. */
  Streets: StreetProfileSnapshot[] | null;
}

export function emptyProfileSnapshot(): BotProfileSnapshot {
  return { FoldBelow: 0, RaiseAbove: 0, Aggression: 0, BluffChance: 0, RaiseFractionOfPot: 0, HasCustom: false, PositionWeight: 0, Brain: 0, Streets: null };
}

export function emptyStreetSnapshot(): StreetProfileSnapshot {
  return { HasValue: false, FoldBelow: 0, RaiseAbove: 0, Aggression: 0, BluffChance: 0, RaiseFractionOfPot: 0 };
}

/**
 * Owner-authorized AFK agent deployment limits and strategy. The host enforces these; the agent itself cannot raise
 * bankroll, stakes, or risk caps.
 */
export interface AgentDeploymentConfig {
  DeploymentId: string | null;
  OwnerPlayFabId: string | null;
  AgentName: string | null;
  StrategyPreset: string | null;
  StrategyVersion: string | null;
  Bankroll: number;
  MinBuyIn: number;
  MaxHands: number;
  MaxRuntimeSeconds: number;
  /** Absolute loss from Bankroll; 0 = disabled. */
  StopLoss: number;
  /** Absolute profit from Bankroll; 0 = disabled. */
  ProfitTarget: number;
  Profile: BotProfileSnapshot;
  /** A copied marketplace strategy (docs/AGENTS_V2.md): its creator gets 8% and Nomad 2% of profits. */
  StrategyId: string | null;
}

/** `new AgentDeploymentConfig()` with the C# field initialisers. */
export function newAgentDeploymentConfig(init: Partial<AgentDeploymentConfig> = {}): AgentDeploymentConfig {
  return {
    DeploymentId: null,
    OwnerPlayFabId: null,
    AgentName: 'Agent',
    StrategyPreset: 'balanced',
    StrategyVersion: 'v1',
    Bankroll: 0,
    MinBuyIn: 1000,
    MaxHands: 100,
    MaxRuntimeSeconds: 3600,
    StopLoss: 0,
    ProfitTarget: 0,
    Profile: emptyProfileSnapshot(),
    StrategyId: null,
    ...init,
  };
}

const isNullOrWhiteSpace = (s: string | null | undefined): boolean => s == null || s.trim().length === 0;

/** Guid.NewGuid().ToString("N").Substring(0, 12). */
export function newDeploymentId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 12);
  let s = '';
  for (let i = 0; i < 12; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** AgentDeploymentConfig.Clamp: safe defaults and caps. Mutates and returns `raw` (like the C#); null → a new config. */
export function clampAgentConfig(raw: AgentDeploymentConfig | null | undefined): AgentDeploymentConfig {
  const c = raw ?? newAgentDeploymentConfig();
  if (isNullOrWhiteSpace(c.DeploymentId)) c.DeploymentId = newDeploymentId();
  if (isNullOrWhiteSpace(c.StrategyPreset)) c.StrategyPreset = 'balanced';
  if (isNullOrWhiteSpace(c.StrategyVersion)) c.StrategyVersion = 'v1';
  if (isNullOrWhiteSpace(c.AgentName)) c.AgentName = 'Agent';
  c.MinBuyIn = Math.max(50, Math.trunc(c.MinBuyIn));
  c.Bankroll = Math.max(c.MinBuyIn, Math.trunc(c.Bankroll));
  c.MaxHands = Math.max(1, Math.min(c.MaxHands <= 0 ? 100 : Math.trunc(c.MaxHands), 5000));
  c.MaxRuntimeSeconds = Math.max(60, Math.min(c.MaxRuntimeSeconds <= 0 ? 3600 : Math.trunc(c.MaxRuntimeSeconds), 86_400));
  c.StopLoss = Math.max(0, Math.trunc(c.StopLoss));
  c.ProfitTarget = Math.max(0, Math.trunc(c.ProfitTarget));
  c.Profile ??= emptyProfileSnapshot();
  return c;
}

/** What a copied strategy's creator (8%) and Nomad (2%) took from this session's profit. */
export interface CopyFeeInfo {
  strategyId: string | null;
  sessionPnl: number;
  feeBase: number;
  creatorFee: number;
  platformFee: number;
}

/** Written when a deployment ends so the owner return screen can load it. */
export interface AgentDeploymentSummary {
  DeploymentId: string | null;
  OwnerPlayFabId: string | null;
  StrategyPreset: string | null;
  StrategyVersion: string | null;
  StopReason: string | null;
  HandsPlayed: number;
  StartingBankroll: number;
  EndingStack: number;
  NetPnl: number;
  RuntimeSeconds: number;
  SessionName: string | null;
  CompletedUnix: number;
  Wins: number;
  Losses: number;
  Showdowns: number;
  /** A copied strategy's profit share for this session (from the backend's result; null otherwise). */
  CopyFee: CopyFeeInfo | null;
  /** The backend took the bankroll from the owner's Coins and pays the stack back itself. */
  ServerSettled: boolean;
}

export function newAgentSummary(init: Partial<AgentDeploymentSummary> = {}): AgentDeploymentSummary {
  return {
    DeploymentId: null, OwnerPlayFabId: null, StrategyPreset: null, StrategyVersion: null, StopReason: null,
    HandsPlayed: 0, StartingBankroll: 0, EndingStack: 0, NetPnl: 0, RuntimeSeconds: 0, SessionName: null,
    CompletedUnix: 0, Wins: 0, Losses: 0, Showdowns: 0, CopyFee: null, ServerSettled: false,
    ...init,
  };
}

/** One authoritative, settled hand in an AFK deployment. */
export interface AgentHandRecord {
  DeploymentId: string | null;
  AssignedTable: string | null;
  HandNumber: number;
  StartingStack: number;
  EndingStack: number;
  NetPnl: number;
  /** "As Kh" (space separated short cards). */
  HoleCards: string | null;
  BoardCards: string | null;
  Pot: number;
  /** "win" | "loss" | "push". */
  Result: string | null;
  Showdown: boolean;
  PublicActionsJson: string | null;
  CompletedUnix: number;
  /** The hand step by step (AgentHandReplay as JSON) for the Session History replay viewer. Empty for old hands. */
  ReplayJson: string | null;
  HasReplay: boolean;
}

export function newAgentHandRecord(init: Partial<AgentHandRecord> = {}): AgentHandRecord {
  return {
    DeploymentId: null, AssignedTable: null, HandNumber: 0, StartingStack: 0, EndingStack: 0, NetPnl: 0,
    HoleCards: null, BoardCards: null, Pot: 0, Result: null, Showdown: false, PublicActionsJson: null,
    CompletedUnix: 0, ReplayJson: null, HasReplay: false,
    ...init,
  };
}

/** Live snapshot while a deployment is still farming. Field names match the backend JSON. */
export interface AgentDeploymentProgress {
  running: boolean;
  stopRequested: boolean;
  HandsPlayed: number;
  MaxHands: number;
  StartingBankroll: number;
  Stack: number;
  NetPnl: number;
  RuntimeSeconds: number;
  phase: string | null;
  AssignedTable: string | null;
  CurrentHand: number;
  Wins: number;
  Losses: number;
  Showdowns: number;
  stake: number;
  updatedUnix: number;
  createdUnix: number;
  RecentHands: AgentHandRecord[] | null;
}

export function newAgentProgress(init: Partial<AgentDeploymentProgress> = {}): AgentDeploymentProgress {
  return {
    running: false, stopRequested: false, HandsPlayed: 0, MaxHands: 0, StartingBankroll: 0, Stack: 0, NetPnl: 0,
    RuntimeSeconds: 0, phase: null, AssignedTable: null, CurrentHand: 0, Wins: 0, Losses: 0, Showdowns: 0, stake: 0,
    updatedUnix: 0, createdUnix: 0, RecentHands: null,
    ...init,
  };
}

export interface AgentSessionHistory {
  Sessions: AgentDeploymentSummary[] | null;
  Total: number;
}

export interface AgentHandHistory {
  Hands: AgentHandRecord[] | null;
  Total: number;
}

export const AgentStopReasons = {
  MaxHands: 'max_hands',
  MaxRuntime: 'max_runtime',
  StopLoss: 'stop_loss',
  ProfitTarget: 'profit_target',
  OwnerStop: 'owner_stop',
  Bust: 'bust',
  Halted: 'halted',
} as const;

/**
 * AgentDeployService.BuildSessionCode: "AGNT" + up to 8 upper-case letters/digits of the deployment id, padded with '0'
 * to at least 8 characters. The session code is also the deployment id the backend keys on.
 */
export function buildSessionCode(deploymentId: string | null | undefined, newId: () => string = () => newDeploymentId() + newDeploymentId()): string {
  const raw = isNullOrWhiteSpace(deploymentId) ? newId() : deploymentId!.replace(/-/g, '');
  let sb = 'AGNT';
  for (let i = 0; i < raw.length && sb.length < 12; i++) {
    const c = raw[i]!.toUpperCase();
    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) sb += c;
  }
  while (sb.length < 8) sb += '0';
  return sb;
}
