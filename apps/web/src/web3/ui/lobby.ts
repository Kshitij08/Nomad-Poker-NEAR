/**
 * The private SOL tables lobby (Per/Unity/PerLobbyPanel.cs), as data and actions for the Redesign v2 Tables ›
 * Private tables tab (src/ui2/screens/play.ts): the tables listed by the private-tables backend, the tables this
 * wallet hosts ("Your tables": open / close / reclaim / invite links), and joining. Loaded lazily (it needs
 * @solana/web3.js). Joining navigates to the table screen.
 *
 * Statics map: PerWallet.Address → per.gameWallet.address, PerGameWallet/PerEntry/PerInvites/PerHostedTables/PerHost/
 * PerBuyIn → the PerRuntime members. A backend that isn't configured throws a clear Error from the service.
 */
import { PublicKey } from '@solana/web3.js';
import type { AppContext } from '../../app/app';
import { PerTableAddresses, perConfigAddress } from '../per/addresses';
import { Hosted, type Stakes } from '../per/entry';
import { PER_MIN_BUY_IN } from '../per/money';
import type { PerRuntime } from '../per/service';
import { decode } from '../per/types';
import type { Status } from '../per/gameWallet';
import { errMsg } from './perUi';

/** JSON numbers from the backend may arrive as numbers or strings (u64s); (ulong)t["x"] in the C#. */
export const u64 = (v: unknown): bigint => {
  try {
    return typeof v === 'bigint' ? v : BigInt(typeof v === 'number' ? Math.trunc(v) : String(v ?? '0').trim() || '0');
  } catch {
    return 0n;
  }
};
const int = (v: unknown): number => Number(v ?? 0) | 0;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Hosted tables read as gone once; a second read in a later refresh forgets them. */
const goneOnce = new Set<string>();

// ---- PerEntry's hosted-table helpers (Per/Unity/PerEntry.cs) the TS PerEntry leaves to the UI

/** PerEntry.NewInviteLink: a new link code for the table's private list (play key, no wallet prompt). */
export async function newInviteLink(per: PerRuntime, table: PublicKey, status: Status): Promise<void> {
  const key = await per.gameWallet.playKey(status);
  const code = per.host.newInviteCode();
  status('Making a new invite link (no wallet prompt)…');
  for (const ix of per.host.setInvitesKeyedSteps(new PerTableAddresses(table), key, null, per.host.inviteCodeHash(table, code)))
    await per.gameWallet.sendAsKey(key, ix);
  per.invites.setHostCode(table, code);
}

/** PerEntry.CloseHosted: closes an empty hosted table with the host's play key (no wallet transaction). */
export async function closeHosted(per: PerRuntime, table: PublicKey, status: Status): Promise<void> {
  const key = await per.gameWallet.playKey(status);
  const config = decode.config(await per.gameWallet.l1.getAccount(perConfigAddress(), 'confirmed'));
  if (!config) throw new Error("couldn't read the program's config");
  status('Closing the table (no wallet prompt)…');
  const hasVault = await per.gameWallet.hasVault(key, key.wallet);
  await per.gameWallet.sendAsKey(key, per.host.closeKeyed(new PerTableAddresses(table), key, new PublicKey(config.devWallet), hasVault));
  status('Closed. Its deposit can be taken back in a minute.');
}

/** PerEntry.OpenHosted: opens a table handed to the rollup but not opened yet (harmless if it's open already). */
export async function openHosted(per: PerRuntime, table: PublicKey, status: Status): Promise<void> {
  const key = await per.gameWallet.playKey(status);
  status('Opening the table (no wallet prompt)…');
  await per.gameWallet.sendAsKey(key, per.host.open(new PerTableAddresses(table), key.key.publicKey));
  status('Open. It appears in the list within a minute.');
}

/** Takes back a closed table's deposit (its rent) with one wallet approval; an old invite list's comes back too. */
export async function reclaimHosted(per: PerRuntime, table: PublicKey, id: bigint, status: Status): Promise<void> {
  status("Approve getting the table's deposit back in your wallet…");
  const gw = per.gameWallet;
  const wallet = gw.address!;
  const ixs = [per.host.reclaim(wallet, id)];
  // M9c: a table hosted before keeps an L1 invite list; its rent comes back too.
  if ((await gw.l1.getAccount(per.host.invitesAddress(table), 'confirmed')) !== null) ixs.push(per.host.closeInvites(wallet, id));
  await gw.l1.sendWithWallet(ixs, gw.signer);
  per.hostedTables.markGone(wallet, table);
}

/** Closes the Solana invite list of a table hosted before M9c (one wallet approval; its rent comes back). */
export async function closeOldInvites(per: PerRuntime, id: bigint, status: Status): Promise<void> {
  status("Approve closing the table's old invite list in your wallet…");
  const gw = per.gameWallet;
  await gw.l1.sendWithWallet([per.host.closeInvites(gw.address!, id)], gw.signer);
}

/** PerEntry.Join + the table scene: seat, then navigate. True once the table is opening. */
export async function joinAndGo(ctx: AppContext, per: PerRuntime, table: string | PublicKey, buyIn: bigint, status: Status, expect?: Stakes | null): Promise<boolean> {
  const params = await per.join(table, buyIn, status, expect);
  if (!params) return false;
  await ctx.router.navigate('table', params);
  return true;
}

// ---- the lobby's reads

/** A table in the lobby list this client can play (8 seats at most, a buy-in it can make). */
export interface LobbyTable {
  address: string;
  creator: string;
  smallBlind: bigint;
  bigBlind: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  /** The buy-in for Join (the lobby's buy-in choice, inside the table's limits). */
  buyIn: bigint;
  seated: number;
  maxSeats: number;
  inviteOnly: boolean;
  /** Hosted by this wallet. */
  mine: boolean;
  /** An invite link for it was opened in this browser. */
  haveLink: boolean;
}

/** One of "Your tables". */
export interface HostedRow {
  table: PublicKey;
  id: bigint;
  address: string;
  /**
   * old-list: gone, but its pre-M9c Solana invite list still holds a deposit · closed: its deposit can come back ·
   * open: in the lobby list · unlisted: open but the list hasn't caught up (join from here) · not-open: handed to the
   * rollup but not opened · pending: opening or closing.
   */
  state: 'old-list' | 'closed' | 'open' | 'unlisted' | 'not-open' | 'pending';
  seated: number;
  maxSeats: number;
  /** Invite links apply (invite-only, on the private list). */
  links: boolean;
  /** The table's invite link, when this browser made the current one. */
  link: string | null;
  /** For 'unlisted': the buy-in for Join. */
  buyIn: bigint;
  pending: string;
}

export interface LobbyRead {
  tables: LobbyTable[];
  hosted: HostedRow[];
  /** The table an invite link named, when it isn't open (base58). */
  linkedClosed: string | null;
}

/** Reads the lobby list and (with a wallet) "Your tables". Throws when the lobby can't be read. */
export async function readLobby(per: PerRuntime): Promise<LobbyRead> {
  const w = per.gameWallet.address;
  const live = await per.listTables();
  const mine = w ? await per.listTables(w.toBase58()) : [];
  const hosted = w ? await readHosted(per, w, live, mine) : [];
  const tables: LobbyTable[] = [];
  for (const t of live) {
    // This client draws its seats and buys in a fixed amount: list only tables it can play.
    if (int(t.maxSeats) > 8) continue;
    const min = u64(t.minBuyIn), max = u64(t.maxBuyIn);
    if ((min > PER_MIN_BUY_IN ? min : PER_MIN_BUY_IN) > max) continue;
    const address = str(t.address);
    const inviteOnly = t.inviteOnly === true;
    const isMine = w !== null && w.toBase58() === str(t.creator);
    let haveLink = false;
    try {
      haveLink = inviteOnly && !isMine && per.invites.joinCode(new PublicKey(address)) !== null;
    } catch {
      haveLink = false;
    }
    const bb = u64(t.bigBlind);
    tables.push({
      address, creator: str(t.creator), smallBlind: u64(t.smallBlind), bigBlind: bb, minBuyIn: min, maxBuyIn: max,
      buyIn: per.buyIn.for(min, max, bb), seated: int(t.seated), maxSeats: int(t.maxSeats), inviteOnly, mine: isMine, haveLink,
    });
  }
  const linked = per.invites.linkedTable;
  const linkedClosed = linked && !live.some((x) => str(x.address) === linked.toBase58()) ? linked.toBase58() : null;
  return { tables, hosted, linkedClosed };
}

/** "Your tables": hosted from this browser and (M9c) listed by the backend. Solana first: the list can lag. */
async function readHosted(per: PerRuntime, w: PublicKey, live: Record<string, unknown>[], mine: Record<string, unknown>[]): Promise<HostedRow[]> {
  const rows: HostedRow[] = [];
  const hosted = per.hostedTables.for(w);
  for (const m of mine.slice(0, 50)) {
    const idStr = str(m.tableId);
    if (!/^\d+$/.test(idStr)) continue;
    const mid = BigInt(idStr);
    let mk: PublicKey;
    try {
      mk = new PublicKey(str(m.address));
    } catch {
      continue;
    }
    // Only addresses this wallet's id really derives to (the backend is a hint, not an authority).
    if (!per.host.tableAddress(w, mid).equals(mk) || hosted.some((x) => x.table.equals(mk)) || per.hostedTables.isGone(w, mk)) continue;
    hosted.push({ table: mk, id: mid });
    per.hostedTables.add(w, mk, mid);
  }
  for (const { table, id } of hosted) {
    const key = table.toBase58();
    const row = live.find((x) => str(x.address) === key) ?? null;
    let state: Hosted;
    let oldList: boolean;
    let openLimits: { min: bigint; max: bigint; bigBlind: bigint } | null = null;
    try {
      state = await per.entry.hostedState(table);
      // A table hosted before M9c may have a Solana invite list (no invite links there; its rent comes back).
      oldList = (state === Hosted.Gone || (row !== null && row.inviteOnly === true)) && (await per.gameWallet.l1.getAccount(per.host.invitesAddress(table), 'confirmed')) !== null;
      // Not in the lobby list yet: ask the rollup (the list lags new tables by up to a minute).
      if (state === Hosted.Open && row === null) openLimits = await per.entry.openInRollup(table);
    } catch (e) {
      console.warn(`[PerLobby] ${key}: ${errMsg(e)}`);
      continue; // one bad read doesn't empty the lobby
    }
    const base: HostedRow = { table, id, address: key, state: 'pending', seated: 0, maxSeats: 0, links: false, link: null, buyIn: 0n, pending: '' };
    if (state === Hosted.Gone) {
      if (oldList) {
        rows.push({ ...base, state: 'old-list' });
        continue;
      }
      // Gone twice in a row: forget it (one read can lag; M9c review).
      if (goneOnce.has(key)) per.hostedTables.markGone(w, table);
      else goneOnce.add(key);
      continue;
    }
    goneOnce.delete(key);
    if (state === Hosted.Closed) rows.push({ ...base, state: 'closed' });
    else if (row !== null) {
      // Invite links need the private list (M9c); a table hosted before keeps its Solana list.
      const links = row.inviteOnly === true && !oldList;
      rows.push({ ...base, state: 'open', seated: int(row.seated), maxSeats: int(row.maxSeats), links, link: links ? inviteLinkOf(per, table) : null });
    } else if (state === Hosted.Open && openLimits) rows.push({ ...base, state: 'unlisted', buyIn: per.buyIn.for(openLimits.min, openLimits.max, openLimits.bigBlind) });
    else if (state === Hosted.Open) rows.push({ ...base, state: 'not-open' });
    else rows.push({ ...base, pending: state === Hosted.Closing ? 'Closing…' : 'Opening…' });
  }
  return rows;
}

/** The invite link this browser made for a table (null when another device made the current one). */
export function inviteLinkOf(per: PerRuntime, table: PublicKey): string | null {
  const code = per.invites.hostCode(table);
  return code ? per.invites.link(table, code) : null;
}
