/**
 * Ports of Core/Social/FriendInviteRules.cs, FriendLastSeen.cs and FriendRelation.cs (FriendRelation + FriendTags).
 */

// ---- FriendInviteRules ------------------------------------------------------------------------------

/**
 * How long a table invite stays answerable. The server prunes on the same clock (INVITE_TTL_SECONDS in
 * playfab/cloudscript/friends.js).
 */
export const FriendInviteRules = {
  TtlSeconds: 600,
  /** Slack for an invite stamped slightly "in the future" (server-time offset measured once). */
  SkewSeconds: 30,

  /** Both arguments are server time in unix seconds. */
  isLive(sentAtUnix: number, nowUnix: number): boolean {
    if (sentAtUnix <= 0) return false;
    const age = nowUnix - sentAtUnix;
    return age < FriendInviteRules.TtlSeconds && age >= -FriendInviteRules.SkewSeconds;
  },
};

// ---- FriendLastSeen ---------------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Seen 3h ago" from a friend's last LOGIN (never claims "online"). Times are epoch milliseconds (UTC). */
export const FriendLastSeen = {
  describe(lastLoginUtc: number | null | undefined, nowUtc: number): string {
    if (lastLoginUtc == null) return '';
    const ago = nowUtc - lastLoginUtc;
    // C# (int)TimeSpan.TotalX truncates toward zero.
    if (ago < MINUTE) return 'Seen just now';
    if (ago < HOUR) return `Seen ${Math.trunc(ago / MINUTE)}m ago`;
    if (ago < DAY) return `Seen ${Math.trunc(ago / HOUR)}h ago`;
    if (ago < 30 * DAY) return `Seen ${Math.trunc(ago / DAY)}d ago`;
    return 'Seen over a month ago';
  },
};

// ---- FriendRelation / FriendTags ---------------------------------------------------------------------

/** Where a friendship stands, from this player's side. */
export enum FriendRelation {
  /** An entry with no tag we recognise — added by hand in Game Manager, or half-written. */
  None = 0,
  Friend = 1,
  /** They asked; we have not answered. */
  IncomingRequest = 2,
  /** We asked; they have not answered. */
  OutgoingRequest = 3,
}

/** The PlayFab friend-list tags a friendship is stored as (the contract with friends.js). */
export const FriendTags = {
  Friend: 'friend',
  PendingIn: 'pending_in',
  PendingOut: 'pending_out',

  /** "Friend" wins over a pending tag, so a raced entry reads as the settled state. */
  fromTags(tags: readonly string[] | null | undefined): FriendRelation {
    if (!tags || tags.length === 0) return FriendRelation.None;
    if (tags.includes(FriendTags.Friend)) return FriendRelation.Friend;
    if (tags.includes(FriendTags.PendingIn)) return FriendRelation.IncomingRequest;
    if (tags.includes(FriendTags.PendingOut)) return FriendRelation.OutgoingRequest;
    return FriendRelation.None;
  },
};
