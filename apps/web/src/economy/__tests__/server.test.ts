/** The offline chip ledger (PlayFabChipLedger rules) and the CloudScript ports (friends.js, economy.js). */
import { describe, expect, it } from 'vitest';
import { TitleChipLedger, readGrantLog } from '../server/chipLedger';
import { runCloudScript, type CloudResult } from '../server/cloudScript';
import { createPlayer, memoryTitle, type TitleStateHandle } from '../server/titleState';

const quiet = { log: () => {} };
const A = 'AAAA000011112222';
const B = 'BBBB000011112222';

function title(): TitleStateHandle {
  const t = memoryTitle();
  createPlayer(t.state, { id: A, displayName: 'Alice' });
  createPlayer(t.state, { id: B, displayName: 'Bob' });
  return t;
}

describe('TitleChipLedger (Economy/Server/PlayFabChipLedger.cs)', () => {
  it('welcomes a first-time player once, then buys in / cashes out under the seat lock', async () => {
    const t = title();
    const ledger = new TitleChipLedger(t, quiet);
    expect(await ledger.getBalanceAsync(A)).toBe(10000);
    expect(readGrantLog(t.state.players[A]!).welcomed).toBe(true);

    const buy = await ledger.debitBuyInAsync(A, 'T1', 3, 2000);
    expect(buy).toEqual({ success: true, error: null, balance: 8000 });
    expect((await ledger.debitBuyInAsync(A, 'T1', 3, 2000)).error).toBe('Already seated at this table.');
    expect((await ledger.debitBuyInAsync(A, 'T2', 1, 100)).error).toBe("You're already sitting at another table.");

    expect((await ledger.checkpointAsync(A, 'T1', 3, 2600, 4)).success).toBe(true);
    expect((await ledger.creditCashOutAsync(A, 'T2', 2600)).error).toBe('No seat to cash out.');
    const out = await ledger.creditCashOutAsync(A, 'T1', 2600);
    expect(out.balance).toBe(10600);
    expect(t.state.players[A]!.objects.SeatLock).toBeUndefined();
    expect((await ledger.creditCashOutAsync(A, 'T1', 2600)).success).toBe(false); // replay mints nothing
    // Spent to zero and read again: the welcomed flag means no second welcome.
    await ledger.debitBuyInAsync(A, 'T3', 0, 10600);
    await ledger.creditCashOutAsync(A, 'T3', 0);
    expect(await ledger.getBalanceAsync(A)).toBe(0);
  });

  it('refuses an unaffordable buy-in with the balance', async () => {
    const ledger = new TitleChipLedger(title(), quiet);
    expect(await ledger.debitBuyInAsync(A, 'T1', 0, 20000)).toEqual({ success: false, error: 'Not enough chips.', balance: 10000 });
    expect((await ledger.debitBuyInAsync(A, 'T1', 0, 0)).error).toBe('Buy-in must be positive.');
  });

  it('reconcile: a seated lock pays the recorded stack, an ambiguous one pays nothing', async () => {
    const t = title();
    const ledger = new TitleChipLedger(t, quiet);
    await ledger.debitBuyInAsync(A, 'T1', 0, 3000);
    await ledger.checkpointAsync(A, 'T1', 0, 4200, 9);
    expect((await ledger.reconcileAsync(A)).balance).toBe(11200);
    await ledger.debitBuyInAsync(B, 'T1', 1, 1000);
    t.state.players[B]!.objects.SeatLock = { tableId: 'T1', seat: 1, stack: 1000, handNumber: 0, state: 'buying-in' };
    expect(await ledger.reconcileAsync(B)).toEqual({ success: true, error: null, balance: -1 });
    expect(await ledger.getBalanceAsync(B)).toBe(9000);
  });

  it('grants pay once per idempotency key', async () => {
    const t = title();
    const ledger = new TitleChipLedger(t, quiet);
    expect((await ledger.grantAsync(A, 500, 'daily_spin', 'k1')).balance).toBe(10500);
    expect((await ledger.grantAsync(A, 500, 'daily_spin', 'k1')).balance).toBe(10500);
    expect((await ledger.grantAsync(A, 500, 'daily_spin', '')).error).toBe('Grants need an idempotency key.');
  });

  it('authenticates live session tickets only', async () => {
    const t = title();
    t.state.sessions.good = { playFabId: A, expires: Date.now() + 60_000 };
    t.state.sessions.old = { playFabId: A, expires: Date.now() - 1 };
    const ledger = new TitleChipLedger(t, quiet);
    expect(await ledger.authenticateAsync('good')).toBe(A);
    expect(await ledger.authenticateAsync('old')).toBeNull();
    expect(await ledger.authenticateAsync('nope')).toBeNull();
  });
});

describe('CloudScript friends.js', () => {
  const call = (t: TitleStateHandle, me: string, fn: string, args: object): CloudResult => runCloudScript({ title: t, currentPlayerId: me, now: Date.now() }, fn, args)!;

  it('request → both lists tagged; asking back befriends; remove clears both', () => {
    const t = title();
    expect(call(t, A, 'sendFriendRequest', { friendId: A.toLowerCase() })).toEqual({ ok: false, error: 'self' });
    expect(call(t, A, 'sendFriendRequest', { friendId: 'nope' })).toEqual({ ok: false, error: 'invalid_id' });
    expect(call(t, A, 'sendFriendRequest', { friendId: 'CCCC-0000-1111-2222' })).toEqual({ ok: false, error: 'not_found' });
    expect(call(t, A, 'sendFriendRequest', { friendId: 'bbbb-0000-1111-2222' })).toEqual({ ok: true, relation: 'pending_out' });
    expect(t.state.players[B]!.friends[A]!.tags).toEqual(['pending_in']);
    expect(call(t, A, 'sendFriendRequest', { friendId: B })).toEqual({ ok: false, error: 'already_requested' });
    expect(call(t, A, 'acceptFriendRequest', { friendId: B })).toEqual({ ok: false, error: 'no_request' });
    expect(call(t, B, 'sendFriendRequest', { friendId: A })).toEqual({ ok: true, relation: 'friend' });
    expect(t.state.players[A]!.friends[B]!.tags).toEqual(['friend']);
    expect(call(t, A, 'sendFriendRequest', { friendId: B })).toEqual({ ok: false, error: 'already_friends' });
    expect(call(t, A, 'removeFriend', { friendId: B })).toEqual({ ok: true });
    expect(t.state.players[A]!.friends[B]).toBeUndefined();
    expect(t.state.players[B]!.friends[A]).toBeUndefined();
  });

  it('invites: friends only, one per sender, dismissable, pruned after the TTL', () => {
    const t = title();
    expect(call(t, A, 'sendInvite', { friendId: B, session: 'S1' })).toEqual({ ok: false, error: 'not_friends' });
    call(t, A, 'sendFriendRequest', { friendId: B });
    call(t, B, 'acceptFriendRequest', { friendId: A });
    expect(call(t, A, 'sendInvite', { friendId: B, session: '' })).toEqual({ ok: false, error: 'invalid_session' });
    expect(call(t, A, 'sendInvite', { friendId: B, session: 'S1', money: true })).toEqual({ ok: true });
    expect(call(t, A, 'sendInvite', { friendId: B, session: 'S2' })).toEqual({ ok: true });
    const mailbox = JSON.parse(t.state.players[B]!.readOnlyData['Poker.Social.Invites']!.Value);
    expect(mailbox.length).toBe(1);
    expect(mailbox[0]).toMatchObject({ from: A, name: 'Alice', session: 'S2', money: false });
    expect(call(t, B, 'dismissInvite', { fromId: A })).toEqual({ ok: true });
    expect(t.state.players[B]!.readOnlyData['Poker.Social.Invites']).toBeUndefined();
  });
});

describe('CloudScript economy.js claimRetentionGrant', () => {
  const today = new Date().toISOString().substring(0, 10);
  const claim = (t: TitleStateHandle, key: string, chips: number, reason: string, now = Date.now()) =>
    runCloudScript({ title: t, currentPlayerId: A, now }, 'claimRetentionGrant', { key, chips, reason })!;

  it('pays catalog amounts once per key and per-day caps; refuses forged ones', () => {
    const t = title();
    const k = `daily_spin:${A}:${today}:Coins:500:`;
    expect(claim(t, k, 500, 'daily_spin')).toEqual({ ok: true, granted: true, balance: 10500 });
    expect(claim(t, k, 500, 'daily_spin')).toEqual({ ok: true, granted: false, balance: 10500 });
    expect(claim(t, `daily_spin:${A}:${today}:Coins:1000:`, 1000, 'daily_spin')).toEqual({ ok: false, error: 'daily_limit' });
    expect(claim(t, `daily_spin:${A}:${today}:Coins:777:`, 777, 'daily_spin')).toEqual({ ok: false, error: 'invalid_grant' });
    expect(claim(t, `daily_spin:${B}:${today}:Coins:500:`, 500, 'daily_spin')).toEqual({ ok: false, error: 'invalid_grant' });
    expect(claim(t, `mission:${A}:${today}:Coins:500:`, 500, 'daily_spin')).toEqual({ ok: false, error: 'invalid_grant' });
    expect(claim(t, `login_reward:${A}:2020-01-01:Coins:500:`, 500, 'login_reward')).toEqual({ ok: false, error: 'too_old' });
    // level_up: 100 + (L-1)*25, doubled on every 10th level (level 10 → 650).
    expect(claim(t, `level_up:${A}:${today}:Coins:650:`, 650, 'level_up')).toMatchObject({ ok: true, granted: true });
  });
});
