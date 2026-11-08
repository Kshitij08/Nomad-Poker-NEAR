/**
 * The base services every module shares. Ports of the Unity interfaces they mirror; modules swap in
 * richer implementations (PlayFab, wallet) by assigning ctx.services.<name> in their install().
 */
import type { EventBus } from './app';
import { RewardGrant, RewardKind } from '@nomad/engine/economy/rewards';

// ---- PlayerPrefs ---------------------------------------------------------------------------------

/** UnityEngine.PlayerPrefs over localStorage (keys kept identical to the C# so behaviour matches). */
export const PlayerPrefs = {
  getString(key: string, fallback = ''): string {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  setString(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode / blocked storage: behave like a fresh install */
    }
  },
  getInt(key: string, fallback = 0): number {
    const v = PlayerPrefs.getString(key, '');
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  },
  setInt(key: string, value: number): void {
    PlayerPrefs.setString(key, String(Math.trunc(value)));
  },
  getFloat(key: string, fallback = 0): number {
    const n = Number.parseFloat(PlayerPrefs.getString(key, ''));
    return Number.isFinite(n) ? n : fallback;
  },
  setFloat(key: string, value: number): void {
    PlayerPrefs.setString(key, String(value));
  },
  hasKey(key: string): boolean {
    try {
      return localStorage.getItem(key) !== null;
    } catch {
      return false;
    }
  },
  deleteKey(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

// ---- Economy (Poker.Core IVirtualWallet / RewardGrant) ------------------------------------------

export { RewardGrant, RewardKind };

/** Port of Poker.Core.IVirtualWallet. Emits 'wallet:changed' on the app bus when balances move. */
export interface VirtualWallet {
  readonly coins: number;
  readonly gems: number;
  readonly xp: number;
  readonly streakTokens: number;
  canAfford(coins: number): boolean;
  grant(grant: RewardGrant): void;
  tryGrant(grant: RewardGrant): boolean;
  tryConsumeStreakToken(): boolean;
  readonly ownedItems: readonly string[];
  owns(itemId: string): boolean;
}

// ---- Account --------------------------------------------------------------------------------------

/** Who is playing: guest / PlayFab / wallet. Emits 'account:changed'. */
export interface AccountService {
  readonly signedIn: boolean;
  /** PlayFab id, wallet address or a local guest id. */
  readonly playerId: string;
  readonly displayName: string;
  /** Poker.Core AvatarCatalog id (0 = None → name-derived default face). */
  readonly avatar: number;
  /** Solana wallet public key when signed in with a wallet. */
  readonly walletAddress: string | null;
  setDisplayName(name: string): Promise<void>;
  setAvatar(avatar: number): Promise<void>;
  signOut(): Promise<void>;
}

/** Offline guest account kept in PlayerPrefs — what the game falls back to with no backend. */
export class LocalAccount implements AccountService {
  readonly walletAddress = null;
  constructor(private readonly events: EventBus) {
    if (!PlayerPrefs.hasKey('web.guestId')) PlayerPrefs.setString('web.guestId', 'guest-' + crypto.randomUUID().slice(0, 8));
  }
  get signedIn(): boolean {
    return true;
  }
  get playerId(): string {
    return PlayerPrefs.getString('web.guestId');
  }
  get displayName(): string {
    return PlayerPrefs.getString('poker.playerName', 'You');
  }
  get avatar(): number {
    return PlayerPrefs.getInt('poker.avatar', 0);
  }
  async setDisplayName(name: string): Promise<void> {
    PlayerPrefs.setString('poker.playerName', name);
    this.events.emit('account:changed');
  }
  async setAvatar(avatar: number): Promise<void> {
    PlayerPrefs.setInt('poker.avatar', avatar);
    this.events.emit('account:changed');
  }
  async signOut(): Promise<void> {
    this.events.emit('account:changed');
  }
}

declare module './app' {
  interface Services {
    account: AccountService;
    /** Set by the economy module (LocalVirtualWallet offline, PlayFabVirtualWallet online). */
    wallet?: VirtualWallet;
  }
}
