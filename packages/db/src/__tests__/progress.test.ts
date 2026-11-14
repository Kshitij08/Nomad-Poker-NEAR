import { beforeEach, describe, expect, it } from 'vitest';
import { HandCategory } from '@nomad/engine/evaluation/handCategory';
import { DailySpinCatalog, DailySpinMath, LevelRewardCatalog, LoginRewardCatalog, PlayerLevelMath } from '@nomad/engine/retention';
import { createPlayer } from '../accounts';
import { balances, entries, post } from '../ledger';
import { claimLogin, claimMission, recordHand, recordTableJoined, settleLevels, snapshot, spin, spinRoll } from '../progress';
import { D1Shim } from '../testing/d1Shim';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 9, 12); // a fixed noon, UTC
const SECRET = 'test-spin-secret';

let db: D1Database;
let p: string;

beforeEach(async () => {
  db = await D1Shim.migrated();
  p = (await createPlayer(db, { displayName: 'Pat' }, T0)).id; // 10,000 starter coins
});

const coins = async () => (await balances(db, p)).coins;

describe('daily spin', () => {
  it('pays one catalogue prize a day, rolled by the server', async () => {
    const first = await spin(db, p, SECRET, T0);
    expect(first.awarded).toBe(true);
    expect(DailySpinCatalog.Prizes.map((x) => x.coins)).toContain(first.coins);
    expect(await coins()).toBe(10_000 + first.coins);
    expect(first.progress.spin).toMatchObject({ canSpin: false, lastSpinCoins: first.coins });

    const again = await spin(db, p, SECRET, T0 + 3600_000);
    expect(again).toMatchObject({ awarded: false, coins: first.coins });
    expect(await coins()).toBe(10_000 + first.coins);

    const tomorrow = await spin(db, p, SECRET, T0 + DAY);
    expect(tomorrow.awarded).toBe(true);
  });

  it('rolls the same prize on a retry, and a different one without the secret', async () => {
    const day = Math.floor(T0 / DAY);
    expect(await spinRoll(SECRET, p, day)).toBe(await spinRoll(SECRET, p, day));
    const rolls = await Promise.all(Array.from({ length: 50 }, (_, i) => spinRoll(SECRET, `p${i}`, day)));
    expect(new Set(rolls).size).toBeGreaterThan(40);
    expect(rolls.every((r) => r >= 0 && r < 1000)).toBe(true);
  });

  it('pays once when two spins race', async () => {
    const [a, b] = await Promise.all([spin(db, p, SECRET, T0), spin(db, p, SECRET, T0)]);
    const prize = DailySpinMath.pickPrize(await spinRoll(SECRET, p, Math.floor(T0 / DAY))).coins;
    expect([a.coins, b.coins]).toEqual([prize, prize]);
    expect(await coins()).toBe(10_000 + prize);
  });
});

describe('login track', () => {
  it('walks the 7-day catalogue, one claim a day', async () => {
    const d1 = await claimLogin(db, p, T0);
    expect(d1).toMatchObject({ claimed: true, day: 1 });
    expect(await coins()).toBe(10_500);
    expect((await claimLogin(db, p, T0 + 1000)).claimed).toBe(false);
    expect(await claimLogin(db, p, T0 + DAY)).toMatchObject({ claimed: true, day: 2 });
    expect(await coins()).toBe(11_250);
    const d3 = await claimLogin(db, p, T0 + 2 * DAY); // day 3 pays XP
    expect(d3.day).toBe(3);
    expect((await balances(db, p)).xp).toBe(100);
    expect(d3.progress.level).toBe(PlayerLevelMath.levelFromTotalXp(100));
  });

  it('spends a streak shield on a one-day gap, resets on a longer one', async () => {
    await claimLogin(db, p, T0);
    await post(db, [{ playerId: p, currency: 'streak_tokens', delta: 1, reason: 'test', idempotencyKey: 'shield' }]);
    const kept = await claimLogin(db, p, T0 + 2 * DAY);
    expect(kept).toMatchObject({ claimed: true, day: 2, tokenConsumed: true });
    expect((await balances(db, p)).streak_tokens).toBe(0);
    const reset = await claimLogin(db, p, T0 + 5 * DAY);
    expect(reset).toMatchObject({ claimed: true, day: 1, reset: true });
  });

  it('pays day 7 in full', async () => {
    for (let d = 0; d < 7; d++) await claimLogin(db, p, T0 + d * DAY);
    const all = (await entries(db, p, { limit: 50 })).entries.filter((e) => e.reason === 'login_reward');
    const coinsPaid = all.filter((e) => e.currency === 'coins').reduce((s, e) => s + e.delta, 0);
    const expected = LoginRewardCatalog.Days.flatMap((d) => [d.primary, d.secondary]).filter((g) => g && g.kind === 0).reduce((s, g) => s + g!.amount, 0);
    expect(coinsPaid).toBe(expected);
  });
});

describe('missions', () => {
  const hand = (n: number, won = false, cat: number | null = null) => recordHand(db, p, { tableId: 't1', hand: n, won, showdownCategory: cat, net: won ? 100 : -10 }, T0);

  it('counts hands on the server and pays a finished mission once', async () => {
    expect((await claimMission(db, p, 'daily_warmup_10', T0)).ok).toBe(false);
    for (let i = 1; i <= 10; i++) await hand(i);
    const before = await coins();
    const r = await claimMission(db, p, 'daily_warmup_10', T0);
    expect(r).toMatchObject({ ok: true, message: 'Claimed! +500 Coins, +50 XP' });
    expect(await coins()).toBe(before + 500);
    expect((await claimMission(db, p, 'daily_warmup_10', T0)).ok).toBe(false);
    // 10 hands x 10 XP + 50 = 150 XP: level 2, whose reward is paid by the server.
    expect((await balances(db, p)).xp).toBe(150);
    expect(r.progress.rewardedLevel).toBe(2);
  });

  it('pays a racing double claim once', async () => {
    for (let i = 1; i <= 10; i++) await hand(i);
    const before = await coins();
    const results = await Promise.all([claimMission(db, p, 'daily_warmup_10', T0), claimMission(db, p, 'daily_warmup_10', T0)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await coins()).toBe(before + 500);
  });

  it('counts a replayed hand once', async () => {
    await hand(1, true, HandCategory.TwoPair);
    await hand(1, true, HandCategory.TwoPair);
    const s = await snapshot(db, p, T0);
    expect(s.missions.slots.find((x) => x.id === 'daily_hot_hand_3')?.progress).toBe(1);
    expect(s.balances.xp).toBe(35);
  });

  it('only counts a pair or better when the player won with it', async () => {
    await hand(1, false, HandCategory.TwoPair);
    let s = await snapshot(db, p, T0);
    expect(s.missions.slots.find((x) => x.id === 'daily_pair_power')?.progress).toBe(0);
    await hand(2, true, HandCategory.Pair);
    s = await snapshot(db, p, T0);
    expect(s.missions.slots.find((x) => x.id === 'daily_pair_power')?.progress).toBe(1);
    expect(s.missions.slots.find((x) => x.id === 'weekly_two_pair_3')?.progress).toBe(0);
  });

  it('counts each table once a day toward Table Hopper', async () => {
    await recordTableJoined(db, p, 'poker-free', T0);
    await recordTableJoined(db, p, 'poker-free', T0);
    await recordTableJoined(db, p, 'poker-free-st50', T0);
    const s = await snapshot(db, p, T0);
    expect(s.missions.slots.find((x) => x.id === 'daily_table_tour_2')?.progress).toBe(2);
  });

  it('resets daily missions on a new UTC day and keeps the weekly ones', async () => {
    for (let i = 1; i <= 3; i++) await hand(i);
    const next = await snapshot(db, p, T0 + DAY);
    expect(next.missions.slots.find((x) => x.id === 'daily_warmup_10')?.progress).toBe(0);
    expect(next.missions.slots.find((x) => x.id === 'weekly_grinder_40')?.progress).toBe(next.missions.weekNumber === Math.trunc(Math.floor(T0 / DAY) / 7) ? 3 : 0);
  });
});

describe('levels', () => {
  it('pays every level crossed, a Coins bonus every 5 (the old Gems) and a cosmetic at 10, once', async () => {
    const xpFor10 = PlayerLevelMath.cumulativeXpForLevel(10);
    await post(db, [{ playerId: p, currency: 'xp', delta: xpFor10, reason: 'test', idempotencyKey: 'xp' }]);
    const before = await coins();
    const paid = await settleLevels(db, p, T0);
    expect(paid).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const expectedCoins = paid.flatMap((lv) => LevelRewardCatalog.rewardsForLevel(lv)).filter((g) => g.kind === 0).reduce((s, g) => s + g.amount, 0);
    expect(await coins()).toBe(before + expectedCoins);
    expect((await balances(db, p)).gems).toBe(0); // Gems are paid as Coins now
    expect((await snapshot(db, p, T0)).items).toEqual(['frame_lv10']);
    expect(await settleLevels(db, p, T0)).toEqual([]);
  });
});
