/**
 * The player's chosen free-play stake and buy-in. Port of Game/Stakes/StakeSelection.cs, used by the Stake Select
 * panel (and the Nomad menu's STAKES capsule). 0 = auto-match: Quick Play picks the highest tier the Coins can enter.
 * PlayerPrefs keys are the C# ones.
 */
import { StakeCatalog, maxBuyInChips, type StakeTier } from '@nomad/engine/stakes/stakes';
import type { RetentionEnv } from './dailyEngagement';

const PrefKey = 'Poker.SelectedStake';
const BuyInPrefKey = 'Poker.SelectedBuyIn';

export class StakeSelection {
  /** Fired as 'stake:changed' on the app bus (C# StakeSelection.Changed). */
  static readonly CHANGED = 'stake:changed';
  private selected: number | null = null;
  private buyIn: number | null = null;

  constructor(private readonly env: RetentionEnv) {}

  private get coins(): number {
    return this.env.wallet()?.coins ?? 0;
  }

  /** Min buy-in of the chosen tier, or 0 for auto-match. */
  get selectedMinBuyIn(): number {
    this.selected ??= this.env.prefs.getInt(PrefKey, 0);
    return this.selected;
  }
  set selectedMinBuyIn(value: number) {
    const next = value > 0 && StakeCatalog.isKnown(value) ? value : 0;
    if (this.selected === next) return;
    this.selected = next;
    this.env.prefs.setInt(PrefKey, next);
    this.buyIn = null; // re-clamp to the new tier's window
    this.env.events.emit(StakeSelection.CHANGED);
  }

  get selectedBuyInChips(): number {
    const tier = this.resolve();
    const min = tier.minBuyIn;
    const max = maxBuyInChips(tier, this.coins);
    if (this.buyIn === null) {
      const raw = this.env.prefs.getString(BuyInPrefKey, '');
      const stored = /^\s*[+-]?\d+\s*$/.test(raw) ? Number.parseInt(raw, 10) : tier.startingStack;
      this.buyIn = clamp(stored, min, max);
    }
    return clamp(this.buyIn, min, max);
  }
  set selectedBuyInChips(value: number) {
    const tier = this.resolve();
    const next = clamp(value, tier.minBuyIn, maxBuyInChips(tier, this.coins));
    if (this.buyIn === next) return;
    this.buyIn = next;
    this.env.prefs.setString(BuyInPrefKey, String(next));
    this.env.events.emit(StakeSelection.CHANGED);
  }

  get autoMatch(): boolean {
    return this.selectedMinBuyIn <= 0;
  }

  resolve(): StakeTier {
    return StakeCatalog.resolve(this.selectedMinBuyIn, this.coins);
  }

  canSit(tier: StakeTier): boolean {
    return this.env.wallet()?.canAfford(tier.minBuyIn) ?? false;
  }

  clampBuyIn(amount: number): number {
    const tier = this.resolve();
    return clamp(amount, tier.minBuyIn, maxBuyInChips(tier, this.coins));
  }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) max = min;
  return value < min ? min : value > max ? max : value;
}
