/**
 * The economy module's services on ctx.services (see install.ts), and their types for other modules:
 *
 *   ctx.services.wallet        EconomyWallet  — VirtualEconomy.Wallet (+ free-play buy-in / cash-out)
 *   ctx.services.account       EconomyAccount — who is playing + every sign-in flow (account.ts)
 *   ctx.services.progress      ProgressService — cloud save of retention progress (PlayFabPlayerProgress keys)
 *   ctx.services.leaderboards  LeaderboardService — FreePlayLeaderboard (+ PlayFab boards when online)
 *   ctx.services.friends       FriendsService — friends list, requests, table invites, friend codes
 *   ctx.services.avatars       AvatarService — own picture (PlayerAvatar) + catalogue helpers
 *   ctx.services.telemetry     TelemetryService — PokerTelemetry + PokerFunnel, local sink only
 *   ctx.services.economy       EconomyService — backend mode, grant queue, chip-ledger factory for the net server
 */
import { PlayerPrefs, type RewardGrant, type VirtualWallet } from '../app/services';
import { AvatarCatalog } from '@nomad/engine/social/avatarCatalog';
import { AvatarUrl } from '@nomad/engine/social/avatarUrl';
import { FriendCode } from '@nomad/engine/social/friendCode';
import { FriendLastSeen } from '@nomad/engine/social/friendRules';
import type { LeaderboardKind } from '@nomad/engine/leaderboards/freePlayLeaderboardMath';
import type { EconomyAccount } from './account';
import { PokerFunnel } from './analytics/pokerFunnel';
import { PokerTelemetry, type LocalTelemetrySink } from './analytics/pokerTelemetry';
import type { BackendMode } from './config';
import { PokerClientIdentity } from './identity';
import { FreePlayLeaderboard, type LeaderboardSnapshot } from './leaderboards/freePlayLeaderboard';
import { PlayFabEconomyBridge } from './playfab/economyBridge';
import { PlayFabAgentProgress, PlayFabPlayerProgress, ProgressKeys, type AgentDeploymentSummary, type DailyEngagementState } from './playfab/playerProgress';
import { PlayFabWallet } from './playfab/wallet';
import { RetentionGrantQueue } from './retentionGrantQueue';
import type { ChipLedger } from './server/chipLedger';
import type { Signal } from './signal';
import { FriendInvites, type CurrentTable, type FriendInvite } from './social/friendInvites';
import { PlayFabFriends, type FriendEntry, type FriendsResult } from './social/playFabFriends';
import { PlayerAvatar } from './social/playerAvatar';
import { FreePlayBank, VirtualEconomy } from './virtualEconomy';

// ---- wallet ------------------------------------------------------------------------------------------

/** VirtualWallet over VirtualEconomy (so grants notify + log like VirtualEconomy.Grant in C#). */
export interface EconomyWallet extends VirtualWallet {
  /** Free-play buy-in with no server ledger (local wallet spends; PlayFab wallet moves FreePlayBank). */
  tryDebitFreePlay(chips: number): boolean;
  /** Same debit with the telemetry sink named (agent bankroll: 'agent_bankroll'). False when short. */
  trySpendCoins(amount: number, source: string): boolean;
  /** Returns a free-play stack / an unspent agent bankroll. */
  creditFreePlay(chips: number): void;
  /** Re-read the authoritative balance (PlayFab) — no-op offline. */
  refresh(): Promise<void>;
  readonly changed: Signal;
}

export const economyWallet: EconomyWallet = {
  get coins() {
    return VirtualEconomy.wallet.coins;
  },
  get gems() {
    return VirtualEconomy.wallet.gems;
  },
  get xp() {
    return VirtualEconomy.wallet.xp;
  },
  get streakTokens() {
    return VirtualEconomy.wallet.streakTokens;
  },
  get ownedItems() {
    return VirtualEconomy.wallet.ownedItems;
  },
  canAfford: (coins: number) => VirtualEconomy.wallet.canAfford(coins),
  owns: (itemId: string) => VirtualEconomy.wallet.owns(itemId),
  grant: (g: RewardGrant) => VirtualEconomy.grant(g),
  tryGrant: (g: RewardGrant) => VirtualEconomy.tryGrant(g),
  tryConsumeStreakToken: () => VirtualEconomy.tryConsumeStreakToken(),
  tryDebitFreePlay: (chips: number) => VirtualEconomy.tryDebitFreePlay(chips),
  trySpendCoins: (amount: number, source: string) => VirtualEconomy.trySpendCoins(amount, source),
  creditFreePlay: (chips: number) => VirtualEconomy.creditFreePlay(chips),
  refresh: async () => {
    if (PokerClientIdentity.isPlayFabSignedIn) await PlayFabWallet.refreshAsync();
  },
  changed: VirtualEconomy.changed,
};

// ---- progress ----------------------------------------------------------------------------------------

/**
 * Cloud save of retention progress (PlayFabPlayerProgress / PlayFabAgentProgress), shaped as the retention module's
 * EngagementCloud / ProgressionCloud seam. While a PlayFab account is signed in (`isCloud`) reads and writes go to
 * UserData; otherwise they go to PlayerPrefs with the C# keys — exactly what EngagementCloud does with no override —
 * so retention can wire this once at install. 'progress:loaded' fires on ctx.events after every pull / sign-out.
 */
export interface ProgressService {
  readonly isCloud: boolean;
  readonly changed: Signal;
  loadEngagement(): DailyEngagementState;
  saveEngagement(state: DailyEngagementState): void;
  loadMissions(): string;
  saveMissions(packed: string): void;
  readonly agentIsCloud: boolean;
  readonly agentChanged: Signal;
  loadAgentSummary(): AgentDeploymentSummary | null;
  saveAgentSummary(summary: AgentDeploymentSummary): void;
  /** After a PlayFab sign-in installed the cloud wallet (C#: DailyEngagement.EnsureTodaysSpinCredit runs here). */
  readonly attached: Signal;
}

const localLong = (key: string): number => {
  const raw = PlayerPrefs.getString(key, '').trim();
  return /^[+-]?\d+$/.test(raw) ? Number(raw) : 0;
};

export const progressService: ProgressService = {
  get isCloud() {
    return PlayFabPlayerProgress.isReady;
  },
  changed: PlayFabPlayerProgress.changed,
  loadEngagement: () => PlayFabPlayerProgress.isReady ? PlayFabPlayerProgress.loadEngagement() : {
    lastSpinDay: PlayerPrefs.getInt(ProgressKeys.LastSpinDay, 0),
    lastLoginDay: PlayerPrefs.getInt(ProgressKeys.LastLoginDay, 0),
    streakDay: PlayerPrefs.getInt(ProgressKeys.StreakDay, 0),
    lastSpinCoins: localLong(ProgressKeys.LastSpinCoins),
  },
  saveEngagement: (s) => {
    if (PlayFabPlayerProgress.isReady) return PlayFabPlayerProgress.saveEngagement(s);
    PlayerPrefs.setInt(ProgressKeys.LastSpinDay, s.lastSpinDay);
    PlayerPrefs.setInt(ProgressKeys.LastLoginDay, s.lastLoginDay);
    PlayerPrefs.setInt(ProgressKeys.StreakDay, s.streakDay);
    PlayerPrefs.setString(ProgressKeys.LastSpinCoins, String(s.lastSpinCoins));
  },
  loadMissions: () => (PlayFabPlayerProgress.isReady ? PlayFabPlayerProgress.loadMissionsPacked() : PlayerPrefs.getString(ProgressKeys.Missions, '')),
  saveMissions: (p) => {
    if (PlayFabPlayerProgress.isReady) PlayFabPlayerProgress.saveMissionsPacked(p);
    else PlayerPrefs.setString(ProgressKeys.Missions, p);
  },
  get agentIsCloud() {
    return PlayFabAgentProgress.isReady;
  },
  agentChanged: PlayFabAgentProgress.changed,
  loadAgentSummary: () => {
    if (PlayFabAgentProgress.isReady) return PlayFabAgentProgress.loadSummary();
    try {
      const v = JSON.parse(PlayerPrefs.getString(ProgressKeys.AgentLastSummary, '')) as unknown;
      return v && typeof v === 'object' ? (v as AgentDeploymentSummary) : null;
    } catch {
      return null;
    }
  },
  saveAgentSummary: (s) => {
    if (PlayFabAgentProgress.isReady) PlayFabAgentProgress.saveSummary(s);
    else PlayerPrefs.setString(ProgressKeys.AgentLastSummary, JSON.stringify(s));
  },
  attached: PlayFabEconomyBridge.attached,
};

// ---- leaderboards ------------------------------------------------------------------------------------

export interface LeaderboardService {
  fetch(kind: LeaderboardKind, pageIndex?: number): Promise<LeaderboardSnapshot>;
  /** Once per finished free-play hand (net chips, won?). Also submits to PlayFab when signed in. */
  recordHand(netChips: number, won: boolean): void;
  localScore(kind: LeaderboardKind): number;
  titleFor(kind: LeaderboardKind): string;
  scoreColumnFor(kind: LeaderboardKind): string;
  readonly changed: Signal;
}

export const leaderboardService: LeaderboardService = {
  fetch: (kind, page = 0) => FreePlayLeaderboard.fetchAsync(kind, page),
  recordHand: (net, won) => FreePlayLeaderboard.recordHand(net, won),
  localScore: (k) => FreePlayLeaderboard.localScore(k),
  titleFor: (k) => FreePlayLeaderboard.titleFor(k),
  scoreColumnFor: (k) => FreePlayLeaderboard.scoreColumnFor(k),
  changed: FreePlayLeaderboard.changed,
};

// ---- friends -----------------------------------------------------------------------------------------

export interface FriendsService {
  readonly all: readonly FriendEntry[];
  readonly incomingCount: number;
  readonly lastError: string | null;
  readonly changed: Signal;
  refresh(): Promise<FriendsResult>;
  sendRequest(idOrName: string): Promise<FriendsResult>;
  accept(friendId: string): Promise<FriendsResult>;
  remove(friendId: string): Promise<FriendsResult>;
  find(playFabId: string): FriendEntry | null;
  // invites
  readonly inbox: readonly FriendInvite[];
  readonly invitesChanged: Signal;
  pollInvites(): Promise<void>;
  invite(friend: FriendEntry): Promise<FriendsResult>;
  acceptInvite(invite: FriendInvite): Promise<string | null>;
  declineInvite(invite: FriendInvite): void;
  /** The net module: which table this client sits at (null in the menu). */
  setCurrentTable(table: CurrentTable | null): void;
  readonly currentTable: CurrentTable | null;
  /** The net module: performs the join of an accepted invite (resolve null once under way). */
  setJoinHandler(fn: ((invite: FriendInvite) => Promise<string | null>) | null): void;
  // pure helpers (Core/Social)
  formatCode(playFabId: string): string;
  parseCode(input: string): string | null;
  lastSeen(lastLoginUtcMs: number | null, nowMs?: number): string;
  /** FriendsHud.OpenAvatarPicker (the Nomad menu's Edit Avatar / Edit Picture): opens the friends sheet + picker. */
  openAvatarPicker(): void;
  /** FriendsHud.TogglePanel / OpenPanel. */
  openPanel(): void;
}

export const friendsService: FriendsService = {
  get all() {
    return PlayFabFriends.all;
  },
  get incomingCount() {
    return PlayFabFriends.incomingCount;
  },
  get lastError() {
    return PlayFabFriends.lastError;
  },
  changed: PlayFabFriends.changed,
  refresh: () => PlayFabFriends.refreshAsync(),
  sendRequest: (q) => PlayFabFriends.sendRequestAsync(q),
  accept: (id) => PlayFabFriends.acceptAsync(id),
  remove: (id) => PlayFabFriends.removeAsync(id),
  find: (id) => PlayFabFriends.find(id),
  get inbox() {
    return FriendInvites.inbox;
  },
  invitesChanged: FriendInvites.changed,
  pollInvites: () => FriendInvites.pollAsync(),
  invite: (f) => FriendInvites.inviteAsync(f),
  acceptInvite: (i) => FriendInvites.acceptAsync(i),
  declineInvite: (i) => FriendInvites.decline(i),
  setCurrentTable: (t) => FriendInvites.setCurrentTable(t),
  get currentTable() {
    return FriendInvites.currentTable;
  },
  setJoinHandler: (fn) => {
    FriendInvites.joinHandler = fn;
  },
  formatCode: (id) => FriendCode.format(id),
  parseCode: (s) => FriendCode.tryParse(s),
  lastSeen: (t, now = Date.now()) => FriendLastSeen.describe(t, now),
  openAvatarPicker: () => friendsUi.openAvatarPicker?.(),
  openPanel: () => friendsUi.openPanel?.(),
};

/** Set by install(): the FriendsHud port (ui/friendsHud.ts). */
export const friendsUi: { openAvatarPicker?: () => void; openPanel?: () => void } = {};

// ---- avatars -----------------------------------------------------------------------------------------

export interface AvatarService {
  /** Own pick (0 = None). */
  readonly current: number;
  shown(playerName: string | null): number;
  choose(avatar: number): void;
  readonly changed: Signal;
  readonly count: number;
  idOf(avatar: number): string | null;
  urlFor(avatar: number): string;
  fromUrl(url: string | null): number;
  /** Public URL of an avatar sprite (the HUD extractor's copy of Assets/Test/UI/Common_UI/Pro_Pic/<id>.png). */
  spriteUrl(avatar: number): string | null;
}

export const avatarService: AvatarService = {
  get current() {
    return PlayerAvatar.current;
  },
  shown: (n) => PlayerAvatar.shown(n),
  choose: (a) => PlayerAvatar.choose(a),
  changed: PlayerAvatar.changed,
  get count() {
    return AvatarCatalog.count;
  },
  idOf: (a) => AvatarCatalog.idOf(a),
  urlFor: (a) => AvatarUrl.urlFor(a),
  fromUrl: (u) => AvatarUrl.fromUrl(u),
  spriteUrl: (a) => {
    const id = AvatarCatalog.idOf(a);
    return id ? `${import.meta.env.BASE_URL ?? '/'}assets/ui/Test/UI/Common_UI/Pro_Pic/${id}.webp` : null;
  },
};

// ---- telemetry ---------------------------------------------------------------------------------------

export interface TelemetryService {
  readonly telemetry: typeof PokerTelemetry;
  readonly funnel: typeof PokerFunnel;
  /** The local buffer (recent events, newest last). */
  readonly events: LocalTelemetrySink['events'];
}

// ---- economy (module-level) --------------------------------------------------------------------------

export interface EconomyService {
  readonly mode: BackendMode;
  readonly grantQueue: typeof RetentionGrantQueue;
  readonly freePlayBank: typeof FreePlayBank;
  /** Settle queued retention coin grants now (no-op offline). */
  requestFlushPendingGrants(): void;
  /** PlayFabWallet.MarkAtTable / ClearAtTable for the net module (reload-safe cash-out follow). */
  markAtTable(): void;
  clearAtTable(): void;
  /** A chip ledger for the dedicated-server stand-in (offline: over the local title, in memory or localStorage). */
  createChipLedger(): ChipLedger;
  /** `?online=local` only: seed demo friends / requests / an invite / leaderboard rivals for the signed-in player. */
  seedLocalDemo(): Promise<void>;
}

declare module '../app/app' {
  interface Services {
    economy?: EconomyService;
    progress?: ProgressService;
    leaderboards?: LeaderboardService;
    friends?: FriendsService;
    avatars?: AvatarService;
    telemetry?: TelemetryService;
  }
}

/** The richer account type other modules may narrow to: `ctx.services.account as EconomyAccount`. */
export type { EconomyAccount };
