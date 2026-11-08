/**
 * Inviting a friend to your table and answering invites (was Social/FriendInvites.cs over a PlayFab read-only-data
 * mailbox). The Nomad server keeps the inbox: it arrives with every GET /v1/social, so polling the friends list polls
 * invites too. Ages use the server's clock.
 *
 * The net module tells this module which table this client sits at (setCurrentTable) and performs the join
 * (joinHandler). Accepting with no handler says "Go back to the main menu to join."
 */
import { FriendCode } from '@nomad/engine/social/friendCode';
import { FriendInviteRules, FriendRelation } from '@nomad/engine/social/friendRules';
import { SocialRoutes, type SocialResponse } from '@nomad/contract';
import { PokerClientIdentity } from '../identity';
import { Signal } from '../signal';
import { Friends, FriendsResult, type FriendEntry } from './friends';

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

/** The table this client is at. */
export interface CurrentTable {
  session: string;
  money: boolean;
}

const pending: FriendInvite[] = [];
const answered = new Set<string>();
let currentTable: CurrentTable | null = null;

function sameInvites(a: FriendInvite[], b: FriendInvite[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (inviteKey(a[i]!) !== inviteKey(b[i]!) || a[i]!.session !== b[i]!.session) return false;
  return true;
}

function adopt(s: SocialResponse): void {
  const fresh = s.invites
    .map((i): FriendInvite => ({ fromId: i.fromId, fromName: i.fromName, session: i.session, money: i.money, sentAtUnix: i.sentAtUnix }))
    .filter((inv) => !answered.has(inviteKey(inv)) && FriendInviteRules.isLive(inv.sentAtUnix, s.serverTime));
  fresh.sort((a, b) => b.sentAtUnix - a.sentAtUnix);
  if (sameInvites(fresh, pending)) return;
  pending.length = 0;
  pending.push(...fresh);
  FriendInvites.changed.emit();
}
Friends.onSocial(adopt);

function forget(invite: FriendInvite): void {
  answered.add(inviteKey(invite));
  const i = pending.indexOf(invite);
  if (i >= 0) {
    pending.splice(i, 1);
    FriendInvites.changed.emit();
  }
  void Friends.callAsync(SocialRoutes.dismiss, { fromId: invite.fromId });
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
    FriendInvites.changed.emit();
  },

  /** Invites a friend to the table this player is at. Only possible from a table. */
  inviteAsync(friend: FriendEntry | null): Promise<FriendsResult> {
    if (!friend || friend.relation !== FriendRelation.Friend) return Promise.resolve(FriendsResult.fail('You can only invite friends.'));
    const table = currentTable;
    if (!table) return Promise.resolve(FriendsResult.fail('Join or create a table to invite friends.'));
    return Friends.callAsync(SocialRoutes.invite, { friendId: friend.id, session: table.session, money: table.money });
  },

  /** Checks the inbox (it comes with the friends list). Safe on a timer. */
  async pollAsync(): Promise<void> {
    await Friends.refreshAsync();
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
    currentTable = null;
    FriendInvites.joinHandler = null;
  },
};
