/**
 * Ports of the NUnit suites in Assets/Scripts/Tests (DailySpinMathTests, LoginStreakMathTests,
 * PlayerProgressionTests: PlayerLevelMathTests + MissionProgressMathTests), with the same golden values, plus
 * checks for the parts those suites do not cover (UtcDay, summaries, board string format).
 */
import { describe, expect, it } from 'vitest';
import { RewardKind } from '../../economy/rewards';
import {
  DailySpinCatalog, DailySpinMath, LevelRewardCatalog, LoginRewardCatalog, LoginStreakMath, MissionCatalog, MissionKind,
  MissionProgressMath, PlayerLevelMath, UtcDay, deserializeBoard, loginRewardSummary, rewardPreview, serializeBoard,
} from '..';

describe('DailySpinMath (DailySpinMathTests)', () => {
  it('CanSpin_OncePerUtcDay', () => {
    expect(DailySpinMath.canSpin(0, 20000)).toBe(true);
    expect(DailySpinMath.canSpin(19999, 20000)).toBe(true);
    expect(DailySpinMath.canSpin(20000, 20000)).toBe(false);
  });
  it('PickPrize_CoversTheWholeWeightTable', () => {
    expect(DailySpinCatalog.Prizes.reduce((a, p) => a + p.weight, 0)).toBe(DailySpinCatalog.WeightTotal);
    expect(DailySpinMath.pickPrize(0).coins).toBe(250);
    expect(DailySpinMath.pickPrize(279).coins).toBe(250);
    expect(DailySpinMath.pickPrize(280).coins).toBe(500);
    expect(DailySpinMath.pickPrize(999).coins).toBe(25000);
  });
  it('PickPrize_WrapsOutOfRangeRolls', () => {
    expect(DailySpinMath.pickPrize(1000).coins).toBe(DailySpinMath.pickPrize(0).coins);
    expect(DailySpinMath.pickPrize(-980).coins).toBe(DailySpinMath.pickPrize(20).coins);
  });
  it('PrizeIndex_FindsCatalogRow', () => {
    expect(DailySpinMath.prizeIndex(250)).toBe(0);
    expect(DailySpinMath.prizeIndex(25000)).toBe(6);
    expect(DailySpinMath.prizeIndex(1)).toBe(0);
  });
  it('every roll lands on the cumulative-weight row', () => {
    const counts = new Map<number, number>();
    for (let r = 0; r < 1000; r++) counts.set(DailySpinMath.pickPrize(r).coins, (counts.get(DailySpinMath.pickPrize(r).coins) ?? 0) + 1);
    for (const p of DailySpinCatalog.Prizes) expect(counts.get(p.coins)).toBe(p.weight);
  });
});

describe('LoginStreakMath (LoginStreakMathTests)', () => {
  it('FirstLogin_StartsDay1', () => {
    const p = LoginStreakMath.preview(0, 20000, 0, 1);
    expect([p.canClaim, p.day, p.tokenConsumed, p.reset]).toEqual([true, 1, false, false]);
  });
  it('SameDay_IsAlreadyClaimed', () => {
    const p = LoginStreakMath.preview(20000, 20000, 3, 2);
    expect([p.canClaim, p.day, p.tokensAfter]).toEqual([false, 3, 2]);
    expect(p.error).toBe("Today's login reward is already claimed.");
  });
  it('ConsecutiveDay_AdvancesAndWrapsAfterSeven', () => {
    const d2 = LoginStreakMath.preview(20000, 20001, 1, 0);
    expect([d2.canClaim, d2.day]).toEqual([true, 2]);
    expect(LoginStreakMath.preview(20000, 20001, 7, 0).day).toBe(1);
  });
  it('MissedOneDay_ConsumesATokenInsteadOfResetting', () => {
    const p = LoginStreakMath.preview(20000, 20002, 3, 1);
    expect([p.canClaim, p.day, p.tokenConsumed, p.tokensAfter, p.reset]).toEqual([true, 4, true, 0, false]);
  });
  it('MissedOneDay_WithoutToken_ResetsToDay1', () => {
    const p = LoginStreakMath.preview(20000, 20002, 3, 0);
    expect([p.canClaim, p.day, p.tokenConsumed, p.reset]).toEqual([true, 1, false, true]);
  });
  it('MissedTwoDays_ResetsEvenWithTokens', () => {
    const p = LoginStreakMath.preview(20000, 20003, 5, 3);
    expect([p.canClaim, p.day, p.tokenConsumed, p.reset, p.tokensAfter]).toEqual([true, 1, false, true, 3]);
  });
  it('Catalog_HasSevenIncreasingDays', () => {
    expect(LoginRewardCatalog.Days.length).toBe(7);
    expect(LoginRewardCatalog.day(1).primary.kind).toBe(RewardKind.Coins);
    expect(LoginRewardCatalog.day(3).primary.kind).toBe(RewardKind.Xp);
    expect(LoginRewardCatalog.day(5).primary.kind).toBe(RewardKind.Xp);
    expect(LoginRewardCatalog.day(5).secondary).toBeNull();
    expect(LoginRewardCatalog.day(7).primary.kind).toBe(RewardKind.Coins);
    expect(LoginRewardCatalog.day(7).secondary!.kind).toBe(RewardKind.Xp);
    expect(LoginRewardCatalog.day(7).tertiary).toBeNull();
  });
  it('Summary formats like the C# (N0 amounts)', () => {
    expect(loginRewardSummary(LoginRewardCatalog.day(4))).toBe('1,000 Coins');
    expect(loginRewardSummary(LoginRewardCatalog.day(7))).toBe('5,000 Coins + 500 XP');
    expect(() => LoginRewardCatalog.day(8)).toThrow(RangeError);
  });
});

describe('PlayerLevelMath (PlayerLevelMathTests)', () => {
  it('Level1_AtZeroXp', () => {
    expect(PlayerLevelMath.levelFromTotalXp(0)).toBe(1);
    expect(PlayerLevelMath.xpIntoCurrentLevel(0)).toBe(0);
    expect(PlayerLevelMath.xpRemainingToNext(0)).toBe(100);
  });
  it('CrossingFirstThreshold_ReachesLevel2', () => {
    expect(PlayerLevelMath.levelFromTotalXp(99)).toBe(1);
    expect(PlayerLevelMath.levelFromTotalXp(100)).toBe(2);
    expect(PlayerLevelMath.xpIntoCurrentLevel(100)).toBe(0);
    expect(PlayerLevelMath.xpRemainingToNext(100)).toBe(200);
  });
  it('CumulativeMatchesSumOfSteps', () => {
    expect(PlayerLevelMath.cumulativeXpForLevel(1)).toBe(0);
    expect(PlayerLevelMath.cumulativeXpForLevel(2)).toBe(100);
    expect(PlayerLevelMath.cumulativeXpForLevel(3)).toBe(300);
    expect(PlayerLevelMath.cumulativeXpForLevel(4)).toBe(600);
  });
  it('Progress01 is float division', () => {
    expect(PlayerLevelMath.progress01(50)).toBe(Math.fround(0.5));
    expect(PlayerLevelMath.progress01(100 + 70)).toBe(Math.fround(Math.fround(70) / Math.fround(200)));
    expect(PlayerLevelMath.progress01(300 + 100)).toBe(Math.fround(100 / 300));
  });
  it('LevelReward_EveryLevelGivesCoins', () => {
    const r = LevelRewardCatalog.rewardsForLevel(2);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.kind).toBe(RewardKind.Coins);
    expect(r[0]!.amount).toBe(125);
  });
  it('LevelReward_MilestoneGems', () => {
    const r = LevelRewardCatalog.rewardsForLevel(5);
    expect(r.length).toBe(2);
    expect(r[1]!.kind).toBe(RewardKind.Gems);
    const ten = LevelRewardCatalog.rewardsForLevel(10);
    expect(ten.map((g) => [g.kind, g.amount, g.itemId])).toEqual([[RewardKind.Coins, 650, ''], [RewardKind.Gems, 5, ''], [RewardKind.Cosmetic, 1, 'frame_lv10']]);
    expect(LevelRewardCatalog.rewardsForLevel(1)).toEqual([]);
  });
});

describe('MissionProgressMath (MissionProgressMathTests)', () => {
  const find = (b: ReturnType<typeof MissionProgressMath.ensureFresh>, id: string) => MissionProgressMath.find(b, id)!;
  it('EnsureFresh_SeedsDailyAndWeekly', () => {
    const b = MissionProgressMath.ensureFresh(null, 20000);
    expect(b.slots.length).toBe(8);
    expect(b.dayNumber).toBe(20000);
    expect(b.weekNumber).toBe(MissionProgressMath.weekFromDay(20000));
  });
  it('Catalog_HasZyngaStyleDailyAndWeekly', () => {
    expect(MissionCatalog.Daily.length).toBe(5);
    expect(MissionCatalog.Weekly.length).toBe(3);
    const warm = MissionCatalog.tryGet('daily_warmup_10')!;
    expect(warm.target).toBe(10);
    expect(warm.rewards.length).toBeGreaterThan(0);
    const wk = MissionCatalog.tryGet('weekly_collector_12')!;
    expect(wk.weekly).toBe(true);
    expect(wk.kind).toBe(MissionKind.WinHands);
  });
  it('Advance_PlayHands_CapsAtTarget', () => {
    const b = MissionProgressMath.ensureFresh(null, 100);
    expect(MissionProgressMath.advance(b, MissionKind.PlayHands, 25, 100)).toBe(true);
    expect(find(b, 'daily_warmup_10').progress).toBe(10);
  });
  it('FriendMission_AdvancesAndIsClaimable', () => {
    const b = MissionProgressMath.ensureFresh(null, 100);
    expect(MissionProgressMath.advance(b, MissionKind.PlayWithFriend, 1, 100)).toBe(true);
    expect(find(b, 'daily_buddy').progress).toBe(1);
    const r = MissionProgressMath.tryClaim(b, 'daily_buddy', 100)!;
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.kind).toBe(RewardKind.Coins);
  });
  it('WinHands_AdvancesDailyAndWeeklyTogether', () => {
    const b = MissionProgressMath.ensureFresh(null, 100);
    expect(MissionProgressMath.advance(b, MissionKind.WinHands, 3, 100)).toBe(true);
    expect(find(b, 'daily_hot_hand_3').progress).toBe(3);
    expect(find(b, 'weekly_collector_12').progress).toBe(3);
    expect(MissionProgressMath.tryClaim(b, 'daily_hot_hand_3', 100)![0]!.amount).toBe(750);
  });
  it('Claim_RequiresTargetThenMarksClaimed', () => {
    const b = MissionProgressMath.ensureFresh(null, 50);
    expect(MissionProgressMath.tryClaim(b, 'daily_warmup_10', 50)).toBeNull();
    MissionProgressMath.advance(b, MissionKind.WinPairOrBetter, 1, 50);
    expect(MissionProgressMath.tryClaim(b, 'daily_pair_power', 50)!.length).toBeGreaterThan(0);
    expect(find(b, 'daily_pair_power').claimed).toBe(true);
    expect(MissionProgressMath.tryClaim(b, 'daily_pair_power', 50)).toBeNull();
  });
  it('TwoPair_AdvancesWeeklyTwoPairClub', () => {
    const b = MissionProgressMath.ensureFresh(null, 50);
    MissionProgressMath.advance(b, MissionKind.WinTwoPairOrBetter, 3, 50);
    expect(find(b, 'weekly_two_pair_3').progress).toBe(3);
    const r = MissionProgressMath.tryClaim(b, 'weekly_two_pair_3', 50)!;
    expect([r[0]!.kind, r[0]!.amount]).toEqual([RewardKind.Coins, 2000]);
  });
  it('DayRollover_ResetsDailyKeepsWeeklyWithinWeek', () => {
    let b = MissionProgressMath.ensureFresh(null, 70);
    MissionProgressMath.advance(b, MissionKind.PlayHands, 5, 70);
    MissionProgressMath.advance(b, MissionKind.WeeklyHands, 10, 70);
    b = MissionProgressMath.ensureFresh(b, 71);
    expect(find(b, 'daily_warmup_10').progress).toBe(0);
    expect(find(b, 'weekly_grinder_40').progress).toBe(10);
    b = MissionProgressMath.ensureFresh(b, 77); // week 11
    expect(find(b, 'weekly_grinder_40').progress).toBe(0);
  });
  it('TableCount_OncePerSessionName', () => {
    const b = MissionProgressMath.ensureFresh(null, 10);
    expect(MissionProgressMath.tryCountTable(b, 'poker-free-st100', 10)).toBe(true);
    expect(MissionProgressMath.tryCountTable(b, 'poker-free-st100', 10)).toBe(false);
    expect(find(b, 'daily_table_tour_2').progress).toBe(1);
  });
  it('RewardPreview_FormatsCoinsXpGems', () => {
    // NUnit asserts "Gems" here, but the C# writes " Gem" for an amount of 1, so that NUnit test fails in Unity too.
    // The port follows the C# code, not the stale assertion.
    expect(rewardPreview(MissionCatalog.tryGet('daily_pair_power')!)).toBe('+300 Coins, +30 XP, +1 Gem');
    expect(rewardPreview(MissionCatalog.tryGet('weekly_collector_12')!)).toBe('+3000 Coins, +250 XP, +3 Gems');
  });
});

describe('UtcDay and board persistence', () => {
  it('counts whole UTC days from the epoch', () => {
    expect(UtcDay.fromUtc(Date.UTC(1970, 0, 1, 23, 59, 59))).toBe(0);
    expect(UtcDay.fromUtc(Date.UTC(2024, 9, 3, 23, 59, 59, 999))).toBe(19999);
    expect(UtcDay.fromUtc(Date.UTC(2024, 9, 4, 12))).toBe(20000);
    expect(UtcDay.toDate(20000).toISOString()).toBe('2024-10-04T00:00:00.000Z');
  });
  it('round-trips the PlayerPrefs board string', () => {
    const b = MissionProgressMath.ensureFresh(null, 20000);
    MissionProgressMath.advance(b, MissionKind.PlayHands, 3, 20000);
    MissionProgressMath.tryCountTable(b, 'room-a', 20000);
    const s = serializeBoard(b);
    expect(s).toBe('20000|2857|daily_warmup_10:3:0,daily_hot_hand_3:0:0,daily_table_tour_2:1:0,daily_pair_power:0:0,daily_buddy:0:0,weekly_grinder_40:0:0,weekly_collector_12:0:0,weekly_two_pair_3:0:0|room-a');
    expect(deserializeBoard(s)).toEqual(b);
    expect(deserializeBoard('')).toEqual({ dayNumber: 0, weekNumber: 0, slots: [], tablesToday: [] });
    expect(deserializeBoard('x|y|a:b').dayNumber).toBe(0);
  });
});
