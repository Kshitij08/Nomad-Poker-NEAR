/**
 * The PlayFab client code end to end against the local emulated title (`?online=local`): device sign-in + welcome,
 * the Economy v2 balance, coin grants queued → claimRetentionGrant → settled, UserData progress, friends + invites
 * through CloudScript, statistics and leaderboards, saved-session restore, sign-out.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RewardGrant } from '../../app/services';
import { LeaderboardKind } from '../../core/leaderboards/freePlayLeaderboardMath';
import { FriendRelation } from '../../core/social/friendRules';
import { PlayFabConfig } from '../config';
import { PokerClientIdentity } from '../identity';
import { FreePlayLeaderboard } from '../leaderboards/freePlayLeaderboard';
import { PlayFabAuth } from '../playfab/auth';
import { PlayFabClient } from '../playfab/client';
import { PlayFabEconomyBridge, PlayFabGate } from '../playfab/economyBridge';
import { LocalTitleTransport } from '../playfab/localTitle';
import { PlayFabPlayerProgress } from '../playfab/playerProgress';
import { configurePlayFab } from '../playfab/runtime';
import { PlayFabWallet } from '../playfab/wallet';
import { RetentionGrantQueue } from '../retentionGrantQueue';
import { runCloudScript } from '../server/cloudScript';
import { createPlayer, memoryTitle, setStat, type TitleStateHandle } from '../server/titleState';
import { FriendInvites } from '../social/friendInvites';
import { PlayFabFriends } from '../social/playFabFriends';
import { FreePlayBank, VirtualEconomy } from '../virtualEconomy';
import { installMemoryStorage } from './memoryStorage';

let store: Map<string, string>;
let title: TitleStateHandle;

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  await PlayFabEconomyBridge.idle();
  await PlayFabPlayerProgress.flush();
};

beforeEach(() => {
  store = installMemoryStorage();
  title = memoryTitle();
  PokerClientIdentity.resetForTests();
  PlayFabAuth.resetForTests();
  PlayFabWallet.resetForTests();
  PlayFabPlayerProgress.resetForTests();
  PlayFabEconomyBridge.resetForTests();
  PlayFabFriends.resetForTests();
  FriendInvites.resetForTests();
  FreePlayLeaderboard.resetForTests();
  VirtualEconomy.resetForTests();
  PlayFabGate.reset();
  configurePlayFab(new PlayFabClient(PlayFabConfig.TitleId, new LocalTitleTransport(title)));
  console.log = () => {};
  console.warn = () => {};
});

describe('PlayFab flow on the local title', () => {
  it('guest sign-in creates the account, welcomes it and installs the PlayFab wallet', async () => {
    expect(await PlayFabGate.initializeAsync()).toBe(false); // Keep me signed in is off: no auto sign-in
    expect(await PlayFabGate.signInExplicitAsync()).toBe(true);
    const id = PokerClientIdentity.playFabId;
    expect(id).toMatch(/^[0-9A-F]{16}$/);
    expect(PokerClientIdentity.isGuest).toBe(true);
    expect(PokerClientIdentity.playerName).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d{6}$/); // GetOrCreateGuestName
    expect(store.get('Photon.Menu.Username')).toBe(PokerClientIdentity.playerName);
    expect(title.state.players[id]!.displayName).toBe(PokerClientIdentity.playerName); // SyncDisplayNameAsync
    expect(title.state.players[id]!.chips).toBe(10000); // grantStartingChips automation rule
    expect(PlayFabWallet.balance).toBe(10000);
    expect(VirtualEconomy.wallet.coins).toBe(10000);
    expect(PlayFabGate.isReady).toBe(true);
  });

  it('coin grants queue, show as pending, and are paid by claimRetentionGrant', async () => {
    await PlayFabGate.signInExplicitAsync();
    const id = PokerClientIdentity.playFabId;
    expect(VirtualEconomy.tryGrant(RewardGrant.coins(500, 'daily_spin'))).toBe(true);
    expect(VirtualEconomy.wallet.coins).toBe(10500); // pending counted immediately
    await settle();
    expect(title.state.players[id]!.chips).toBe(10500);
    expect(PlayFabWallet.balance).toBe(10500);
    expect(RetentionGrantQueue.pendingCoinsFor(id)).toBe(0);
    expect(VirtualEconomy.wallet.coins).toBe(10500);
    // Same key again: refused locally (settled), no double pay.
    expect(VirtualEconomy.tryGrant(RewardGrant.coins(500, 'daily_spin'))).toBe(false);
    // A second spin the same day: the server's daily cap refuses it for good and it is dropped.
    expect(VirtualEconomy.tryGrant(RewardGrant.coins(1000, 'daily_spin'))).toBe(true);
    await settle();
    expect(title.state.players[id]!.chips).toBe(10500);
    expect(RetentionGrantQueue.snapshot().length).toBe(0);
    // Non-coin rewards go to UserData.
    VirtualEconomy.grant(RewardGrant.xp(120, 'hand'));
    VirtualEconomy.grant(RewardGrant.gems(2, 'x'));
    await settle();
    expect(title.state.players[id]!.userData['Poker.Wallet.Xp']!.Value).toBe('120');
    expect(title.state.players[id]!.userData['Poker.Wallet.Gems']!.Value).toBe('2');
  });

  it('progress: local counters migrate on first pull, cloud wins afterwards', async () => {
    store.set('Poker.Engage.LastSpinDay', '20400');
    store.set('Poker.Engage.StreakDay', '3');
    store.set('Poker.Progress.Missions', 'm1|2');
    await PlayFabGate.signInExplicitAsync();
    await settle();
    const id = PokerClientIdentity.playFabId;
    expect(PlayFabPlayerProgress.isReady).toBe(true);
    expect(PlayFabPlayerProgress.loadEngagement()).toMatchObject({ lastSpinDay: 20400, streakDay: 3 });
    expect(title.state.players[id]!.userData['Poker.Engage.LastSpinDay']!.Value).toBe('20400');
    expect(title.state.players[id]!.userData['Poker.Progress.Missions']!.Value).toBe('m1|2');
    PlayFabPlayerProgress.saveEngagement({ lastSpinDay: 20401, lastLoginDay: 20401, streakDay: 4, lastSpinCoins: 2000 });
    await settle();
    expect(title.state.players[id]!.userData['Poker.Engage.LastSpinCoins']!.Value).toBe('2000');
  });

  it('free play with the PlayFab wallet moves this account\'s FreePlayBank delta', async () => {
    await PlayFabGate.signInExplicitAsync();
    expect(VirtualEconomy.tryDebitFreePlay(3000)).toBe(true);
    expect(FreePlayBank.delta).toBe(-3000);
    expect(VirtualEconomy.wallet.coins).toBe(7000);
    VirtualEconomy.creditFreePlay(3500);
    expect(VirtualEconomy.wallet.coins).toBe(10500);
  });

  it('friends: request by name, accept on the other side, invite mailbox with server time', async () => {
    await PlayFabGate.signInExplicitAsync();
    const me = PokerClientIdentity.playFabId;
    const bob = createPlayer(title.state, { id: 'B0B0B0B0B0B0B0B0', displayName: 'BobTheFish', lastLogin: Date.now() - 5 * 60_000 });
    expect((await PlayFabFriends.sendRequestAsync('nobody-here')).error).toBe("No player called 'nobody-here'. Ask for their Friend ID instead.");
    expect((await PlayFabFriends.sendRequestAsync(PokerClientIdentity.playFabId)).error).toBe("That's your own Friend ID.");
    const sent = await PlayFabFriends.sendRequestAsync('BobTheFish');
    expect(sent).toEqual({ success: true, error: null, relation: 'pending_out' });
    expect(PlayFabFriends.all.map((f) => [f.name, f.relation])).toEqual([['BobTheFish', FriendRelation.OutgoingRequest]]);
    runCloudScript({ title, currentPlayerId: bob.id, now: Date.now() }, 'acceptFriendRequest', { friendId: me });
    await PlayFabFriends.refreshAsync();
    const f = PlayFabFriends.find(bob.id)!;
    expect(f.relation).toBe(FriendRelation.Friend);
    expect(f.lastLogin).toBe(bob.lastLogin);
    // Invite me from Bob's table; I poll the mailbox.
    runCloudScript({ title, currentPlayerId: bob.id, now: Date.now() }, 'sendInvite', { friendId: me, session: 'TABLE-42' });
    await FriendInvites.pollAsync();
    expect(FriendInvites.inbox.map((i) => [i.fromId, i.fromName, i.session])).toEqual([[bob.id, 'BobTheFish', 'TABLE-42']]);
    expect(await FriendInvites.acceptAsync(FriendInvites.inbox[0]!)).toBe('Go back to the main menu to join.');
    let joined: string | null = null;
    FriendInvites.joinHandler = async (inv) => ((joined = inv.session), null);
    expect(await FriendInvites.acceptAsync(FriendInvites.inbox[0]!)).toBeNull();
    expect(joined).toBe('TABLE-42');
    await settle();
    expect(FriendInvites.inbox.length).toBe(0);
    expect(title.state.players[me]!.readOnlyData['Poker.Social.Invites']).toBeUndefined(); // dismissInvite
    // Inviting needs a table.
    expect((await FriendInvites.inviteAsync(f)).error).toBe('Join or create a table to invite friends.');
    FriendInvites.setCurrentTable({ session: 'MY-TABLE', money: false });
    expect((await FriendInvites.inviteAsync(f)).success).toBe(true);
  });

  it('leaderboards: hands submit statistics; pages rank by value with the local row marked', async () => {
    await PlayFabGate.signInExplicitAsync();
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      const p = createPlayer(title.state, { displayName: 'Rival' + i });
      setStat(p, 'FP_WeeklyEarnings', 1000 * (i + 1), now);
    }
    FreePlayLeaderboard.recordHand(5500, true);
    await settle();
    const p0 = await FreePlayLeaderboard.fetchAsync(LeaderboardKind.WeeklyEarnings, 0);
    expect(p0.rows.length).toBe(10);
    expect(p0.rows[0]).toMatchObject({ rank: 1, displayName: 'Rival11', score: 12000, isLocal: false });
    expect(p0.hasMore).toBe(true);
    expect(p0.status).toBe('Free-play only · not SOL tables');
    const me = p0.rows.find((r) => r.isLocal)!;
    expect(me).toMatchObject({ rank: 8, score: 5500 });
    expect(p0.localRank).toBe(8);
    expect(p0.localScore).toBe(5500);
    const p1 = await FreePlayLeaderboard.fetchAsync(LeaderboardKind.WeeklyEarnings, 1);
    expect(p1.rows.map((r) => r.rank)).toEqual([11, 12, 13]);
    const hands = await FreePlayLeaderboard.fetchAsync(LeaderboardKind.HandsWon, 0);
    expect(hands.rows).toEqual([{ rank: 1, displayName: PokerClientIdentity.playerName, score: 1, isLocal: true }]);
    const friends = await FreePlayLeaderboard.fetchAsync(LeaderboardKind.FriendsWeekly, 0);
    expect(friends.rows.length).toBe(1);
  });

  it('Keep me signed in saves the session; a relaunch restores it without a new login; sign-out forgets it', async () => {
    PlayFabAuth.keepMeSignedIn = true;
    await PlayFabGate.signInExplicitAsync();
    const id = PokerClientIdentity.playFabId;
    const saved = JSON.parse(store.get('Poker.PlayFab.Session')!);
    expect(saved).toMatchObject({ titleId: '6A5AE', playFabId: id, entityType: 'title_player_account' });
    expect(saved.expiresUtcTicks).toBeGreaterThan(621355968000000000);
    // "Relaunch": forget the in-memory client state.
    configurePlayFab(new PlayFabClient(PlayFabConfig.TitleId, new LocalTitleTransport(title)));
    PokerClientIdentity.playFabSessionTicket = '';
    PlayFabGate.reset();
    const sessionsBefore = Object.keys(title.state.sessions).length;
    expect(await PlayFabGate.initializeAsync()).toBe(true);
    expect(PokerClientIdentity.playFabId).toBe(id);
    expect(Object.keys(title.state.sessions).length).toBe(sessionsBefore); // restored, not a fresh login
    PlayFabAuth.signOut();
    expect(store.has('Poker.PlayFab.Session')).toBe(false);
    expect(PokerClientIdentity.isPlayFabSignedIn).toBe(false);
    expect(store.get('Poker.ClientToken')).toBeTruthy(); // the device token survives
  });

  it('email recovery: save on the guest, then sign in from a new device and bind it', async () => {
    await PlayFabGate.signInExplicitAsync();
    const id = PokerClientIdentity.playFabId;
    expect((await PlayFabAuth.addRecoveryLoginAsync('me@x.io', '123', null)).error).toBe('Password must be at least 6 characters.');
    expect((await PlayFabAuth.addRecoveryLoginAsync('me@x.io', 'secret1', null)).success).toBe(true);
    expect(PokerClientIdentity.isGuest).toBe(false);
    PlayFabAuth.signOut();
    store.delete('Poker.ClientToken');
    PokerClientIdentity.resetForTests(); // a different device
    expect((await PlayFabAuth.loginWithEmailAsync('me@x.io', 'wrong!!')).error).toBe("That email and password don't match an account.");
    expect((await PlayFabAuth.loginWithEmailAsync('me@x.io', 'secret1')).playFabId).toBe(id);
    expect((await PlayFabAuth.linkDeviceAsync()).success).toBe(true);
    expect(title.state.players[id]!.customIds).toContain(PokerClientIdentity.token);
  });

  it('rename: length and placeholder rules, a taken name is refused', async () => {
    await PlayFabGate.signInExplicitAsync();
    createPlayer(title.state, { displayName: 'TakenName' });
    expect(await PlayFabAuth.renameAsync('ab')).toBe('Names must be 3–25 characters.');
    expect(await PlayFabAuth.renameAsync('player')).toBe('Pick a name other than "Player".');
    expect(await PlayFabAuth.renameAsync('takenname')).toBe('That name is taken — pick another.');
    expect(await PlayFabAuth.renameAsync('NewName')).toBeNull();
    expect(PokerClientIdentity.playerName).toBe('NewName');
    expect(PlayFabAuth.isFusionPlaceholderUsername('PlayerA1b')).toBe(true);
    expect(PlayFabAuth.isFusionPlaceholderUsername('Player12')).toBe(false);
  });
});
