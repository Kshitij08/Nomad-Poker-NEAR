/**
 * The economy module's services on ctx.services (see install.ts), and their types for other modules:
 *
 *   ctx.services.wallet        EconomyWallet  — VirtualEconomy.Wallet (+ free-play buy-in / cash-out)
 *   ctx.services.account       EconomyAccount — who is playing + every sign-in flow (account.ts)
 *   ctx.services.leaderboards  LeaderboardService — the Nomad server's boards (local counters offline)
 *   ctx.services.friends       FriendsService — friends list, requests, table invites, friend codes (Nomad server)
 *   ctx.services.avatars       AvatarService — own picture (PlayerAvatar) + catalogue helpers
 *   ctx.services.telemetry     TelemetryService — PokerTelemetry + PokerFunnel, local sink only
 *   ctx.services.economy       EconomyService — the chip-ledger factory for the local table server
 *
 * PlayFab is gone (Phase 4): with a Nomad server configured the account, wallet, rewards, friends and leaderboards
 * are the server's; without one the game plays offline on a local guest and wallet.
 */
import type { RewardGrant, VirtualWallet } from '../app/services';
import { AvatarCatalog } from '@nomad/engine/social/avatarCatalog';
import { AvatarUrl } from '@nomad/engine/social/avatarUrl';
import { FriendCode } from '@nomad/engine/social/friendCode';
import { FriendLastSeen } from '@nomad/engine/social/friendRules';
import type { LeaderboardKind } from '@nomad/engine/leaderboards/freePlayLeaderboardMath';
import type { EconomyAccount } from './account';
import { PokerFunnel } from './analytics/pokerFunnel';
import { PokerTelemetry, type LocalTelemetrySink } from './analytics/pokerTelemetry';
import { FreePlayLeaderboard, type LeaderboardSnapshot } from './leaderboards/freePlayLeaderboard';
import type { ChipLedger } from './server/chipLedger';
import type { Signal } from './signal';
import { FriendInvites, type CurrentTable, type FriendInvite } from './social/friendInvites';
import { Friends, type FriendEntry, type FriendsResult } from './social/friends';
import { PlayerAvatar } from './social/playerAvatar';
import { VirtualEconomy } from './virtualEconomy';

// ---- wallet ------------------------------------------------------------------------------------------

/** VirtualWallet over VirtualEconomy (so grants notify + log like VirtualEconomy.Grant in C#). */
export interface EconomyWallet extends VirtualWallet {
  /** Free-play buy-in with no server ledger (the local wallet spends; a server wallet refuses). */
  tryDebitFreePlay(chips: number): boolean;
  /** Same debit with the telemetry sink named (agent bankroll: 'agent_bankroll'). False when short. */
  trySpendCoins(amount: number, source: string): boolean;
  /** Returns a free-play stack / an unspent agent bankroll. */
  creditFreePlay(chips: number): void;
  /** Re-read the authoritative balance (the server's, when it owns the wallet). */
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
    (VirtualEconomy.wallet as { refresh?: () => void }).refresh?.();
  },
  changed: VirtualEconomy.changed,
};

// ---- leaderboards ------------------------------------------------------------------------------------

export interface LeaderboardService {
  fetch(kind: LeaderboardKind, pageIndex?: number): Promise<LeaderboardSnapshot>;
  /** Once per finished free-play hand (net chips, won?) — local counters; the server counts its own hands. */
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
  find(friendId: string): FriendEntry | null;
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
  formatCode(friendId: string): string;
  parseCode(input: string): string | null;
  lastSeen(lastLoginUtcMs: number | null, nowMs?: number): string;
  /** FriendsHud.OpenAvatarPicker (the Nomad menu's Edit Avatar / Edit Picture): opens the friends sheet + picker. */
  openAvatarPicker(): void;
  /** FriendsHud.TogglePanel / OpenPanel. */
  openPanel(): void;
}

export const friendsService: FriendsService = {
  get all() {
    return Friends.all;
  },
  get incomingCount() {
    return Friends.incomingCount;
  },
  get lastError() {
    return Friends.lastError;
  },
  changed: Friends.changed,
  refresh: () => Friends.refreshAsync(),
  sendRequest: (q) => Friends.sendRequestAsync(q),
  accept: (id) => Friends.acceptAsync(id),
  remove: (id) => Friends.removeAsync(id),
  find: (id) => Friends.find(id),
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
  /** 'nomad' with a Nomad server configured, else 'offline'. */
  readonly mode: 'nomad' | 'offline';
  /** A chip ledger for the local table server (in memory). */
  createChipLedger(): ChipLedger;
}

declare module '../app/app' {
  interface Services {
    economy?: EconomyService;
    leaderboards?: LeaderboardService;
    friends?: FriendsService;
    avatars?: AvatarService;
    telemetry?: TelemetryService;
  }
}

/** The richer account type other modules may narrow to: `ctx.services.account as EconomyAccount`. */
export type { EconomyAccount };
