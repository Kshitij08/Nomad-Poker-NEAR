/**
 * Port of Economy/PlayFabWallet.cs: the client's READ-ONLY cache of its own Economy v2 chip balance (players get
 * NotAuthorizedByTitle on inventory writes). A player with no chips stack at all has never been welcomed and is
 * shown PlayFabConfig.StartingBalance until the ledger / grantStartingChips pays it.
 */
import { PlayerPrefs } from '../../app/services';
import { PlayFabConfig } from '../config';
import { Signal } from '../signal';
import { errorReport } from './client';
import { isClientLoggedIn, playFab } from './runtime';

const AtTablePref = 'Poker.Wallet.AtTable';
const CashOutFollowDelaysMs = [4000, 6000, 10000, 20000, 30000, 60000];

let balance = -1;
let inFlight: Promise<number> | null = null;
let currencyId: string | null = null;
let atTableMarks = 0;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function set(value: number): void {
  if (balance === value) return;
  balance = value;
  PlayFabWallet.balanceChanged.emit(value);
}

async function currencyIdAsync(): Promise<string | null> {
  if (currencyId !== null) return currencyId;
  const res = await playFab()!.entity<{ Item?: { Id?: string } }>('Catalog/GetItem', {
    AlternateId: { Type: 'FriendlyId', Value: PlayFabConfig.CurrencyCode },
  });
  if (res.error) {
    console.warn(`[PlayFabWallet] Currency '${PlayFabConfig.CurrencyCode}' lookup failed: ${errorReport(res.error)}`);
    return null;
  }
  const id = res.data.Item?.Id;
  if (id) currencyId = id;
  return currencyId;
}

async function readAsync(): Promise<number> {
  try {
    if (!isClientLoggedIn()) {
      console.warn('[PlayFabWallet] Refresh before sign-in — ignoring.');
      return balance;
    }
    const itemId = await currencyIdAsync();
    if (itemId === null) return balance;
    const res = await playFab()!.entity<{ Items?: { Id?: string; Amount?: number }[] }>('Inventory/GetInventoryItems', {
      Count: 10, Filter: `id eq '${itemId}'`,
    });
    if (res.error) {
      console.warn(`[PlayFabWallet] Balance read failed: ${errorReport(res.error)}`);
      return balance;
    }
    let value = 0;
    let hasStack = false;
    for (const item of res.data.Items ?? []) {
      if (!item || item.Id !== itemId) continue;
      hasStack = true;
      value += item.Amount ?? 0;
    }
    const read = hasStack ? value : PlayFabConfig.StartingBalance;
    set(read);
    return read;
  } catch (e) {
    console.warn('[PlayFabWallet] Balance read skipped', e);
    return balance;
  } finally {
    inFlight = null;
  }
}

export const PlayFabWallet = {
  /** Raised whenever Balance changes (-1 on clear). */
  balanceChanged: new Signal<number>(),

  /** Last known balance; -1 until the first successful read. */
  get balance(): number {
    return balance;
  },
  get hasBalance(): boolean {
    return balance >= 0;
  },

  /** Re-reads the balance. Concurrent callers share one request; never throws (keeps the last value). */
  refreshAsync(): Promise<number> {
    if (inFlight) return inFlight;
    inFlight = readAsync();
    return inFlight;
  },

  /** Adopts a balance the server already told us about (buy-in / cash-out / grant result). */
  adopt(value: number): void {
    if (value < 0) return;
    set(value);
  },

  /** Remembers across a reload that this account has chips at a table (see FollowTableCashOutAsync). */
  markAtTable(playFabId: string): void {
    if (!playFabId) return;
    atTableMarks++;
    if (PlayerPrefs.getString(AtTablePref, '') === playFabId) return;
    PlayerPrefs.setString(AtTablePref, playFabId);
  },

  clearAtTable(): void {
    if (!PlayerPrefs.hasKey(AtTablePref)) return;
    PlayerPrefs.deleteKey(AtTablePref);
  },

  /** After sign-in: keep re-reading until a table refund lands (a reload left without seeing the cash-out). */
  async followTableCashOutAsync(playFabId: string): Promise<void> {
    if (!playFabId || PlayerPrefs.getString(AtTablePref, '') !== playFabId) return;
    const marks = atTableMarks;
    const before = balance;
    for (const ms of CashOutFollowDelaysMs) {
      await delay(ms);
      if (atTableMarks !== marks) return;
      if ((await PlayFabWallet.refreshAsync()) > before) break;
    }
    if (atTableMarks === marks) PlayFabWallet.clearAtTable();
  },

  /** Forgets the cached balance (sign-out: the next player must not see the last one's chips). */
  clear(): void {
    balance = -1;
    PlayFabWallet.balanceChanged.emit(-1);
  },

  resetForTests(): void {
    balance = -1;
    inFlight = null;
    currencyId = null;
    atTableMarks = 0;
  },
};
