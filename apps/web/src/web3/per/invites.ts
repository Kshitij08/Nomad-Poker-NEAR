/**
 * M9c: invite links for invite-only tables. Port of Per/Unity/PerInvites.cs. The host's browser keeps each table's
 * secret code (so it can copy the link again); the program keeps only its hash, in the table's private invite list.
 * A player who opens a link has the code stored for that table, and the lobby opens by itself.
 *   https://<game>/#table=<address>&invite=<32 hex chars>
 * The code sits after "#", which browsers never send to a server (M10 review L5). "?table=…&invite=…" links still work.
 */
import { PublicKey } from '@solana/web3.js';
import { PlayerPrefs } from '../../app/services';
import { hex } from '../lib/bytes';

const hostPref = (table: PublicKey) => `per.invite.host.${table.toBase58()}`;
const joinPref = (table: PublicKey) => `per.invite.join.${table.toBase58()}`;

/** 32 hex chars → 16 bytes, anything else → null (PerInvites.Hex). */
function fromHex32(s: string | null | undefined): Uint8Array | null {
  if (!s || s.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(s)) return null;
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return b;
}

const pageUrl = (): string => (typeof location !== 'undefined' ? location.href : '');

/** PerUrl_StripInvite (PerPrompt.jslib): drops table/invite from the address bar. */
function stripFromAddressBar(): void {
  try {
    if (typeof location === 'undefined' || typeof history === 'undefined') return;
    const u = new URL(location.href);
    u.searchParams.delete('invite');
    u.searchParams.delete('table');
    const hash = /(^|[#&])(table|invite)=/.test(u.hash) ? '' : u.hash;
    history.replaceState(history.state, '', u.pathname + u.search + hash);
  } catch {
    /* ignore */
  }
}

let read = false;
let linkedTable: PublicKey | null = null;

export const PerInvites = {
  /** The code of the link this browser made for its own table, or null. */
  hostCode: (table: PublicKey): Uint8Array | null => fromHex32(PlayerPrefs.getString(hostPref(table), '')),
  setHostCode(table: PublicKey, code: Uint8Array): void {
    PlayerPrefs.setString(hostPref(table), hex(code));
  },

  /** Drops the codes kept for a table that's gone. */
  forget(table: PublicKey): void {
    PlayerPrefs.deleteKey(hostPref(table));
    PlayerPrefs.deleteKey(joinPref(table));
  },

  /** The code from an invite link this browser opened for `table`, or null. */
  joinCode: (table: PublicKey): Uint8Array | null => fromHex32(PlayerPrefs.getString(joinPref(table), '')),

  /** The table of the invite link the page was opened with, if any (set by readLinkOnce). */
  get linkedTable(): PublicKey | null {
    return linkedTable;
  },

  /**
   * Reads table=/invite= from the page's address (query or fragment) once and remembers the code. True if the page
   * was opened with an invite link (the menu then opens the lobby). `url` defaults to the page's address.
   */
  readLinkOnce(url: string = pageUrl()): boolean {
    if (read) return false;
    read = true;
    const t = /[?&#]table=([1-9A-HJ-NP-Za-km-z]{32,44})(&|#|$)/.exec(url ?? '');
    const c = /[?&#]invite=([0-9a-f]{32})(&|#|$)/.exec(url ?? '');
    if (!t || !c) return false;
    try {
      const table = new PublicKey(t[1]!);
      PlayerPrefs.setString(joinPref(table), c[1]!);
      linkedTable = table;
      stripFromAddressBar();
      console.log(`[PerInvites] opened with an invite link to ${table.toBase58()}`);
      return true;
    } catch {
      return false;
    }
  },

  /** The invite link for `table` with `code`, on the page the game runs on. */
  link(table: PublicKey, code: Uint8Array, page: string = pageUrl()): string {
    const cut = page.search(/[?#]/);
    if (cut >= 0) page = page.slice(0, cut);
    return `${page}#table=${table.toBase58()}&invite=${hex(code)}`;
  },

  /** Tests: forget that the link was read. */
  resetForTests(): void {
    read = false;
    linkedTable = null;
  },
};
