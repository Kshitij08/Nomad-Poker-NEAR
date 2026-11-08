/**
 * Port of Social/FriendInvites.cs: inviting a friend to your table and answering invites. Delivery is a mailbox:
 * friends.js `sendInvite` writes into the invitee's READ-ONLY data, polled from the menu.
 *
 * Fusion is not in this module: the net module tells it which table this client sits at (setCurrentTable) and
 * performs the join (joinHandler). Accepting with no handler says "Go back to the main menu to join." like the C#
 * does without a menu controller.
 */
import { FriendCode } from '@nomad/engine/social/friendCode';
import { FriendInviteRules, FriendRelation } from '@nomad/engine/social/friendRules';
import { PokerClientIdentity } from '../identity';
import { errorReport } from '../playfab/client';
import { isClientLoggedIn, playFab } from '../playfab/runtime';
import { Signal } from '../signal';
import { FriendsResult, PlayFabFriends, type FriendEntry } from './playFabFriends';

/** An invite to someone's table, as the invitee sees it. */
export interface FriendInvite {
  fromId: string;
  fromName: string | null;
  session: string;
  money: boolean;
  sentAtUnix: number;
}

export const inviteLabel = (i: FriendInvite): string => (i.fromName && i.fromName.trim() ? i.fromName : FriendCode.format(i.fromId));
const inviteKey = (i: FriendInvite): string => `${i.fromId}|${i.sentAtUnix}`;

/** The table this client is at (the live Fusion runner's session in Unity). */
export interface CurrentTable {
  session: string;
  money: boolean;
}

/** The invitee's read-only data key. Must match INVITES_KEY in friends.js. */
export const InvitesDataKey = 'Poker.Social.Invites';

const pending: FriendInvite[] = [];
const answered = new Set<string>();
let serverOffsetMs: number | null = null;
let polling = false;
let currentTable: CurrentTable | null = null;

function parse(json: string): FriendInvite[] {
  const invites: FriendInvite[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    console.warn('[Invites] Unreadable mailbox', e);
    return invites;
  }
  if (!Array.isArray(parsed)) return invites;
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    const at = typeof e.at === 'number' ? Math.trunc(e.at) : typeof e.at === 'string' && /^\d+$/.test(e.at) ? Number(e.at) : 0;
    const invite: FriendInvite = {
      fromId: typeof e.from === 'string' ? e.from : '',
      fromName: typeof e.name === 'string' ? e.name : null,
      session: typeof e.session === 'string' ? e.session : '',
      money: e.money === true,
      sentAtUnix: at,
    };
    if (!invite.fromId || !invite.session) continue;
    invites.push(invite);
  }
  return invites;
}

function sameInvites(a: FriendInvite[], b: FriendInvite[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (inviteKey(a[i]!) !== inviteKey(b[i]!) || a[i]!.session !== b[i]!.session) return false;
  return true;
}

function forget(invite: FriendInvite): void {
  answered.add(inviteKey(invite));
  const i = pending.indexOf(invite);
  if (i >= 0) {
    pending.splice(i, 1);
    FriendInvites.changed.emit();
  }
  void PlayFabFriends.callAsync('dismissInvite', { fromId: invite.fromId });
}

export const FriendInvites = {
  changed: new Signal(),
  /** Raised when the current table changes (sitting down enables Invite; standing up shows waiting invites). */
  tableChanged: new Signal(),

  /** Joins an invite's table; resolves null once under way, or the reason it could not start. Set by the net module. */
  joinHandler: null as ((invite: FriendInvite) => Promise<string | null>) | null,

  get inbox(): readonly FriendInvite[] {
    return pending;
  },
  get currentTable(): CurrentTable | null {
    return currentTable;
  },
  setCurrentTable(table: CurrentTable | null): void {
    const same = (table?.session ?? null) === (currentTable?.session ?? null) && (table?.money ?? false) === (currentTable?.money ?? false);
    currentTable = table ? { ...table } : null;
    if (!same) FriendInvites.tableChanged.emit();
  },

  clear(): void {
    pending.length = 0;
    answered.clear();
    serverOffsetMs = null;
    FriendInvites.changed.emit();
  },

  /** Invites a friend to the table this player is at. Only possible from a table. */
  inviteAsync(friend: FriendEntry | null): Promise<FriendsResult> {
    if (!friend || friend.relation !== FriendRelation.Friend) return Promise.resolve(FriendsResult.fail('You can only invite friends.'));
    const table = currentTable;
    if (!table) return Promise.resolve(FriendsResult.fail('Join or create a table to invite friends.'));
    return PlayFabFriends.callAsync('sendInvite', { friendId: friend.id, session: table.session, money: table.money });
  },

  /** Checks the mailbox (one read of one key; safe on a timer). */
  async pollAsync(): Promise<void> {
    if (polling || !isClientLoggedIn()) return;
    polling = true;
    try {
      if (serverOffsetMs === null) {
        const t = await playFab()!.client<{ Time?: string }>('GetTime', {});
        if (t.error) console.warn(`[Invites] GetTime failed, using the local clock: ${errorReport(t.error)}`);
        else if (t.data.Time) serverOffsetMs = Date.parse(t.data.Time.endsWith('Z') ? t.data.Time : t.data.Time + 'Z') - Date.now();
      }
      const r = await playFab()!.client<{ Data?: Record<string, { Value?: string }> }>('GetUserReadOnlyData', { Keys: [InvitesDataKey] });
      if (r.error) {
        console.warn(`[Invites] Mailbox read failed: ${errorReport(r.error)}`);
        return;
      }
      const json = r.data.Data?.[InvitesDataKey]?.Value ?? '[]';
      const now = Math.floor((Date.now() + (serverOffsetMs ?? 0)) / 1000);
      const fresh = parse(json).filter(
        (inv) => inv.fromId !== PokerClientIdentity.playFabId && !answered.has(inviteKey(inv)) && FriendInviteRules.isLive(inv.sentAtUnix, now),
      );
      fresh.sort((a, b) => b.sentAtUnix - a.sentAtUnix);
      if (sameInvites(fresh, pending)) return;
      pending.length = 0;
      pending.push(...fresh);
      FriendInvites.changed.emit();
    } catch (e) {
      console.error('[Invites] Poll threw', e);
    } finally {
      polling = false;
    }
  },

  /** Joins the inviting friend's table. Null once the join is under way, or why it could not start. */
  async acceptAsync(invite: FriendInvite | null): Promise<string | null> {
    if (!invite) return 'That invite has expired.';
    if (currentTable) return 'Leave this table first, then accept.';
    if (invite.money && !PokerClientIdentity.isLoggedIn) return "That's a real-money table. Connect your wallet, then accept again.";
    const join = FriendInvites.joinHandler;
    if (!join) return 'Go back to the main menu to join.';
    forget(invite);
    return join(invite);
  },

  /** Turns an invite down. Nothing is sent to the inviter — it simply goes away. */
  decline(invite: FriendInvite | null): void {
    if (invite) forget(invite);
  },

  resetForTests(): void {
    pending.length = 0;
    answered.clear();
    serverOffsetMs = null;
    polling = false;
    currentTable = null;
    FriendInvites.joinHandler = null;
  },
};
