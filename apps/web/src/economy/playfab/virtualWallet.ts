/**
 * Port of Economy/PlayFabVirtualWallet.cs: IVirtualWallet backed by PlayFab's CH balance for coins (+ queued
 * retention grants + this account's free-play delta); gems, XP, streak tokens and cosmetics in UserData via
 * PlayFabPlayerProgress. Coin grants never touch the client currency APIs: they enqueue an idempotent pending
 * grant that the economy bridge has `claimRetentionGrant` pay.
 */
import { RewardKind, type RewardGrant, type VirtualWallet } from '../../app/services';
import { PokerClientIdentity } from '../identity';
import { RetentionGrantQueue } from '../retentionGrantQueue';
import { FreePlayBank } from '../virtualEconomy';
import { PlayFabPlayerProgress } from './playerProgress';
import { PlayFabWallet } from './wallet';

const RewardKindName: Record<RewardKind, string> = {
  [RewardKind.Coins]: 'Coins',
  [RewardKind.Gems]: 'Gems',
  [RewardKind.Xp]: 'Xp',
  [RewardKind.Cosmetic]: 'Cosmetic',
  [RewardKind.StreakToken]: 'StreakToken',
};

/** `<source>:<PlayFabId>:<yyyy-MM-dd UTC>:<Kind>:<amount>:<item>` — checked by economy.js claimRetentionGrant. */
export function buildIdempotencyKey(grant: RewardGrant, playFabId: string, nowMs = Date.now()): string {
  const id = playFabId || 'local';
  const source = grant.source || 'grant';
  const day = new Date(nowMs).toISOString().substring(0, 10);
  return `${source}:${id}:${day}:${RewardKindName[grant.kind]}:${grant.amount}:${grant.itemId ?? ''}`;
}

export class PlayFabVirtualWallet implements VirtualWallet {
  static readonly MaxStreakTokens = 3;

  private readonly items: string[] = [];
  private loaded = false;
  private _gems = 0;
  private _xp = 0;
  private _streakTokens = 0;

  /** Called by the bridge to ask for a flush after a coin grant was queued. */
  constructor(private readonly requestFlush: () => void) {}

  get coins(): number {
    const base = PlayFabWallet.hasBalance ? PlayFabWallet.balance : 0;
    const pending = RetentionGrantQueue.pendingCoinsFor(PokerClientIdentity.playFabId);
    const total = base + pending + FreePlayBank.delta;
    return total < 0 ? 0 : total;
  }
  get gems(): number {
    return this._gems;
  }
  get xp(): number {
    return this._xp;
  }
  get streakTokens(): number {
    return this._streakTokens;
  }
  get ownedItems(): readonly string[] {
    return this.items;
  }

  canAfford(coins: number): boolean {
    return this.coins >= coins;
  }

  owns(itemId: string): boolean {
    if (!itemId) return false;
    this.ensureLoaded();
    return this.items.includes(itemId);
  }

  /** Reload extras from the last PlayFabPlayerProgress.pullAsync. */
  bindToSignedInAccount(): void {
    this.loaded = false;
    this.ensureLoaded();
  }

  grant(grant: RewardGrant): void {
    this.tryGrant(grant);
  }

  tryGrant(grant: RewardGrant): boolean {
    this.ensureLoaded();
    if (grant.amount < 0) return false;
    switch (grant.kind) {
      case RewardKind.Coins:
        return this.grantCoins(grant);
      case RewardKind.Gems:
        this._gems += grant.amount;
        this.persistExtras();
        return true;
      case RewardKind.Xp:
        this._xp += grant.amount;
        this.persistExtras();
        return true;
      case RewardKind.StreakToken:
        this._streakTokens = Math.min(PlayFabVirtualWallet.MaxStreakTokens, this._streakTokens + Math.trunc(grant.amount));
        this.persistExtras();
        return true;
      case RewardKind.Cosmetic:
        if (grant.itemId && !this.items.includes(grant.itemId)) {
          this.items.push(grant.itemId);
          this.persistExtras();
        }
        return true;
      default:
        return false;
    }
  }

  tryConsumeStreakToken(): boolean {
    this.ensureLoaded();
    if (this._streakTokens <= 0) return false;
    this._streakTokens--;
    this.persistExtras();
    return true;
  }

  private grantCoins(grant: RewardGrant): boolean {
    if (grant.amount <= 0) return false;
    const key = buildIdempotencyKey(grant, PokerClientIdentity.playFabId);
    if (!RetentionGrantQueue.tryEnqueue(key, grant.amount, grant.source)) {
      console.log(`[PlayFabWallet] Grant '${key}' already queued or applied — skipping.`);
      return false;
    }
    this.requestFlush();
    return true;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this._gems = PlayFabPlayerProgress.gems;
    this._xp = PlayFabPlayerProgress.xp;
    this._streakTokens = PlayFabPlayerProgress.isReady ? PlayFabPlayerProgress.streakTokens : 1;
    this.items.length = 0;
    for (const it of PlayFabPlayerProgress.items) if (it && !this.items.includes(it)) this.items.push(it);
  }

  private persistExtras(): void {
    PlayFabPlayerProgress.applyWalletExtras(this._gems, this._xp, this._streakTokens, this.items);
  }
}
