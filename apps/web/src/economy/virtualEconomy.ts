/**
 * Ports of Game/Economy/VirtualEconomy.cs (process-wide wallet access, provider swap) and FreePlayBank.cs (the
 * per-account free-play P/L overlay used when a PlayFab wallet is installed but no server ledger settles tables).
 */
import { PlayerPrefs, RewardGrant, RewardKind, type VirtualWallet } from '../app/services';
import { PokerTelemetry } from './analytics/pokerTelemetry';
import { LocalVirtualWallet, readLong } from './localVirtualWallet';
import { Signal } from './signal';

// ---- VirtualEconomy ----------------------------------------------------------------------------------

let wallet: VirtualWallet | null = null;

function ensure(): VirtualWallet {
  if (wallet) return wallet;
  const local = new LocalVirtualWallet();
  local.ensureLoaded();
  wallet = local;
  return wallet;
}

export const VirtualEconomy = {
  changed: new Signal(),

  get wallet(): VirtualWallet {
    return ensure();
  },

  /** Replaces the local stand-in (the PlayFab economy bridge passes its account-backed wallet here). */
  setProvider(next: VirtualWallet): void {
    if (!next) throw new Error('wallet');
    wallet = next;
    VirtualEconomy.notify();
  },

  grant(grant: RewardGrant): void {
    const w = ensure();
    w.grant(grant);
    VirtualEconomy.notify();
    if (grant.kind === RewardKind.Coins && grant.amount > 0) PokerTelemetry.coinSource(grant.source, grant.amount, w.coins);
  },

  /** Local wallets always accept; the PlayFab wallet refuses a grant key already queued or settled. */
  tryGrant(grant: RewardGrant): boolean {
    const w = ensure();
    if (!w.tryGrant(grant)) return false;
    VirtualEconomy.notify();
    if (grant.kind === RewardKind.Coins && grant.amount > 0) PokerTelemetry.coinSource(grant.source, grant.amount, w.coins);
    return true;
  },

  /** Free-play buy-in with no server ledger: the local wallet spends coins; a PlayFab wallet adjusts FreePlayBank. */
  tryDebitFreePlay(chips: number): boolean {
    return VirtualEconomy.trySpendCoins(chips, 'buy_in');
  },

  /**
   * tryDebitFreePlay with the coin_sink named (web-port addition for callers the C# backend charged, e.g. an AFK
   * agent's bankroll — AgentDeployService.PostAgentStartAsync had the server take it). Same rules: the local wallet
   * spends coins; a PlayFab wallet moves this account's FreePlayBank delta. Return it with creditFreePlay.
   */
  trySpendCoins(chips: number, sink: string): boolean {
    const w = ensure();
    if (chips <= 0) return true;
    if (w instanceof LocalVirtualWallet) {
      if (!w.trySpendCoins(chips)) return false;
      VirtualEconomy.notify();
      PokerTelemetry.coinSink(sink, chips, w.coins);
      return true;
    }
    const ok = FreePlayBank.tryDebit(chips);
    if (ok) PokerTelemetry.coinSink(sink, chips, VirtualEconomy.wallet.coins);
    return ok;
  },

  /** Returns a free-play stack to the wallet after leave / cash-out (no ledger). */
  creditFreePlay(chips: number): void {
    const w = ensure();
    if (chips <= 0) return;
    if (w instanceof LocalVirtualWallet) {
      w.grant(RewardGrant.coins(chips, 'free_cashout'));
      // C# relies on the wallet; it does not Notify here. The web shell's readouts listen on 'wallet:changed',
      // so notify anyway — it changes no balance logic.
      VirtualEconomy.notify();
      return;
    }
    FreePlayBank.credit(chips);
  },

  tryConsumeStreakToken(): boolean {
    const w = ensure();
    if (!w.tryConsumeStreakToken()) return false;
    VirtualEconomy.notify();
    return true;
  },

  notify(): void {
    VirtualEconomy.changed.emit();
  },

  /** Test hook. */
  resetForTests(): void {
    wallet = null;
    FreePlayBank.resetForTests();
  },
};

// ---- FreePlayBank ------------------------------------------------------------------------------------

const PrefKey = 'Poker.FreePlay.BankDelta';
let accountKey: string | null = null;
let delta: number | null = null;

function setDelta(value: number): void {
  if (accountKey === null) {
    console.warn('[FreePlayBank] No account bound — free-play result not recorded.');
    return;
  }
  delta = value;
  PlayerPrefs.setString(accountKey, String(value));
  FreePlayBank.changed.emit();
  VirtualEconomy.notify();
}

export const FreePlayBank = {
  changed: new Signal(),

  /** Points the overlay at this account's own delta (null when signed out). Call on every sign-in. */
  bindAccount(accountId: string | null): void {
    const key = accountId ? `${PrefKey}.${accountId}` : null;
    if (key === accountKey) return;
    accountKey = key;
    delta = null;
    FreePlayBank.changed.emit();
    VirtualEconomy.notify();
  },

  get delta(): number {
    if (accountKey === null) return 0;
    delta ??= readLong(accountKey, 0);
    return delta;
  },

  tryDebit(chips: number): boolean {
    if (chips <= 0) return true;
    const available = VirtualEconomy.wallet.coins;
    if (available < chips) return false;
    setDelta(FreePlayBank.delta - chips);
    console.log(`[FreePlayBank] Debit ${chips.toLocaleString('en-US')} (delta ${FreePlayBank.delta.toLocaleString('en-US')}).`);
    return true;
  },

  credit(chips: number): void {
    if (chips <= 0) return;
    setDelta(FreePlayBank.delta + chips);
  },

  /** Clears the overlay after a real ledger session owns the balance. */
  clear(): void {
    if (FreePlayBank.delta === 0) return;
    setDelta(0);
  },

  resetForTests(): void {
    accountKey = null;
    delta = null;
  },
};
