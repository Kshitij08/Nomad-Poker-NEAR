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
import type { RetentionBackend } from './backend';

/**
 * Local testing: unlimited daily spins on a dev server (localhost / 127.0.0.1 with a port, so the store apps, which
 * serve from https://localhost with no port, never match). Offline the spin is local anyway; with a Nomad server
 * the API also has to allow it, which it does only in its `development` stage (apps/api, progress.spin `unlimited`).
 */
export function devUnlimitedSpins(): boolean {
  if (typeof location === 'undefined') return false;
  return (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && location.port !== '';
}

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
  /** Set when a Nomad server owns retention: state comes from it, and spins / claims are its decisions. */
  backend: RetentionBackend | null = null;

  constructor(private readonly env: RetentionEnv) {}

  get useCloud(): boolean {
    return !!this.cloud.load && !!this.cloud.save;
  }

  notifyChanged(): void {
    this.env.events.emit(DailyEngagement.CHANGED);
  }

  load(): DailyEngagementState {
    if (this.backend) {
      const snap = this.backend.snapshot;
      return {
        lastSpinDay: snap?.spin.lastSpinDay ?? 0,
        lastLoginDay: snap?.login.lastLoginDay ?? 0,
        streakDay: snap?.login.streakDay ?? 0,
        lastSpinCoins: snap?.spin.lastSpinCoins ?? 0,
      };
    }
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
    // The server's day when it owns retention (its clock decides when a new day starts).
    return this.backend?.snapshot?.today ?? UtcDay.fromUtc(this.env.clock());
  }

  canSpin(): boolean {
    if (devUnlimitedSpins()) return true;
    if (this.backend) return this.backend.snapshot?.spin.canSpin ?? false;
    return DailySpinMath.canSpin(this.load().lastSpinDay, this.todayDay());
  }

  /** The spin, wherever it is decided: the server's roll and payout with a backend, else trySpin. Screens call this. */
  async spin(): Promise<DailySpinResult> {
    if (!this.backend) return this.trySpin();
    const r = await this.backend.spin();
    this.notifyChanged();
    if (!r) return { ...DailySpinResult.alreadySpun(), error: "Couldn't reach the server. Try again." };
    if (!r.awarded) return DailySpinResult.alreadySpun();
    return DailySpinResult.won(DailySpinCatalog.prizeAt(DailySpinMath.prizeIndex(r.coins)));
  }

  /** The login claim, wherever it is decided (see spin). */
  async claimLogin(): Promise<LoginClaimPreview> {
    if (!this.backend) return this.tryClaimLogin();
    const r = await this.backend.claimLogin();
    this.notifyChanged();
    const tokens = this.env.wallet()?.streakTokens ?? 0;
    if (!r) return { ...LoginClaimPreview.alreadyClaimed(1, tokens), error: "Couldn't reach the server. Try again." };
    if (!r.claimed) return LoginClaimPreview.alreadyClaimed(r.day, tokens);
    return LoginClaimPreview.claim(r.day, tokens, r.tokenConsumed, r.reset);
  }

  /** Re-queues today's spin credit if it was recorded but never paid (run once per sign-in). */
  ensureTodaysSpinCredit(): void {
    if (this.backend) return; // the server pays a spin in the same step that records it
    const s = this.load();
    if (s.lastSpinDay !== this.todayDay() || s.lastSpinCoins <= 0) return;
    this.env.wallet()?.tryGrant(RewardGrant.coins(s.lastSpinCoins, 'daily_spin'));
  }

  trySpin(): DailySpinResult {
    const state = this.load();
    const today = this.todayDay();
    if (!devUnlimitedSpins() && !DailySpinMath.canSpin(state.lastSpinDay, today)) return DailySpinResult.alreadySpun();
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
    if (this.backend) {
      const l = this.backend.snapshot?.login;
      if (!l) return LoginClaimPreview.alreadyClaimed(1, 0);
      return l.canClaim ? LoginClaimPreview.claim(l.day, l.tokensAfter, l.tokenConsumed, l.reset) : LoginClaimPreview.alreadyClaimed(l.day, l.tokensAfter);
    }
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
