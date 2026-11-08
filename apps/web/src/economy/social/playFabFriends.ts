/**
 * Port of Social/PlayFabFriends.cs: the friends list on PlayFab. Reading is GetFriendsList; every CHANGE goes
 * through the friends.js CloudScript handlers (the list is one-way, so both sides are written by the server).
 * Never throws; every failure is a sentence fit to show the player.
 */
import { AvatarUrl } from '@nomad/engine/social/avatarUrl';
import { FriendCode } from '@nomad/engine/social/friendCode';
import { FriendRelation, FriendTags } from '@nomad/engine/social/friendRules';
import { PokerClientIdentity } from '../identity';
import { errorReport, type PlayFabError } from '../playfab/client';
import { isClientLoggedIn, playFab } from '../playfab/runtime';
import { Signal } from '../signal';

/** One row of the friends list, from this player's side. */
export interface FriendEntry {
  id: string;
  name: string | null;
  relation: FriendRelation;
  /** Last login, epoch ms (UTC); null when unknown. */
  lastLogin: number | null;
  /** AvatarCatalog value; 0 (None) when unknown or not shared. */
  avatar: number;
}

/** The display name, or the Friend ID for a player who never set one. */
export const friendLabel = (f: { id: string; name: string | null }): string =>
  f.name && f.name.trim() ? f.name : FriendCode.format(f.id);

export interface FriendsResult {
  readonly success: boolean;
  readonly error: string | null;
  /** The relation a handler reports on success ("friend", "pending_out"…). */
  readonly relation: string | null;
}
export const FriendsResult = {
  ok: (relation: string | null = null): FriendsResult => ({ success: true, error: null, relation }),
  fail: (error: string): FriendsResult => ({ success: false, error, relation: null }),
};

interface FriendInfo {
  FriendPlayFabId?: string;
  TitleDisplayName?: string;
  Username?: string;
  Tags?: string[];
  Profile?: { DisplayName?: string; LastLogin?: string; AvatarUrl?: string };
}

/** Most profile first; a title that disallows a field steps down a level for the session. */
const ProfileViews = [
  { ShowDisplayName: true, ShowLastLogin: true, ShowAvatarUrl: true },
  { ShowDisplayName: true, ShowLastLogin: true },
  null,
];

const entries: FriendEntry[] = [];
let refreshInFlight: Promise<FriendsResult> | null = null;
let profileView = 0;
let hasLoaded = false;
let lastError: string | null = null;

const isSignedIn = (): boolean => isClientLoggedIn() && PokerClientIdentity.isPlayFabSignedIn;

function firstNonEmpty(...values: (string | undefined | null)[]): string | null {
  for (const v of values) if (v && v.trim()) return v.trim();
  return null;
}

/** C# string.Compare(..., OrdinalIgnoreCase). */
function compareOrdinalIgnoreCase(a: string, b: string): number {
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Player-facing text for a handler's error code. */
export function explainFriends(code: string | null): string {
  switch (code) {
    case 'invalid_id': return "That Friend ID doesn't look right.";
    case 'self': return "That's your own Friend ID.";
    case 'not_found': return 'No player has that Friend ID.';
    case 'already_friends': return "You're already friends.";
    case 'already_requested': return 'Request already sent — waiting for them to accept.';
    case 'no_request': return "That request isn't there any more.";
    case 'not_friends': return 'You can only invite friends.';
    case 'invalid_session': return "This table can't be shared.";
    case 'CloudScriptNotFound': return "Friends aren't set up on the server yet.";
    default: return "Couldn't reach the server. Check your connection and try again.";
  }
}

const noSuchName = (name: string) => `No player called '${name}'. Ask for their Friend ID instead.`;

async function fetchAsync(profile: object | null): Promise<{ friends: FriendInfo[] | null; error: PlayFabError | null }> {
  const r = await playFab()!.client<{ Friends?: FriendInfo[] }>('GetFriendsList', profile ? { ProfileConstraints: profile } : {});
  return r.error ? { friends: null, error: r.error } : { friends: r.data.Friends ?? [], error: null };
}

async function refreshOnceAsync(): Promise<FriendsResult> {
  try {
    let { friends, error } = await fetchAsync(ProfileViews[profileView]!);
    while (error?.error === 'RequestViewConstraintParamsNotAllowed' && profileView < ProfileViews.length - 1) {
      profileView++;
      console.warn("[Friends] The title does not let clients read part of a friend's profile. Allow Display name, Last login time and Avatar URL in Game Manager → Title settings → Client Profile Options. Carrying on with less.");
      ({ friends, error } = await fetchAsync(ProfileViews[profileView]!));
    }
    if (error || !friends) {
      if (error) console.warn(`[Friends] GetFriendsList failed: ${errorReport(error)}`);
      lastError = "Couldn't load your friends. Check your connection.";
      PlayFabFriends.changed.emit();
      return FriendsResult.fail(lastError);
    }
    entries.length = 0;
    for (const info of friends) {
      if (!info?.FriendPlayFabId) continue;
      const login = info.Profile?.LastLogin ? Date.parse(info.Profile.LastLogin) : NaN;
      entries.push({
        id: info.FriendPlayFabId,
        name: firstNonEmpty(info.Profile?.DisplayName, info.TitleDisplayName, info.Username),
        relation: FriendTags.fromTags(info.Tags),
        lastLogin: Number.isFinite(login) ? login : null,
        avatar: AvatarUrl.fromUrl(info.Profile?.AvatarUrl),
      });
    }
    entries.sort((a, b) => compareOrdinalIgnoreCase(friendLabel(a), friendLabel(b)));
    hasLoaded = true;
    lastError = null;
    PlayFabFriends.changed.emit();
    return FriendsResult.ok();
  } catch (e) {
    console.error('[Friends] Refresh threw', e);
    lastError = "Couldn't load your friends.";
    return FriendsResult.fail(lastError);
  }
}

async function lookUpByNameAsync(name: string): Promise<{ id: string | null; result: FriendsResult }> {
  const r = await playFab()!.client<{ AccountInfo?: { PlayFabId?: string } }>('GetAccountInfo', { TitleDisplayName: name });
  if (r.error) {
    const missing = r.error.error === 'AccountNotFound' || r.error.error === 'InvalidParams';
    if (!missing) console.warn(`[Friends] Name lookup failed: ${errorReport(r.error)}`);
    return { id: null, result: FriendsResult.fail(missing ? noSuchName(name) : "Couldn't reach the server. Check your connection and try again.") };
  }
  const id = r.data.AccountInfo?.PlayFabId;
  return id ? { id, result: FriendsResult.ok() } : { id: null, result: FriendsResult.fail(noSuchName(name)) };
}

export const PlayFabFriends = {
  changed: new Signal(),

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

  find(playFabId: string): FriendEntry | null {
    return entries.find((e) => e.id === playFabId) ?? null;
  },

  /** Forgets the list — on sign-out, or when a different account signs in. */
  clear(): void {
    entries.length = 0;
    hasLoaded = false;
    lastError = null;
    PlayFabFriends.changed.emit();
  },

  /** Reloads the list; overlapping callers share one request. */
  async refreshAsync(): Promise<FriendsResult> {
    if (!isSignedIn()) return FriendsResult.fail('Sign in first.');
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
    if (!isSignedIn()) return FriendsResult.fail('Sign in first.');
    if (!idOrName || !idOrName.trim()) return FriendsResult.fail('Enter a Friend ID or player name.');
    let friendId = FriendCode.tryParse(idOrName);
    if (friendId === null) {
      const lookup = await lookUpByNameAsync(idOrName.trim());
      if (!lookup.id) return lookup.result;
      friendId = lookup.id;
    }
    if (friendId === PokerClientIdentity.playFabId) return FriendsResult.fail(explainFriends('self'));
    const sent = await PlayFabFriends.callAsync('sendFriendRequest', { friendId });
    if (sent.success) await PlayFabFriends.refreshAsync();
    return sent;
  },

  async acceptAsync(friendId: string): Promise<FriendsResult> {
    const result = await PlayFabFriends.callAsync('acceptFriendRequest', { friendId });
    await PlayFabFriends.refreshAsync();
    return result;
  },

  /** Decline, cancel and unfriend are all this: the pair comes off both lists. */
  async removeAsync(friendId: string): Promise<FriendsResult> {
    const result = await PlayFabFriends.callAsync('removeFriend', { friendId });
    await PlayFabFriends.refreshAsync();
    return result;
  },

  /** Runs one friends handler (the ONLY place that knows they are legacy CloudScript). */
  async callAsync(fn: string, args: Record<string, unknown>): Promise<FriendsResult> {
    if (!isSignedIn()) return FriendsResult.fail('Sign in first.');
    const r = await playFab()!.client<{ FunctionResult?: Record<string, unknown>; Error?: { Error?: string; Message?: string } }>(
      'ExecuteCloudScript', { FunctionName: fn, FunctionParameter: args, GeneratePlayStreamEvent: false });
    if (r.error) {
      console.warn(`[Friends] ${fn} failed: ${errorReport(r.error)}`);
      return FriendsResult.fail(r.error.error === 'CloudScriptNotFound' ? explainFriends('CloudScriptNotFound') : explainFriends(null));
    }
    if (r.data.Error) {
      console.warn(`[Friends] ${fn} errored: ${r.data.Error.Error} — ${r.data.Error.Message}`);
      return FriendsResult.fail(explainFriends(r.data.Error.Error ?? null));
    }
    const reply = r.data.FunctionResult;
    if (reply && reply.ok === true) return FriendsResult.ok(typeof reply.relation === 'string' ? reply.relation : null);
    const code = reply && typeof reply.error === 'string' ? reply.error : null;
    console.warn(`[Friends] ${fn} refused: ${code ?? '(no result)'}`);
    return FriendsResult.fail(explainFriends(code));
  },

  resetForTests(): void {
    entries.length = 0;
    refreshInFlight = null;
    profileView = 0;
    hasLoaded = false;
    lastError = null;
  },
};
