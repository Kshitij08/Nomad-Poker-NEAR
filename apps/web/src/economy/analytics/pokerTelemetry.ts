/**
 * Port of Core/Analytics/PokerTelemetry.cs (the phase-1 analytics taxonomy) with Analytics/PokerAnalytics.cs
 * replaced by a LOCAL sink: events go to an in-memory ring buffer and, with `?telemetry=1`, the console. Nothing is
 * sent anywhere (no Unity Analytics, no external service).
 */

export type TelemetryValue = string | number;
export type TelemetryParams = readonly (readonly [string, TelemetryValue | null | undefined])[];
export type SinkHandler = (eventName: string, parameters: TelemetryParams) => void;

export const TelemetryEvents = {
  AccountCreated: 'account_created',
  TutorialStarted: 'tutorial_started',
  TutorialCompleted: 'tutorial_completed',
  FirstTable: 'first_table',
  FirstHand: 'first_hand',
  FirstSessionCompleted: 'first_session_completed',
  SecondSession: 'second_session',
  FriendAdded: 'friend_added',
  FriendInvited: 'friend_invited',
  SessionStarted: 'session_started',
  SessionEnded: 'session_ended',
  TableJoined: 'table_joined',
  TableSessionEnded: 'table_session_ended',
  HandPlayed: 'hand_played',
  StakeSelected: 'stake_selected',
  CoinSource: 'coin_source',
  CoinSink: 'coin_sink',
  DailySpinClaimed: 'daily_spin_claimed',
  LoginRewardClaimed: 'login_reward_claimed',
  MissionCompleted: 'mission_completed',
  LevelUp: 'level_up',
  Web3Toggled: 'web3_toggled',
} as const;

/** Unity Analytics custom params prefer 32-bit numbers; oversized values go as strings. */
export function num(value: number): TelemetryValue {
  return value >= -2147483648 && value <= 2147483647 ? Math.trunc(value) : String(Math.trunc(value));
}

export interface TelemetryRecord {
  readonly name: string;
  readonly params: Readonly<Record<string, TelemetryValue>>;
  readonly at: number;
}

const E = TelemetryEvents;

export const PokerTelemetry = {
  /** Assigned once collection is allowed (installLocalTelemetrySink). Never required. */
  sink: null as SinkHandler | null,
  flushSink: null as (() => void) | null,

  record(eventName: string, ...parameters: (readonly [string, TelemetryValue | null | undefined])[]): void {
    if (!eventName) return;
    PokerTelemetry.sink?.(eventName, parameters);
  },
  flush(): void {
    PokerTelemetry.flushSink?.();
  },

  // ---- Funnel
  accountCreated: (method: string | null) => PokerTelemetry.record(E.AccountCreated, ['method', method ?? 'unknown']),
  tutorialStarted: (id: string | null) => PokerTelemetry.record(E.TutorialStarted, ['tutorial_id', id ?? 'poker_hand']),
  tutorialCompleted: (id: string | null, seconds: number) =>
    PokerTelemetry.record(E.TutorialCompleted, ['tutorial_id', id ?? 'poker_hand'], ['seconds', seconds]),
  firstTable: (minBuyIn: number, sessionName: string | null) =>
    PokerTelemetry.record(E.FirstTable, ['min_buy_in', minBuyIn], ['session', sessionName ?? '']),
  firstHand: (minBuyIn: number) => PokerTelemetry.record(E.FirstHand, ['min_buy_in', minBuyIn]),
  firstSessionCompleted: (hands: number, seconds: number, netChips: number) =>
    PokerTelemetry.record(E.FirstSessionCompleted, ['hands', hands], ['seconds', seconds], ['net_chips', netChips]),
  secondSession: (sessionCount: number) => PokerTelemetry.record(E.SecondSession, ['session_count', sessionCount]),
  friendAdded: (source: string | null) => PokerTelemetry.record(E.FriendAdded, ['source', source ?? 'search']),
  friendInvited: (channel: string | null) => PokerTelemetry.record(E.FriendInvited, ['channel', channel ?? 'party_code']),

  // ---- Session / table
  sessionStarted: (scene: string | null, web3: boolean) =>
    PokerTelemetry.record(E.SessionStarted, ['scene', scene ?? ''], ['web3', web3 ? 1 : 0]),
  sessionEnded: (seconds: number, hands: number) => PokerTelemetry.record(E.SessionEnded, ['seconds', seconds], ['hands', hands]),
  tableJoined: (sessionName: string | null, minBuyIn: number, buyIn: number, moneyTable: boolean) =>
    PokerTelemetry.record(E.TableJoined, ['session', sessionName ?? ''], ['min_buy_in', minBuyIn], ['buy_in', num(buyIn)],
      ['money_table', moneyTable ? 1 : 0]),
  tableSessionEnded: (hands: number, seconds: number, netChips: number, minBuyIn: number) =>
    PokerTelemetry.record(E.TableSessionEnded, ['hands', hands], ['seconds', seconds], ['net_chips', netChips], ['min_buy_in', minBuyIn]),
  handPlayed: (minBuyIn: number, netChips: number, won: boolean) =>
    PokerTelemetry.record(E.HandPlayed, ['min_buy_in', minBuyIn], ['net_chips', netChips], ['won', won ? 1 : 0]),
  stakeSelected: (minBuyIn: number, buyInChips: number, autoMatch: boolean) =>
    PokerTelemetry.record(E.StakeSelected, ['min_buy_in', minBuyIn], ['buy_in', num(buyInChips)], ['auto_match', autoMatch ? 1 : 0]),

  // ---- Economy / retention
  coinSource: (source: string | null, amount: number, balanceAfter: number) =>
    PokerTelemetry.record(E.CoinSource, ['source', source ?? 'unknown'], ['amount', num(amount)], ['balance', num(balanceAfter)]),
  coinSink: (sink: string | null, amount: number, balanceAfter: number) =>
    PokerTelemetry.record(E.CoinSink, ['sink', sink ?? 'unknown'], ['amount', num(amount)], ['balance', num(balanceAfter)]),
  dailySpinClaimed: (coins: number, label: string | null) =>
    PokerTelemetry.record(E.DailySpinClaimed, ['coins', num(coins)], ['label', label ?? '']),
  loginRewardClaimed: (day: number, reward: string | null) =>
    PokerTelemetry.record(E.LoginRewardClaimed, ['day', day], ['reward', reward ?? '']),
  missionCompleted: (id: string | null, kind: string | null) =>
    PokerTelemetry.record(E.MissionCompleted, ['mission_id', id ?? ''], ['kind', kind ?? '']),
  levelUp: (level: number, totalXp: number) => PokerTelemetry.record(E.LevelUp, ['level', level], ['xp', num(totalXp)]),
  web3Toggled: (enabled: boolean) => PokerTelemetry.record(E.Web3Toggled, ['enabled', enabled ? 1 : 0]),
};

/** The local stand-in for PokerAnalytics: keeps the last `capacity` events; logs them with ?telemetry=1. */
export class LocalTelemetrySink {
  readonly events: TelemetryRecord[] = [];
  constructor(private readonly log: boolean, private readonly capacity = 500) {}

  readonly record: SinkHandler = (name, parameters) => {
    const params: Record<string, TelemetryValue> = {};
    for (const [k, v] of parameters) if (v !== null && v !== undefined) params[k] = v; // PokerAnalytics skips nulls
    const rec: TelemetryRecord = Object.freeze({ name, params: Object.freeze(params), at: Date.now() });
    this.events.push(rec);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    if (this.log) console.info('[Analytics]', name, params);
  };

  readonly flush = (): void => {
    if (this.log) console.info(`[Analytics] flush (${this.events.length} buffered, kept locally)`);
  };
}

export function installLocalTelemetrySink(log: boolean): LocalTelemetrySink {
  const sink = new LocalTelemetrySink(log);
  PokerTelemetry.sink = sink.record;
  PokerTelemetry.flushSink = sink.flush;
  return sink;
}

/** Services/UnityServicesGate.cs: there is no Unity Gaming Services in the browser port — always "not available". */
export const UnityServicesGate = {
  isReady: false,
  initializeAsync: (): Promise<boolean> => Promise.resolve(false),
};
