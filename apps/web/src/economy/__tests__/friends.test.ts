import { afterEach, describe, expect, it } from 'vitest';
import { FriendRelation } from '@nomad/engine/social/friendRules';
import type { SocialResponse } from '@nomad/contract';
import type { NomadSession } from '../../account/session';
import { NomadLink } from '../nomadLink';
import { FriendInvites } from '../social/friendInvites';
import { Friends } from '../social/friends';

const NOW = 1_794_200_000; // unix seconds

function fakeSession(routes: Record<string, (body: Record<string, unknown>) => unknown>, calls: string[] = []): NomadSession {
  return {
    signedIn: true,
    me: null,
    call: async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push(`${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);
      const h = routes[`${method} ${path}`];
      if (!h) throw new Error(`no route ${method} ${path}`);
      return h(body ?? {});
    },
  } as unknown as NomadSession;
}

const social = (over: Partial<SocialResponse> = {}): SocialResponse => ({
  friendCode: 'AAAABBBBCCCCDDDD',
  friends: [
    { id: '1111222233334444', name: 'Bob', relation: 'friend', lastSeen: NOW * 1000, avatar: 3, online: true, table: 'poker-free' },
    { id: '5555666677778888', name: 'Cat', relation: 'pending_in', lastSeen: NOW * 1000 - 3600_000, avatar: 0, online: false, table: null },
  ],
  invites: [{ fromId: '1111222233334444', fromName: 'Bob', session: 'poker-free', money: false, sentAtUnix: NOW - 30 }],
  serverTime: NOW,
  ...over,
});

afterEach(() => {
  NomadLink.bind(null);
  Friends.clear();
  FriendInvites.clear();
});

describe('friends on the Nomad server', () => {
  it('loads friends with presence and the invite inbox in one call', async () => {
    NomadLink.bind(fakeSession({ 'GET /v1/social': () => social() }));
    expect((await Friends.refreshAsync()).success).toBe(true);
    expect(Friends.all.map((f) => [f.name, f.relation, f.online, f.table])).toEqual([
      ['Bob', FriendRelation.Friend, true, 'poker-free'],
      ['Cat', FriendRelation.IncomingRequest, false, null],
    ]);
    expect(Friends.incomingCount).toBe(1);
    expect(FriendInvites.inbox).toMatchObject([{ fromName: 'Bob', session: 'poker-free' }]);
  });

  it('drops invites past their lifetime on the server clock', async () => {
    NomadLink.bind(fakeSession({ 'GET /v1/social': () => social({ invites: [{ fromId: '1', fromName: 'Old', session: 's', money: false, sentAtUnix: NOW - 900 }] }) }));
    await Friends.refreshAsync();
    expect(FriendInvites.inbox).toEqual([]);
  });

  it('turns server codes into the sentences the screens show', async () => {
    const calls: string[] = [];
    NomadLink.bind(
      fakeSession(
        {
          'POST /v1/friends/request': () => ({ ok: false, error: 'ambiguous_name' }),
          'GET /v1/social': () => social(),
        },
        calls,
      ),
    );
    const r = await Friends.sendRequestAsync(' Sam ');
    expect(r).toEqual({ success: false, error: "More than one player is called 'Sam'. Ask for their Friend ID instead.", relation: null });
    expect(calls[0]).toBe('POST /v1/friends/request {"idOrName":"Sam"}');
  });

  it('invites a friend to the current table, and declining dismisses on the server', async () => {
    const calls: string[] = [];
    NomadLink.bind(fakeSession({ 'GET /v1/social': () => social(), 'POST /v1/invites/send': () => ({ ok: true }), 'POST /v1/invites/dismiss': () => ({ ok: true }) }, calls));
    await Friends.refreshAsync();
    const bob = Friends.find('1111222233334444')!;
    expect((await FriendInvites.inviteAsync(bob)).error).toBe('Join or create a table to invite friends.');
    FriendInvites.setCurrentTable({ session: 'ABCD2345', money: false });
    expect((await FriendInvites.inviteAsync(bob)).success).toBe(true);
    FriendInvites.setCurrentTable(null);
    FriendInvites.decline(FriendInvites.inbox[0]!);
    await Promise.resolve();
    expect(calls).toContain('POST /v1/invites/send {"friendId":"1111222233334444","session":"ABCD2345","money":false}');
    expect(calls).toContain('POST /v1/invites/dismiss {"fromId":"1111222233334444"}');
    expect(FriendInvites.inbox).toEqual([]);
  });

  it('says friends need the server when none is configured', async () => {
    expect((await Friends.refreshAsync()).error).toBe('Friends need the Nomad server, which this build does not use.');
    expect(Friends.available).toBe(false);
  });
});
