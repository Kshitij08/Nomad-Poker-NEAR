/**
 * Ports of Game/Stakes/StakeSelection.cs (the chosen free-play stake and buy-in, persisted under the same
 * PlayerPrefs keys) and Game/Stakes/StakeTableSkin.cs (stakes ↔ table looks).
 *
 * TableBuyInPanel.cs (the slider + typed amount on the old Fusion menu's TABLES overlay) belongs to ThemePicker's flow,
 * which the Nomad menu hides; it is not reachable here and is not ported (see README).
 */
import { PlayerPrefs } from '../app/services';
import type { AppContext } from '../app/app';
import { StakeCatalog, maxBuyInChips, type StakeTier } from '../core';

const PREF_KEY = 'Poker.SelectedStake';
const BUY_IN_PREF_KEY = 'Poker.SelectedBuyIn';
/** LocalVirtualWallet.DefaultStartingCoins: the balance with no economy module installed. */
export const OFFLINE_COINS = 10_000;

export type Theme = 'Default' | 'Neon_City' | 'Forest' | 'Desert' | 'Town';

export class StakeSelection {
  private selected: number | null = null;
  private buyIn: number | null = null;
  readonly changed: (() => void)[] = [];

  constructor(private readonly ctx: AppContext) {
    ctx.events.on('stake:changed', () => {
      for (const fn of [...this.changed]) fn();
    });
  }

  /** The retention module's StakeSelection when installed (one cache for the same PlayerPrefs keys). */
  private get ext(): ExtStakes | null {
    const s = (this.ctx.services as unknown as { retention?: { stakes?: ExtStakes } }).retention?.stakes;
    return s && typeof s.resolve === 'function' ? s : null;
  }

  get coins(): number {
    return this.ctx.services.wallet?.coins ?? OFFLINE_COINS;
  }

  /** Min buy-in of the chosen tier, or 0 for auto-match. */
  get selectedMinBuyIn(): number {
    if (this.ext) return this.ext.selectedMinBuyIn;
    this.selected ??= PlayerPrefs.getInt(PREF_KEY, 0);
    return this.selected;
  }
  set selectedMinBuyIn(value: number) {
    if (this.ext) {
      this.ext.selectedMinBuyIn = value;
      return;
    }
    const next = value > 0 && StakeCatalog.isKnown(value) ? value : 0;
    if (this.selected === next) return;
    this.selected = next;
    PlayerPrefs.setInt(PREF_KEY, next);
    this.buyIn = null;
    this.emit();
  }

  /** Chips to bring to the table, clamped to the resolved tier's min…max for the current wallet. */
  get selectedBuyInChips(): number {
    if (this.ext) return this.ext.selectedBuyInChips;
    const tier = this.resolve();
    const min = tier.minBuyIn;
    const max = maxBuyInChips(tier, this.coins);
    if (this.buyIn === null) {
      const raw = Number.parseInt(PlayerPrefs.getString(BUY_IN_PREF_KEY, ''), 10);
      this.buyIn = clamp(Number.isFinite(raw) ? raw : tier.startingStack, min, max);
    }
    return clamp(this.buyIn, min, max);
  }
  set selectedBuyInChips(value: number) {
    if (this.ext) {
      this.ext.selectedBuyInChips = value;
      return;
    }
    const tier = this.resolve();
    const next = clamp(value, tier.minBuyIn, maxBuyInChips(tier, this.coins));
    if (this.buyIn === next) return;
    this.buyIn = next;
    PlayerPrefs.setString(BUY_IN_PREF_KEY, String(next));
    this.emit();
  }

  get autoMatch(): boolean {
    return this.selectedMinBuyIn <= 0;
  }

  resolve(): StakeTier {
    if (this.ext) return this.ext.resolve();
    return StakeCatalog.resolve(this.selectedMinBuyIn, this.coins);
  }

  canSit(tier: StakeTier): boolean {
    return this.ctx.services.wallet ? this.ctx.services.wallet.canAfford(tier.minBuyIn) : this.coins >= tier.minBuyIn;
  }

  minBuyInChips(tier: StakeTier): number {
    return tier.minBuyIn;
  }

  maxBuyInChips(tier: StakeTier, coins = this.coins): number {
    return maxBuyInChips(tier, coins);
  }

  private emit(): void {
    this.ctx.events.emit('stake:changed');
  }
}

interface ExtStakes {
  selectedMinBuyIn: number;
  selectedBuyInChips: number;
  resolve(): StakeTier;
}

function clamp(v: number, min: number, max: number): number {
  if (max < min) max = min;
  return v < min ? min : v > max ? max : v;
}

export const StakeTableSkin = {
  themeFor(minBuyIn: number): Theme {
    if (minBuyIn >= 5000) return 'Neon_City';
    if (minBuyIn >= 1000) return 'Desert';
    if (minBuyIn >= 500) return 'Town';
    if (minBuyIn >= 100) return 'Forest';
    return 'Default';
  },
  stakesFor(theme: Theme): StakeTier[] {
    switch (theme) {
      case 'Default':
        return [StakeCatalog.get(50)];
      case 'Forest':
        return [StakeCatalog.get(100)];
      case 'Town':
        return [StakeCatalog.get(500)];
      case 'Desert':
        return [StakeCatalog.get(1000)];
      case 'Neon_City':
        return [StakeCatalog.get(5000), StakeCatalog.get(10000)];
      default:
        return [StakeCatalog.Default];
    }
  },
  primaryMinBuyIn(theme: Theme): number {
    return StakeTableSkin.stakesFor(theme)[0]?.minBuyIn ?? StakeCatalog.DefaultMinBuyIn;
  },
  canAfford(theme: Theme, coins: number): boolean {
    return coins >= StakeTableSkin.primaryMinBuyIn(theme);
  },
  /** Two compact lines under the theme name on a Tables card. */
  stakeCaption(theme: Theme): string {
    const stakes = StakeTableSkin.stakesFor(theme);
    const t = stakes[0];
    if (!t) return '';
    let buyIn = t.minBuyIn >= 1000 ? `${t.minBuyIn / 1000}K` : t.buyInLabel;
    if (stakes.length > 1) buyIn += '+';
    return `${t.displayName} · ${buyIn}\n${t.blindsLabel}`;
  },
  /** Applies the theme (ThemeManager.SetTheme) and picks the highest stake on this table the player can afford. */
  selectThemeTable(theme: Theme, sel: StakeSelection, setTheme?: (t: Theme) => void): StakeTier {
    setTheme?.(theme);
    const stakes = StakeTableSkin.stakesFor(theme);
    let pick = stakes[0]!;
    for (const s of stakes) if (sel.coins >= s.minBuyIn) pick = s;
    sel.selectedMinBuyIn = pick.minBuyIn;
    return pick;
  },
};
