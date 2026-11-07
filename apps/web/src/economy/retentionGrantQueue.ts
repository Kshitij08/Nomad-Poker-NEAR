/**
 * Port of Economy/RetentionGrantQueue.cs: the client-side queue of coin grants waiting to be paid by the
 * `claimRetentionGrant` CloudScript. Same PlayerPrefs keys and the same row encoding
 * (`Uri.EscapeDataString(key)|chips|Uri.EscapeDataString(reason)` joined by ';').
 */
import { PlayerPrefs } from '../app/services';

const PrefsKey = 'Poker.Retention.PendingGrants';
const SettledPrefsKey = 'Poker.Retention.SettledGrants';
const MaxEntries = 32;
const MaxSettled = 64;

export interface GrantEntry {
  readonly key: string;
  readonly chips: number;
  readonly reason: string;
}

/** .NET Uri.EscapeDataString (RFC 3986: everything but A-Z a-z 0-9 - _ . ~ is escaped). */
export function escapeDataString(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
export function unescapeDataString(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function load(): GrantEntry[] {
  const result: GrantEntry[] = [];
  const raw = PlayerPrefs.getString(PrefsKey, '');
  if (!raw) return result;
  for (const row of raw.split(';')) {
    if (!row) continue;
    const parts = row.split('|');
    if (parts.length < 3) continue;
    if (!/^[+-]?\d+$/.test(parts[1]!.trim())) continue;
    result.push({ key: unescapeDataString(parts[0]!), chips: Number(parts[1]), reason: unescapeDataString(parts[2]!) });
  }
  return result;
}

function save(list: GrantEntry[]): void {
  PlayerPrefs.setString(PrefsKey, list.map((e) => `${escapeDataString(e.key)}|${e.chips}|${escapeDataString(e.reason)}`).join(';'));
}

function loadSettled(): string[] {
  const raw = PlayerPrefs.getString(SettledPrefsKey, '');
  if (!raw) return [];
  return raw.split(';').filter((r) => r.length > 0).map(unescapeDataString);
}

/** The PlayFabId is the key's second ':'-separated field (`source:PlayFabId:day:...`). */
function belongsToAccount(key: string, playFabId: string): boolean {
  if (!key || !playFabId) return false;
  const first = key.indexOf(':');
  if (first < 0) return false;
  const second = key.indexOf(':', first + 1);
  if (second < 0) return false;
  return key.substring(first + 1, second) === playFabId;
}

export const RetentionGrantQueue = {
  /** DailySpinCatalog jackpot. */
  MaxSingleGrant: 25000,

  snapshot(): readonly GrantEntry[] {
    return load();
  },

  snapshotForAccount(playFabId: string | null): readonly GrantEntry[] {
    const all = load();
    if (!playFabId) return all;
    return all.filter((e) => belongsToAccount(e.key, playFabId));
  },

  /** Coins earned locally but not yet acknowledged by the ledger (shown on the HUD meanwhile). */
  pendingCoinsFor(playFabId: string | null): number {
    let total = 0;
    for (const e of RetentionGrantQueue.snapshotForAccount(playFabId)) total += e.chips;
    return total;
  },

  contains(key: string | null): boolean {
    if (!key) return false;
    return load().some((e) => e.key === key);
  },

  /** False when this idempotency key was already queued, paid, or refused for good. */
  tryEnqueue(key: string | null, chips: number, reason: string | null): boolean {
    if (!key || chips <= 0 || chips > RetentionGrantQueue.MaxSingleGrant) return false;
    if (RetentionGrantQueue.isSettled(key)) return false;
    const list = load();
    if (list.some((e) => e.key === key)) return false;
    list.push({ key, chips, reason: reason ?? '' });
    while (list.length > MaxEntries) list.shift();
    save(list);
    return true;
  },

  remove(key: string | null): void {
    if (!key) return;
    const list = load();
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.key !== key) continue;
      list.splice(i, 1);
      save(list);
      return;
    }
  },

  /** Paid or refused for good: off the queue and remembered, so tryEnqueue refuses it from now on. */
  settle(key: string | null): void {
    if (!key) return;
    RetentionGrantQueue.remove(key);
    const settled = loadSettled();
    if (settled.includes(key)) return;
    settled.push(key);
    while (settled.length > MaxSettled) settled.shift();
    PlayerPrefs.setString(SettledPrefsKey, settled.map(escapeDataString).join(';'));
  },

  isSettled(key: string | null): boolean {
    return !!key && loadSettled().includes(key);
  },

  clear(): void {
    PlayerPrefs.deleteKey(PrefsKey);
    PlayerPrefs.deleteKey(SettledPrefsKey);
  },
};
