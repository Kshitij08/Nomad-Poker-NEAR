/**
 * The tables this browser hosted, per wallet: "address:id" entries. Port of PerHostedTables
 * (Per/Unity/PerHostPanel.cs); PlayerPrefs keys as the C#.
 */
import { PublicKey } from '@solana/web3.js';
import { PlayerPrefs } from '../../app/services';
import { PerInvites } from './invites';

export interface HostedTable {
  table: PublicKey;
  id: bigint;
}

const pref = (wallet: PublicKey) => `per.hosted.${wallet.toBase58()}`;
/** M9c: tables found reclaimed (gone from Solana). The backend keeps listing them, so they're remembered here. */
const gonePref = (wallet: PublicKey) => `per.hosted.gone.${wallet.toBase58()}`;
const U64_MAX = (1n << 64n) - 1n;

function save(wallet: PublicKey, l: HostedTable[]): void {
  PlayerPrefs.setString(pref(wallet), l.map((x) => `${x.table.toBase58()}:${x.id}`).join(','));
}

export const PerHostedTables = {
  for(wallet: PublicKey): HostedTable[] {
    const list: HostedTable[] = [];
    for (const e of PlayerPrefs.getString(pref(wallet), '').split(',')) {
      const parts = e.split(':');
      if (parts.length !== 2 || !/^\d+$/.test(parts[1]!.trim())) continue;
      const id = BigInt(parts[1]!.trim());
      if (id > U64_MAX) continue;
      try {
        list.push({ table: new PublicKey(parts[0]!), id });
      } catch {
        /* a damaged entry is skipped, not fatal */
      }
    }
    return list;
  },

  add(wallet: PublicKey, table: PublicKey, id: bigint): void {
    const l = PerHostedTables.for(wallet).filter((x) => !x.table.equals(table));
    l.push({ table, id });
    save(wallet, l);
  },

  remove(wallet: PublicKey, table: PublicKey): void {
    save(wallet, PerHostedTables.for(wallet).filter((x) => !x.table.equals(table)));
  },

  isGone: (wallet: PublicKey, table: PublicKey): boolean => PlayerPrefs.getString(gonePref(wallet), '').split(',').includes(table.toBase58()),

  markGone(wallet: PublicKey, table: PublicKey): void {
    PerHostedTables.remove(wallet, table);
    PerInvites.forget(table);
    if (PerHostedTables.isGone(wallet, table)) return;
    const list = PlayerPrefs.getString(gonePref(wallet), '').split(',').filter((s) => s.length > 0);
    list.push(table.toBase58());
    if (list.length > 200) list.splice(0, list.length - 200);
    PlayerPrefs.setString(gonePref(wallet), list.join(','));
  },
};
