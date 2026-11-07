/**
 * Ports of Economy/PlayFabPlayerProgress.cs (Daily Spin / login streak counters, gems, XP, streak tokens,
 * cosmetics and packed missions in PlayFab UserData — same keys) and PlayFabAgentProgress.cs (the last AFK agent
 * deployment summary).
 */
import { PlayerPrefs } from '../../app/services';
import { PokerClientIdentity } from '../identity';
import { Signal } from '../signal';
import { errorReport } from './client';
import { isClientLoggedIn, playFab } from './runtime';

export const ProgressKeys = {
  LastSpinDay: 'Poker.Engage.LastSpinDay',
  LastLoginDay: 'Poker.Engage.LastLoginDay',
  StreakDay: 'Poker.Engage.StreakDay',
  LastSpinCoins: 'Poker.Engage.LastSpinCoins',
  Gems: 'Poker.Wallet.Gems',
  Xp: 'Poker.Wallet.Xp',
  StreakTokens: 'Poker.Wallet.StreakTokens',
  Items: 'Poker.Wallet.Items',
  Missions: 'Poker.Progress.Missions',
  AgentLastSummary: 'Poker.Agent.LastSummary',
} as const;

/** Poker.Core DailyEngagementState (the fields PlayFabPlayerProgress mirrors). */
export interface DailyEngagementState {
  lastSpinDay: number;
  lastLoginDay: number;
  streakDay: number;
  lastSpinCoins: number;
}

const MaxStreakTokens = 3;
const ALL_KEYS = [
  ProgressKeys.LastSpinDay, ProgressKeys.LastLoginDay, ProgressKeys.StreakDay, ProgressKeys.LastSpinCoins,
  ProgressKeys.Gems, ProgressKeys.Xp, ProgressKeys.StreakTokens, ProgressKeys.Items, ProgressKeys.Missions,
];

type UserData = Record<string, { Value?: string } | undefined>;

const newEngage = (): DailyEngagementState => ({ lastSpinDay: 0, lastLoginDay: 0, streakDay: 0, lastSpinCoins: 0 });
const intOr = (s: string | undefined, fb: number) => (s !== undefined && /^[+-]?\d+$/.test(s.trim()) ? Number(s) : fb);

let engage = newEngage();
let gems = 0;
let xp = 0;
let streakTokens = 1;
const items: string[] = [];
let missionsPacked = '';
let pulled = false;
let pushInFlight: Promise<void> | null = null;
let pushDirty = false;

function readStr(data: UserData, key: string, fb: string): string {
  const rec = data[key];
  return rec ? rec.Value ?? fb : fb;
}
function readNum(data: UserData, key: string, fb: number): number {
  const rec = data[key];
  if (!rec || !rec.Value) return fb;
  return intOr(rec.Value, fb);
}

function applyData(data: UserData | undefined): void {
  if (!data) return;
  engage.lastSpinDay = readNum(data, ProgressKeys.LastSpinDay, 0);
  engage.lastLoginDay = readNum(data, ProgressKeys.LastLoginDay, 0);
  engage.streakDay = readNum(data, ProgressKeys.StreakDay, 0);
  engage.lastSpinCoins = readNum(data, ProgressKeys.LastSpinCoins, 0);
  gems = readNum(data, ProgressKeys.Gems, 0);
  xp = readNum(data, ProgressKeys.Xp, 0);
  streakTokens = readNum(data, ProgressKeys.StreakTokens, 1);
  missionsPacked = readStr(data, ProgressKeys.Missions, '');
  items.length = 0;
  const packed = readStr(data, ProgressKeys.Items, '');
  for (const part of packed.split(',')) if (part && !items.includes(part)) items.push(part);
}

async function pushAllAsync(): Promise<void> {
  if (!isClientLoggedIn()) return;
  pushDirty = true;
  if (pushInFlight) return;
  while (pushDirty) {
    pushDirty = false;
    pushInFlight = pushOnceAsync();
    try {
      await pushInFlight;
    } finally {
      pushInFlight = null;
    }
  }
}

async function pushOnceAsync(): Promise<void> {
  const payload: Record<string, string> = {
    [ProgressKeys.LastSpinDay]: String(engage.lastSpinDay),
    [ProgressKeys.LastLoginDay]: String(engage.lastLoginDay),
    [ProgressKeys.StreakDay]: String(engage.streakDay),
    [ProgressKeys.LastSpinCoins]: String(engage.lastSpinCoins),
    [ProgressKeys.Gems]: String(gems),
    [ProgressKeys.Xp]: String(xp),
    [ProgressKeys.StreakTokens]: String(streakTokens),
    [ProgressKeys.Items]: items.join(','),
    [ProgressKeys.Missions]: missionsPacked ?? '',
  };
  const res = await playFab()!.client('UpdateUserData', { Data: payload });
  if (res.error) console.warn(`[PlayFabProgress] UpdateUserData failed: ${errorReport(res.error)}`);
}

export const PlayFabPlayerProgress = {
  /** Raised after a pull or a clear (the retention module re-reads its cloud state). */
  changed: new Signal(),

  get isReady(): boolean {
    return pulled && PokerClientIdentity.isPlayFabSignedIn;
  },
  get engagement(): DailyEngagementState {
    return { ...engage };
  },
  get gems(): number {
    return gems;
  },
  get xp(): number {
    return xp;
  },
  get streakTokens(): number {
    return streakTokens;
  },
  get items(): readonly string[] {
    return items;
  },

  clear(): void {
    pulled = false;
    engage = newEngage();
    gems = 0;
    xp = 0;
    streakTokens = 1;
    items.length = 0;
    missionsPacked = '';
    PlayFabPlayerProgress.changed.emit();
  },

  /** Pulls UserData after sign-in; migrates this device's local counters once if the cloud is blank. */
  async pullAsync(): Promise<void> {
    if (!isClientLoggedIn()) {
      pulled = false;
      return;
    }
    const res = await playFab()!.client<{ Data?: UserData }>('GetUserData', { Keys: ALL_KEYS });
    if (res.error) console.warn(`[PlayFabProgress] GetUserData failed: ${errorReport(res.error)}`);
    else applyData(res.data.Data);

    if (engage.lastSpinDay === 0 && engage.lastLoginDay === 0 && engage.streakDay === 0) tryMigrateLocalEngagement();
    if (!missionsPacked) tryMigrateLocalMissions();
    pulled = true;
    PlayFabPlayerProgress.changed.emit();
    await pushAllAsync();
  },

  loadEngagement(): DailyEngagementState {
    return { ...engage };
  },
  saveEngagement(state: DailyEngagementState | null): void {
    if (!state) return;
    engage = { ...state };
    void pushAllAsync();
  },
  loadMissionsPacked(): string {
    return missionsPacked ?? '';
  },
  saveMissionsPacked(packed: string | null): void {
    missionsPacked = packed ?? '';
    void pushAllAsync();
  },

  applyWalletExtras(nextGems: number, nextXp: number, nextTokens: number, nextItems: readonly string[] | null): void {
    gems = Math.max(0, nextGems);
    xp = Math.max(0, nextXp);
    streakTokens = Math.max(0, Math.min(MaxStreakTokens, nextTokens));
    items.length = 0;
    for (const it of nextItems ?? []) if (it && !items.includes(it)) items.push(it);
    void pushAllAsync();
  },

  /** Resolves when no UserData write is pending (tests / before sign-out). */
  async flush(): Promise<void> {
    while (pushInFlight) await pushInFlight;
  },

  resetForTests(): void {
    PlayFabPlayerProgress.clear();
    pushInFlight = null;
    pushDirty = false;
  },
};

function tryMigrateLocalEngagement(): void {
  const spin = PlayerPrefs.getInt(ProgressKeys.LastSpinDay, 0);
  const login = PlayerPrefs.getInt(ProgressKeys.LastLoginDay, 0);
  const streak = PlayerPrefs.getInt(ProgressKeys.StreakDay, 0);
  if (spin === 0 && login === 0 && streak === 0) return;
  engage.lastSpinDay = spin;
  engage.lastLoginDay = login;
  engage.streakDay = streak;
  engage.lastSpinCoins = intOr(PlayerPrefs.getString(ProgressKeys.LastSpinCoins, '0'), 0);
  console.log('[PlayFabProgress] Migrated local engagement counters to PlayFab UserData.');
}

function tryMigrateLocalMissions(): void {
  const local = PlayerPrefs.getString(ProgressKeys.Missions, '');
  if (!local) return;
  missionsPacked = local;
  console.log('[PlayFabProgress] Migrated local mission progress to PlayFab UserData.');
}

// ---- PlayFabAgentProgress -------------------------------------------------------------------------------

/** Poker.Core AgentDeploymentSummary as JsonUtility serialises it (field names as in C#). */
export type AgentDeploymentSummary = Record<string, unknown>;

let summary: AgentDeploymentSummary | null = null;
let agentPulled = false;
let agentPushInFlight: Promise<void> | null = null;

function parseSummary(json: string | undefined | null): AgentDeploymentSummary | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as AgentDeploymentSummary) : null;
  } catch {
    return null;
  }
}

export const PlayFabAgentProgress = {
  changed: new Signal(),

  get isReady(): boolean {
    return agentPulled && PokerClientIdentity.isPlayFabSignedIn;
  },

  clear(): void {
    agentPulled = false;
    summary = null;
  },

  async pullAsync(): Promise<void> {
    if (!isClientLoggedIn()) {
      agentPulled = false;
      return;
    }
    const res = await playFab()!.client<{ Data?: UserData }>('GetUserData', { Keys: [ProgressKeys.AgentLastSummary] });
    if (res.error) console.warn(`[PlayFabAgent] GetUserData failed: ${errorReport(res.error)}`);
    else summary = parseSummary(res.data.Data?.[ProgressKeys.AgentLastSummary]?.Value);
    if (summary === null) {
      summary = parseSummary(PlayerPrefs.getString(ProgressKeys.AgentLastSummary, ''));
      if (summary) console.log('[PlayFabAgent] Migrated local agent summary to PlayFab UserData.');
    }
    agentPulled = true;
    // AgentDeployService.TrySettleFromStore(): the agents module listens to this.
    PlayFabAgentProgress.changed.emit();
  },

  loadSummary(): AgentDeploymentSummary | null {
    return summary ? { ...summary } : null;
  },

  saveSummary(next: AgentDeploymentSummary | null): void {
    if (!next) return;
    summary = { ...next };
    void (async () => {
      if (!isClientLoggedIn() || !summary) return;
      if (agentPushInFlight) {
        await agentPushInFlight;
        return;
      }
      agentPushInFlight = (async () => {
        const res = await playFab()!.client('UpdateUserData', { Data: { [ProgressKeys.AgentLastSummary]: JSON.stringify(summary) } });
        if (res.error) console.warn(`[PlayFabAgent] UpdateUserData failed: ${errorReport(res.error)}`);
      })();
      try {
        await agentPushInFlight;
      } finally {
        agentPushInFlight = null;
      }
    })();
  },
};
