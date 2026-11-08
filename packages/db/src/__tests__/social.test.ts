import { beforeEach, describe, expect, it } from 'vitest';
import { FriendCode } from '@nomad/engine/social/friendCode';
import { LeaderboardKind } from '@nomad/engine/leaderboards/freePlayLeaderboardMath';
import { createPlayer, findPlayer } from '../accounts';
import { leaderboard } from '../leaderboards';
import { recordHand } from '../progress';
import { buyIn } from '../seatLocks';
import { acceptRequest, dismissInvite, removeFriend, sendInvite, sendRequest, social, updateProfile } from '../social';
import { D1Shim } from '../testing/d1Shim';
import type { PlayerRow } from '../types';

const T0 = Date.UTC(2026, 10, 9, 12);
let db: D1Database;
let ann: PlayerRow;
let bob: PlayerRow;
let cat: PlayerRow;

const reload = async (p: PlayerRow) => (await findPlayer(db, p.id))!;

beforeEach(async () => {
  db = await D1Shim.migrated();
  ann = await reload(await createPlayer(db, { displayName: 'Ann' }, T0));
  bob = await reload(await createPlayer(db, { displayName: 'Bob' }, T0));
  cat = await reload(await createPlayer(db, { displayName: 'Cat' }, T0));
});

describe('friends', () => {
  it('gives every player a unique 16-hex Friend ID', () => {
    for (const p of [ann, bob, cat]) expect(FriendCode.tryParse(p.friend_code!)).toBe(p.friend_code);
    expect(new Set([ann.friend_code, bob.friend_code, cat.friend_code]).size).toBe(3);
  });

  it('requests by Friend ID (any spelling) or unique name; asking back accepts', async () => {
    expect(await sendRequest(db, ann, FriendCode.format(bob.friend_code!).toLowerCase(), T0)).toEqual({ ok: true, relation: 'pending_out' });
    let a = await social(db, ann, T0);
    let b = await social(db, bob, T0);
    expect(a.friends).toMatchObject([{ id: bob.friend_code, name: 'Bob', relation: 'pending_out' }]);
    expect(b.friends).toMatchObject([{ id: ann.friend_code, relation: 'pending_in' }]);
    expect(await sendRequest(db, ann, 'bob', T0)).toEqual({ ok: false, error: 'already_requested' });
    expect(await sendRequest(db, bob, 'Ann', T0)).toEqual({ ok: true, relation: 'friend' });
    a = await social(db, ann, T0);
    b = await social(db, bob, T0);
    expect(a.friends[0]!.relation).toBe('friend');
    expect(b.friends[0]!.relation).toBe('friend');
    expect(await sendRequest(db, ann, bob.friend_code!, T0)).toEqual({ ok: false, error: 'already_friends' });
  });

  it('refuses yourself, unknown ids and names, and names two players share', async () => {
    expect(await sendRequest(db, ann, ann.friend_code!, T0)).toEqual({ ok: false, error: 'self' });
    expect(await sendRequest(db, ann, '0000000000000000', T0)).toEqual({ ok: false, error: 'not_found' });
    expect(await sendRequest(db, ann, 'Nobody', T0)).toEqual({ ok: false, error: 'not_found_name' });
    await createPlayer(db, { displayName: 'bob' }, T0);
    expect(await sendRequest(db, ann, 'Bob', T0)).toEqual({ ok: false, error: 'ambiguous_name' });
  });

  it('accepts only a waiting request; remove clears both sides', async () => {
    expect(await acceptRequest(db, bob, ann.friend_code!, T0)).toEqual({ ok: false, error: 'no_request' });
    await sendRequest(db, ann, bob.friend_code!, T0);
    expect(await acceptRequest(db, bob, ann.friend_code!, T0)).toEqual({ ok: true, relation: 'friend' });
    await removeFriend(db, bob, ann.friend_code!);
    expect((await social(db, ann, T0)).friends).toEqual([]);
    expect((await social(db, bob, T0)).friends).toEqual([]);
  });
});

describe('invites and presence', () => {
  beforeEach(async () => {
    await sendRequest(db, ann, bob.friend_code!, T0);
    await acceptRequest(db, bob, ann.friend_code!, T0);
  });

  it('delivers an invite to a friend only, replaces it, expires it, and dismisses it', async () => {
    expect(await sendInvite(db, ann, cat.friend_code!, 'poker-free', false, T0)).toEqual({ ok: false, error: 'not_friends' });
    expect(await sendInvite(db, ann, bob.friend_code!, '', false, T0)).toEqual({ ok: false, error: 'invalid_session' });
    await sendInvite(db, ann, bob.friend_code!, 'poker-free', false, T0);
    await sendInvite(db, ann, bob.friend_code!, 'ABCD2345', false, T0 + 1000);
    let inbox = (await social(db, bob, T0 + 2000)).invites;
    expect(inbox).toEqual([{ fromId: ann.friend_code, fromName: 'Ann', session: 'ABCD2345', money: false, sentAtUnix: Math.floor((T0 + 1000) / 1000) }]);
    expect((await social(db, bob, T0 + 11 * 60_000)).invites).toEqual([]);
    await sendInvite(db, ann, bob.friend_code!, 'poker-free', false, T0 + 12 * 60_000);
    await dismissInvite(db, bob, ann.friend_code!);
    inbox = (await social(db, bob, T0 + 12 * 60_000)).invites;
    expect(inbox).toEqual([]);
  });

  it('shows a friend online after activity, and the table they sit at', async () => {
    await social(db, bob, T0 + 120_000); // Bob opens the friends list: active now
    let view = (await social(db, ann, T0 + 150_000)).friends[0]!;
    expect(view).toMatchObject({ online: true, table: null });
    await buyIn(db, { playerId: bob.id, tableId: 't1', room: 'poker-free', seat: 2, chips: 1000 });
    view = (await social(db, ann, T0 + 150_000)).friends[0]!;
    expect(view.table).toBe('poker-free');
    view = (await social(db, ann, T0 + 10 * 60_000)).friends[0]!;
    expect(view.online).toBe(false);
  });
});

describe('profile', () => {
  it('renames and picks an avatar within the catalogue', async () => {
    expect(await updateProfile(db, ann, { displayName: '  Ann Q  ', avatar: 3 }, 10)).toEqual({ ok: true });
    expect(await reload(ann)).toMatchObject({ display_name: 'Ann Q', avatar: 3 });
    expect((await updateProfile(db, ann, { displayName: 'A' }, 10)).ok).toBe(false);
    expect((await updateProfile(db, ann, { avatar: 10 }, 10)).ok).toBe(false);
  });
});

describe('leaderboards', () => {
  const play = (p: PlayerRow, hand: number, net: number, won: boolean, at = T0) => recordHand(db, p.id, { tableId: 't1', hand, won, showdownCategory: null, net }, at);

  it('ranks weekly earnings and hands won from recorded hands, once per hand', async () => {
    await play(ann, 1, 300, true);
    await play(bob, 1, -300, false);
    await play(ann, 2, -50, false);
    await play(bob, 2, 50, true);
    await play(bob, 2, 50, true); // a replay
    await play(cat, 3, 900, true);
    const weekly = await leaderboard(db, ann.id, LeaderboardKind.WeeklyEarnings, 0, T0);
    expect(weekly.rows.map((r) => [r.displayName, r.score, r.rank, r.isLocal])).toEqual([
      ['Cat', 900, 1, false],
      ['Ann', 250, 2, true],
      ['Bob', -250, 3, false],
    ]);
    expect(weekly).toMatchObject({ localRank: 2, localScore: 250, hasMore: false });
    const wins = await leaderboard(db, bob.id, LeaderboardKind.WeeklyHandsWon, 0, T0);
    expect(wins.rows.map((r) => r.score)).toEqual([1, 1, 1]);
    expect(wins.localScore).toBe(1);
  });

  it('starts a new week on Monday UTC; the friends board shows only friends', async () => {
    await play(ann, 1, 300, true);
    await play(cat, 1, 900, true);
    const nextWeek = T0 + 7 * 86_400_000;
    expect((await leaderboard(db, ann.id, LeaderboardKind.WeeklyEarnings, 0, nextWeek)).rows).toEqual([]);
    expect((await leaderboard(db, ann.id, LeaderboardKind.HandsWon, 0, nextWeek)).rows).toHaveLength(2);
    await sendRequest(db, ann, bob.friend_code!, T0);
    await acceptRequest(db, bob, ann.friend_code!, T0);
    await play(bob, 2, 40, true);
    const friends = await leaderboard(db, ann.id, LeaderboardKind.FriendsWeekly, 0, T0);
    expect(friends.rows.map((r) => r.displayName)).toEqual(['Ann', 'Bob']);
  });

  it('pages ten rows at a time and ranks a player with no hands last', async () => {
    for (let i = 0; i < 12; i++) {
      const p = await createPlayer(db, { displayName: `P${String(i).padStart(2, '0')}` }, T0);
      await recordHand(db, p.id, { tableId: 't9', hand: i, won: false, showdownCategory: null, net: 100 + i }, T0);
    }
    const p0 = await leaderboard(db, ann.id, LeaderboardKind.WeeklyEarnings, 0, T0);
    const p1 = await leaderboard(db, ann.id, LeaderboardKind.WeeklyEarnings, 1, T0);
    expect(p0.rows).toHaveLength(10);
    expect(p0.hasMore).toBe(true);
    expect(p1.rows.map((r) => r.rank)).toEqual([11, 12]);
    expect(p0).toMatchObject({ localScore: 0, localRank: 13 });
  });
});
