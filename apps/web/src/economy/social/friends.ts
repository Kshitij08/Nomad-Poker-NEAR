/**
 * The friends list on the Nomad server (was Social/PlayFabFriends.cs over the friends.js CloudScript). Reading is
 * GET /v1/social (friends, presence and the invite inbox in one call); every change is a POST the server applies to
 * both sides. Never throws; every failure is a sentence fit to show the player.
 */
import { FriendCode } from '@nomad/engine/social/friendCode';
import { FriendRelation, FriendTags } from '@nomad/engine/social/friendRules';
import { SocialRoutes, type SocialActionResult, type SocialResponse } from '@nomad/contract';
import { NomadLink } from '../nomadLink';
import { Signal } from '../signal';

/** One row of the friends list, from this player's side. */
export interface FriendEntry {
  /** Their Friend ID (16 hex characters). */
  id: string;
  name: string | null;
  relation: FriendRelation;
  /** Last activity, epoch ms (UTC); null when unknown. */
  lastLogin: number | null;
  /** AvatarCatalog value; 0 (None) when unknown or not shared. */
  avatar: number;
  /** Active in the last couple of minutes. */
  online?: boolean;
  /** The table (session) a friend is seated at. */
  table?: string | null;
}

/** The display name, or the Friend ID for a player who never set one. */
export const friendLabel = (f: { id: string; name: string | null }): string => (f.name && f.name.trim() ? f.name : FriendCode.format(f.id));

export interface FriendsResult {
  readonly success: boolean;
  readonly error: string | null;
  /** The relation the server reports on success ("friend", "pending_out"…). */
  readonly relation: string | null;
}
export const FriendsResult = {
  ok: (relation: string | null = null): FriendsResult => ({ success: true, error: null, relation }),
  fail: (error: string): FriendsResult => ({ success: false, error, relation: null }),
};

/** Player-facing text for a server error code (friends.js's codes, plus name lookups). */
export function explainFriends(code: string | null, input = ''): string {
  switch (code) {
    case 'invalid_id': return "That Friend ID doesn't look right.";
    case 'self': return "That's your own Friend ID.";
    case 'not_found': return 'No player has that Friend ID.';
    case 'not_found_name': return `No player called '${input.trim()}'. Ask for their Friend ID instead.`;
    case 'ambiguous_name': return `More than one player is called '${input.trim()}'. Ask for their Friend ID instead.`;
    case 'already_friends': return "You're already friends.";
    case 'already_requested': return 'Request already sent — waiting for them to accept.';
    case 'no_request': return "That request isn't there any more.";
    case 'not_friends': return 'You can only invite friends.';
    case 'invalid_session': return "This table can't be shared.";
    case 'offline': return 'Friends need the Nomad server, which this build does not use.';
    default: return "Couldn't reach the server. Check your connection and try again.";
  }
}

const RELATION: Record<string, FriendRelation> = {
  [FriendTags.Friend]: FriendRelation.Friend,
  [FriendTags.PendingIn]: FriendRelation.IncomingRequest,
  [FriendTags.PendingOut]: FriendRelation.OutgoingRequest,
};

const entries: FriendEntry[] = [];
let refreshInFlight: Promise<FriendsResult> | null = null;
let hasLoaded = false;
let lastError: string | null = null;
/** Who else wants each /v1/social answer (the invite inbox rides along). */
const socialListeners = new Set<(s: SocialResponse) => void>();

async function refreshOnceAsync(): Promise<FriendsResult> {
  try {
    const s = await NomadLink.call<SocialResponse>('GET', SocialRoutes.social);
    entries.length = 0;
    for (const f of s.friends) {
      entries.push({ id: f.id, name: f.name, relation: RELATION[f.relation] ?? FriendRelation.None, lastLogin: f.lastSeen, avatar: f.avatar, online: f.online, table: f.table });
    }
    hasLoaded = true;
    lastError = null;
    for (const fn of socialListeners) fn(s);
    Friends.changed.emit();
    return FriendsResult.ok();
  } catch (e) {
    console.warn('[Friends] Refresh failed', e);
    lastError = "Couldn't load your friends. Check your connection.";
    Friends.changed.emit();
    return FriendsResult.fail(lastError);
  }
}

export const Friends = {
  changed: new Signal(),

  /** A Nomad account is signed in, so friends work. */
  get available(): boolean {
    return NomadLink.signedIn;
  },
  get all(): readonly FriendEntry[] {
    return entries;
  },
  get hasLoaded(): boolean {
    return hasLoaded;
  },
  get lastError(): string | null {
    return lastError;
  },
  /** Requests waiting on this player — what the Friends badge counts. */
  get incomingCount(): number {
    return entries.filter((e) => e.relation === FriendRelation.IncomingRequest).length;
  },

  find(friendId: string): FriendEntry | null {
    return entries.find((e) => e.id === friendId) ?? null;
  },

  /** Subscribe to every /v1/social answer (the invites module reads its inbox from it). */
  onSocial(fn: (s: SocialResponse) => void): () => void {
    socialListeners.add(fn);
    return () => socialListeners.delete(fn);
  },

  /** Forgets the list — on sign-out, or when a different account signs in. */
  clear(): void {
    entries.length = 0;
    hasLoaded = false;
    lastError = null;
    Friends.changed.emit();
  },

  /** Reloads the list (and the inbox); overlapping callers share one request. */
  async refreshAsync(): Promise<FriendsResult> {
    if (!NomadLink.signedIn) return FriendsResult.fail(NomadLink.configured ? 'Sign in first.' : explainFriends('offline'));
    if (refreshInFlight) return refreshInFlight;
    const task = refreshOnceAsync();
    refreshInFlight = task;
    try {
      return await task;
    } finally {
      if (refreshInFlight === task) refreshInFlight = null;
    }
  },

  /** Sends a request to a Friend ID or an exact display name (asking back = accepting, server-side). */
  async sendRequestAsync(idOrName: string | null): Promise<FriendsResult> {
    if (!idOrName || !idOrName.trim()) return FriendsResult.fail('Enter a Friend ID or player name.');
    const sent = await Friends.callAsync(SocialRoutes.request, { idOrName: idOrName.trim() }, idOrName);
    if (sent.success) await Friends.refreshAsync();
    return sent;
  },

  async acceptAsync(friendId: string): Promise<FriendsResult> {
    const result = await Friends.callAsync(SocialRoutes.accept, { friendId });
    await Friends.refreshAsync();
    return result;
  },

  /** Decline, cancel and unfriend are all this: the pair comes off both lists. */
  async removeAsync(friendId: string): Promise<FriendsResult> {
    const result = await Friends.callAsync(SocialRoutes.remove, { friendId });
    await Friends.refreshAsync();
    return result;
  },

  /** One social action on the server. */
  async callAsync(path: string, body: Record<string, unknown>, input = ''): Promise<FriendsResult> {
    if (!NomadLink.signedIn) return FriendsResult.fail(NomadLink.configured ? 'Sign in first.' : explainFriends('offline'));
    try {
      const r = await NomadLink.call<SocialActionResult>('POST', path, body);
      if (r.ok) return FriendsResult.ok(r.relation ?? null);
      return FriendsResult.fail(explainFriends(r.error ?? null, input));
    } catch (e) {
      console.warn(`[Friends] ${path} failed`, e);
      return FriendsResult.fail(explainFriends(null));
    }
  },

  resetForTests(): void {
    entries.length = 0;
    refreshInFlight = null;
    hasLoaded = false;
    lastError = null;
    socialListeners.clear();
  },
};
