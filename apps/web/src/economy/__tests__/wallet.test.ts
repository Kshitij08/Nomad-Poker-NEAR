/** LocalVirtualWallet, VirtualEconomy + FreePlayBank, RetentionGrantQueue, grant keys and idempotency ids. */
import { beforeEach, describe, expect, it } from 'vitest';
import { RewardGrant, RewardKind, type VirtualWallet } from '../../app/services';
import { LocalVirtualWallet } from '../localVirtualWallet';
import { FreePlayBank, VirtualEconomy } from '../virtualEconomy';
import { escapeDataString, RetentionGrantQueue } from '../retentionGrantQueue';
import { buildIdempotencyKey } from '../playfab/virtualWallet';
import { deterministicId, grantIdempotencyId, sha256, utf8, welcomeIdempotencyId } from '../server/ids';
import { installLocalTelemetrySink } from '../analytics/pokerTelemetry';
import { installMemoryStorage } from './memoryStorage';

let store: Map<string, string>;
beforeEach(() => {
  store = installMemoryStorage();
  VirtualEconomy.resetForTests();
});

describe('LocalVirtualWallet (Game/Economy/LocalVirtualWallet.cs)', () => {
  it('first run: 10,000 coins, 1 streak token, persisted under the C# keys', () => {
    const w = new LocalVirtualWallet();
    w.ensureLoaded();
    expect([w.coins, w.gems, w.xp, w.streakTokens]).toEqual([10000, 0, 0, 1]);
    expect(store.get('Poker.Wallet.Initialized')).toBe('1');
    expect(store.get('Poker.Wallet.Coins')).toBe('10000');
    expect(store.get('Poker.Wallet.StreakTokens')).toBe('1');
    expect(store.get('Poker.Wallet.Items')).toBe('');
  });

  it('grants: negative refused, streak tokens capped at 3, cosmetics de-duplicated, reloads the same', () => {
    const w = new LocalVirtualWallet();
    expect(w.tryGrant(RewardGrant.coins(-5, 'x'))).toBe(false);
    expect(w.tryGrant(RewardGrant.coins(250, 'daily_spin'))).toBe(true);
    w.grant(RewardGrant.gems(3, 'x'));
    w.grant(RewardGrant.xp(40, 'x'));
    w.grant(RewardGrant.streakToken(5, 'x'));
    w.grant(RewardGrant.cosmetic('felt_red', 'x'));
    w.grant(RewardGrant.cosmetic('felt_red', 'x'));
    w.grant(RewardGrant.cosmetic('deck_gold', 'x'));
    expect([w.coins, w.gems, w.xp, w.streakTokens]).toEqual([10250, 3, 40, 3]);
    expect(store.get('Poker.Wallet.Items')).toBe('felt_red,deck_gold');
    const again = new LocalVirtualWallet();
    again.ensureLoaded();
    expect([again.coins, again.gems, again.xp, again.streakTokens, again.ownedItems.join()]).toEqual([10250, 3, 40, 3, 'felt_red,deck_gold']);
    expect(again.owns('deck_gold')).toBe(true);
    expect(again.tryConsumeStreakToken()).toBe(true);
    expect(again.streakTokens).toBe(2);
  });

  it('trySpendCoins refuses an overdraft', () => {
    const w = new LocalVirtualWallet();
    expect(w.trySpendCoins(10001)).toBe(false);
    expect(w.trySpendCoins(1000)).toBe(true);
    expect(w.coins).toBe(9000);
  });
});

describe('VirtualEconomy + FreePlayBank', () => {
  it('local wallet: buy-in spends coins, cash-out grants them back, telemetry logs sources/sinks', () => {
    const sink = installLocalTelemetrySink(false);
    let notified = 0;
    const off = VirtualEconomy.changed.on(() => notified++);
    expect(VirtualEconomy.tryDebitFreePlay(2500)).toBe(true);
    expect(VirtualEconomy.wallet.coins).toBe(7500);
    expect(VirtualEconomy.tryDebitFreePlay(999999)).toBe(false);
    VirtualEconomy.creditFreePlay(3100);
    expect(VirtualEconomy.wallet.coins).toBe(10600);
    expect(VirtualEconomy.tryGrant(RewardGrant.coins(500, 'login_reward'))).toBe(true);
    expect(notified).toBeGreaterThan(0);
    off();
    const names = sink.events.map((e) => e.name);
    expect(names).toContain('coin_sink');
    expect(sink.events.find((e) => e.name === 'coin_source')!.params).toEqual({ source: 'login_reward', amount: 500, balance: 11100 });
  });

  it('a non-local wallet routes free play through the account-scoped FreePlayBank delta', () => {
    const fake: VirtualWallet = {
      coins: 0, gems: 0, xp: 0, streakTokens: 0, ownedItems: [],
      canAfford: () => true, grant: () => {}, tryGrant: () => true, tryConsumeStreakToken: () => false, owns: () => false,
    };
    Object.defineProperty(fake, 'coins', { get: () => 5000 + FreePlayBank.delta });
    VirtualEconomy.setProvider(fake);
    // Unbound: no account carries a delta, so nothing is recorded.
    expect(FreePlayBank.delta).toBe(0);
    FreePlayBank.bindAccount('AAAA000011112222');
    expect(VirtualEconomy.tryDebitFreePlay(2000)).toBe(true);
    expect(FreePlayBank.delta).toBe(-2000);
    expect(store.get('Poker.FreePlay.BankDelta.AAAA000011112222')).toBe('-2000');
    expect(VirtualEconomy.tryDebitFreePlay(4000)).toBe(false); // 3000 left
    VirtualEconomy.creditFreePlay(500);
    expect(FreePlayBank.delta).toBe(-1500);
    // Another account on the same device does not inherit it.
    FreePlayBank.bindAccount('BBBB000011112222');
    expect(FreePlayBank.delta).toBe(0);
    FreePlayBank.bindAccount('AAAA000011112222');
    expect(FreePlayBank.delta).toBe(-1500);
    FreePlayBank.clear();
    expect(FreePlayBank.delta).toBe(0);
  });
});

describe('RetentionGrantQueue (Economy/RetentionGrantQueue.cs)', () => {
  const id = 'ABCDEF0123456789';
  const key = (src: string, amount: number) => `${src}:${id}:2026-11-07:Coins:${amount}:`;

  it('rows use Uri.EscapeDataString and the key|chips|reason;… format', () => {
    expect(escapeDataString("a:b|c d!'()*~")).toBe('a%3Ab%7Cc%20d%21%27%28%29%2A~');
    expect(RetentionGrantQueue.tryEnqueue(key('daily_spin', 500), 500, 'daily_spin')).toBe(true);
    expect(RetentionGrantQueue.tryEnqueue(key('mission', 750), 750, 'mission')).toBe(true);
    expect(store.get('Poker.Retention.PendingGrants')).toBe(
      `daily_spin%3A${id}%3A2026-11-07%3ACoins%3A500%3A|500|daily_spin;mission%3A${id}%3A2026-11-07%3ACoins%3A750%3A|750|mission`);
    expect(RetentionGrantQueue.pendingCoinsFor(id)).toBe(1250);
    expect(RetentionGrantQueue.pendingCoinsFor('0000000000000000')).toBe(0);
  });

  it('refuses duplicates, non-positive, over-jackpot amounts and settled keys', () => {
    expect(RetentionGrantQueue.tryEnqueue(key('daily_spin', 500), 500, 'daily_spin')).toBe(true);
    expect(RetentionGrantQueue.tryEnqueue(key('daily_spin', 500), 500, 'daily_spin')).toBe(false);
    expect(RetentionGrantQueue.tryEnqueue(key('x', 0), 0, 'x')).toBe(false);
    expect(RetentionGrantQueue.tryEnqueue(key('x', 25001), 25001, 'x')).toBe(false);
    expect(RetentionGrantQueue.tryEnqueue(key('x', 25000), 25000, 'x')).toBe(true);
    RetentionGrantQueue.settle(key('daily_spin', 500));
    expect(RetentionGrantQueue.contains(key('daily_spin', 500))).toBe(false);
    expect(RetentionGrantQueue.isSettled(key('daily_spin', 500))).toBe(true);
    expect(RetentionGrantQueue.tryEnqueue(key('daily_spin', 500), 500, 'daily_spin')).toBe(false);
  });

  it('keeps the newest 32 pending entries', () => {
    for (let i = 1; i <= 40; i++) RetentionGrantQueue.tryEnqueue(`level_up:${id}:2026-11-07:Coins:${i}:`, i, 'level_up');
    const snap = RetentionGrantQueue.snapshot();
    expect(snap.length).toBe(32);
    expect(snap[0]!.chips).toBe(9);
  });
});

describe('grant keys and idempotency ids', () => {
  it('BuildIdempotencyKey: source:PlayFabId:yyyy-MM-dd(UTC):Kind:amount:item', () => {
    const t = Date.UTC(2026, 10, 7, 23, 30);
    expect(buildIdempotencyKey(RewardGrant.coins(500, 'daily_spin'), 'ABCDEF0123456789', t)).toBe('daily_spin:ABCDEF0123456789:2026-11-07:Coins:500:');
    expect(buildIdempotencyKey(RewardGrant.of(RewardKind.Coins, 10, '', ''), '', t)).toBe('grant:local:2026-11-07:Coins:10:');
  });

  it('SHA-256 (FIPS 180-4 vectors) and the .NET Guid layout match Node crypto', () => {
    const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
    expect(hex(sha256(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256(utf8('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(grantIdempotencyId('ABCDEF0123456789', 'daily_spin:ABCDEF0123456789:2026-11-07:Coins:500:')).toBe('ac0f35a9-4ad2-bedc-158c-04f34ac83509');
    // Guid(byte[]) prints bytes 3..0, 5..4, 7..6, then 8..15 in order.
    expect(deterministicId('XYZ|welcome')).toBe('6430bd09-563c-3950-f974-a73dcddee4b4');
  });

  it('welcome id: fixed prefix + the 16-hex PlayFabId (economy.js welcomeId), else the hash', () => {
    expect(welcomeIdempotencyId('ABCDEF0123456789')).toBe('77656c63-6f6d-6500-abcd-ef0123456789');
    expect(welcomeIdempotencyId('XYZ')).toBe(deterministicId('XYZ|welcome'));
  });
});
