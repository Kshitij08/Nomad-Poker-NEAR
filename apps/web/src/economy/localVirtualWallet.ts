/**
 * Port of Game/Economy/LocalVirtualWallet.cs: the PlayerPrefs stand-in for the Coin/Gem ledger, same keys and same
 * first-run defaults (10,000 coins, 1 streak token).
 */
import { PlayerPrefs, RewardKind, type RewardGrant, type VirtualWallet } from '../app/services';

const CoinsKey = 'Poker.Wallet.Coins';
const GemsKey = 'Poker.Wallet.Gems';
const XpKey = 'Poker.Wallet.Xp';
const TokensKey = 'Poker.Wallet.StreakTokens';
const ItemsKey = 'Poker.Wallet.Items';
const InitializedKey = 'Poker.Wallet.Initialized';

/** C# long.TryParse over an invariant integer string. */
export function readLong(key: string, fallback: number): number {
  const raw = PlayerPrefs.getString(key, '').trim();
  return /^[+-]?\d+$/.test(raw) ? Number(raw) : fallback;
}

export class LocalVirtualWallet implements VirtualWallet {
  static readonly DefaultStartingCoins = 10_000;
  static readonly DefaultStartingTokens = 1;
  static readonly MaxStreakTokens = 3;

  private readonly items: string[] = [];
  private loaded = false;
  private _coins = 0;
  private _gems = 0;
  private _xp = 0;
  private _streakTokens = 0;

  get coins(): number {
    return this._coins;
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
    return this._coins >= coins;
  }

  /** Removes coins for a free-play buy-in (no PlayFab ledger on this process). */
  trySpendCoins(coins: number): boolean {
    this.ensureLoaded();
    if (coins <= 0) return true;
    if (this._coins < coins) return false;
    this._coins -= coins;
    this.persist();
    return true;
  }

  owns(itemId: string): boolean {
    if (!itemId) return false;
    this.ensureLoaded();
    return this.items.includes(itemId);
  }

  grant(grant: RewardGrant): void {
    this.tryGrant(grant);
  }

  tryGrant(grant: RewardGrant): boolean {
    this.ensureLoaded();
    if (grant.amount < 0) return false;
    switch (grant.kind) {
      case RewardKind.Coins:
        this._coins += grant.amount;
        break;
      case RewardKind.Gems:
        this._gems += grant.amount;
        break;
      case RewardKind.Xp:
        this._xp += grant.amount;
        break;
      case RewardKind.StreakToken:
        this._streakTokens = Math.min(LocalVirtualWallet.MaxStreakTokens, this._streakTokens + Math.trunc(grant.amount));
        break;
      case RewardKind.Cosmetic:
        if (grant.itemId && !this.items.includes(grant.itemId)) this.items.push(grant.itemId);
        break;
      default:
        return false;
    }
    this.persist();
    return true;
  }

  tryConsumeStreakToken(): boolean {
    this.ensureLoaded();
    if (this._streakTokens <= 0) return false;
    this._streakTokens--;
    this.persist();
    return true;
  }

  ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    if (PlayerPrefs.getInt(InitializedKey, 0) === 0) {
      this._coins = LocalVirtualWallet.DefaultStartingCoins;
      this._gems = 0;
      this._xp = 0;
      this._streakTokens = LocalVirtualWallet.DefaultStartingTokens;
      PlayerPrefs.setInt(InitializedKey, 1);
      this.persist();
      return;
    }

    this._coins = readLong(CoinsKey, LocalVirtualWallet.DefaultStartingCoins);
    this._gems = readLong(GemsKey, 0);
    this._xp = readLong(XpKey, 0);
    this._streakTokens = PlayerPrefs.getInt(TokensKey, LocalVirtualWallet.DefaultStartingTokens);
    this.items.length = 0;
    const packed = PlayerPrefs.getString(ItemsKey, '');
    if (packed.length === 0) return;
    for (const part of packed.split(',')) if (part && !this.items.includes(part)) this.items.push(part);
  }

  private persist(): void {
    PlayerPrefs.setString(CoinsKey, String(this._coins));
    PlayerPrefs.setString(GemsKey, String(this._gems));
    PlayerPrefs.setString(XpKey, String(this._xp));
    PlayerPrefs.setInt(TokensKey, this._streakTokens);
    PlayerPrefs.setString(ItemsKey, this.items.join(','));
  }
}
