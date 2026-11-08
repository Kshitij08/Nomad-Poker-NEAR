/**
 * Daily Coin Spin + 7-day login claims. Port of Game/Retention/DailyEngagement.cs (+ EngagementCloud.cs, the
 * persistence seam). Clock and RNG are injectable so tests can freeze a day. Persistence goes through `cloud` when
 * installed (PlayFab UserData in Unity; whatever the economy module wires here), else PlayerPrefs with the C# keys.
 */
import type { EventBus } from '../app/app';
import { RewardGrant, type VirtualWallet } from '../app/services';
import {
  DailySpinCatalog, DailySpinMath, DailySpinResult, LoginClaimPreview, LoginStreakMath, UtcDay, type Clock,
  type DailyEngagementState,
} from '@nomad/engine/retention';

/** The PlayerPrefs surface retention needs (app/services PlayerPrefs, or an in-memory map in tests). */
export interface PrefsLike {
  getString(key: string, fallback?: string): string;
  setString(key: string, value: string): void;
  getInt(key: string, fallback?: number): number;
  setInt(key: string, value: number): void;
}

/** EngagementCloud: LoadOverride / SaveOverride. Both set = cloud mode. */
export interface EngagementCloud {
  load: (() => DailyEngagementState) | null;
  save: ((s: DailyEngagementState) => void) | null;
}

export interface RetentionEnv {
  readonly events: EventBus;
  readonly prefs: PrefsLike;
  /** Resolved on every use: the economy module may install the wallet after retention. */
  readonly wallet: () => VirtualWallet | undefined;
  clock: Clock;
  /** C# Roll = () => Random.Range(0, 1000). */
  roll: () => number;
}

const LastSpinKey = 'Poker.Engage.LastSpinDay';
const LastLoginKey = 'Poker.Engage.LastLoginDay';
const StreakDayKey = 'Poker.Engage.StreakDay';
const LastSpinCoinsKey = 'Poker.Engage.LastSpinCoins';

/** C# long.TryParse fallback. */
function readLong(prefs: PrefsLike, key: string, fallback: number): number {
  const raw = prefs.getString(key, '');
  return /^\s*[+-]?\d+\s*$/.test(raw) ? Number.parseInt(raw, 10) : fallback;
}

export class DailyEngagement {
  /** Fired as 'engagement:changed' on the app bus (C# DailyEngagement.Changed). */
  static readonly CHANGED = 'engagement:changed';
  readonly cloud: EngagementCloud = { load: null, save: null };

  constructor(private readonly env: RetentionEnv) {}

  get useCloud(): boolean {
    return !!this.cloud.load && !!this.cloud.save;
  }

  notifyChanged(): void {
    this.env.events.emit(DailyEngagement.CHANGED);
  }

  load(): DailyEngagementState {
    if (this.cloud.load) return this.cloud.load();
    const p = this.env.prefs;
    return {
      lastSpinDay: p.getInt(LastSpinKey, 0),
      lastLoginDay: p.getInt(LastLoginKey, 0),
      streakDay: p.getInt(StreakDayKey, 0),
      lastSpinCoins: readLong(p, LastSpinCoinsKey, 0),
    };
  }

  todayDay(): number {
    return UtcDay.fromUtc(this.env.clock());
  }

  canSpin(): boolean {
    return DailySpinMath.canSpin(this.load().lastSpinDay, this.todayDay());
  }

  /** Re-queues today's spin credit if it was recorded but never paid (run once per sign-in). */
  ensureTodaysSpinCredit(): void {
    const s = this.load();
    if (s.lastSpinDay !== this.todayDay() || s.lastSpinCoins <= 0) return;
    this.env.wallet()?.tryGrant(RewardGrant.coins(s.lastSpinCoins, 'daily_spin'));
  }

  trySpin(): DailySpinResult {
    const state = this.load();
    const today = this.todayDay();
    if (!DailySpinMath.canSpin(state.lastSpinDay, today)) return DailySpinResult.alreadySpun();
    const prize = DailySpinMath.pickPrize(this.env.roll());
    // Do not mark the day spun unless the wallet accepted the credit.
    const wallet = this.env.wallet();
    if (!wallet || !wallet.tryGrant(RewardGrant.coins(prize.coins, 'daily_spin'))) {
      console.warn(`[DailySpin] Prize ${prize.coins} was not credited (${wallet ? 'duplicate grant' : 'no wallet installed'}).`);
      return DailySpinResult.alreadySpun();
    }
    state.lastSpinDay = today;
    state.lastSpinCoins = prize.coins;
    this.save(state);
    this.notifyChanged();
    return DailySpinResult.won(prize);
  }

  /** Clears today's spin so it can be tested again without waiting for the next UTC day. */
  debugResetSpin(): void {
    const s = this.load();
    s.lastSpinDay = 0;
    s.lastSpinCoins = 0;
    this.save(s);
    this.notifyChanged();
  }

  /** Clears today's login claim so the weekly track can be claimed again while testing. */
  debugResetLoginClaim(): void {
    const s = this.load();
    s.lastLoginDay = 0;
    this.save(s);
    this.notifyChanged();
  }

  previewLogin(): LoginClaimPreview {
    const s = this.load();
    return LoginStreakMath.preview(s.lastLoginDay, this.todayDay(), s.streakDay, this.env.wallet()?.streakTokens ?? 0);
  }

  tryClaimLogin(): LoginClaimPreview {
    const preview = this.previewLogin();
    if (!preview.canClaim) return preview;
    const wallet = this.env.wallet();
    if (!wallet) return LoginClaimPreview.alreadyClaimed(preview.day, 0); // degrade: nothing to pay into
    if (preview.tokenConsumed && !wallet.tryConsumeStreakToken()) {
      const s = this.load();
      return LoginStreakMath.preview(s.lastLoginDay, this.todayDay(), s.streakDay, 0);
    }
    const reward = LoginClaimPreview.reward(preview);
    wallet.grant(reward.primary);
    if (reward.secondary) wallet.grant(reward.secondary);
    if (reward.tertiary) wallet.grant(reward.tertiary);
    const s = this.load();
    s.lastLoginDay = this.todayDay();
    s.streakDay = preview.day;
    this.save(s);
    this.notifyChanged();
    return preview;
  }

  private save(s: DailyEngagementState): void {
    if (this.cloud.save) {
      this.cloud.save(s);
      return;
    }
    const p = this.env.prefs;
    p.setInt(LastSpinKey, s.lastSpinDay);
    p.setInt(LastLoginKey, s.lastLoginDay);
    p.setInt(StreakDayKey, s.streakDay);
    p.setString(LastSpinCoinsKey, String(s.lastSpinCoins));
  }
}

/** UnityEngine.Random.Range(0, WeightTotal). */
export const defaultRoll = (): number => Math.floor(Math.random() * DailySpinCatalog.WeightTotal);
