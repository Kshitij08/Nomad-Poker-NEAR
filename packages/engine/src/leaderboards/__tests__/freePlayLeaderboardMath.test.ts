/** Port of Assets/Scripts/Tests/FreePlayLeaderboardMathTests.cs, plus week ids worked out from the C# algorithm. */
import { describe, expect, it } from 'vitest';
import { FreePlayLeaderboardMath as M } from '../freePlayLeaderboardMath';

describe('FreePlayLeaderboardMathTests', () => {
  it('WeekId_MondayStartsTheWeek', () => {
    expect(M.weekId(Date.UTC(2026, 8, 21, 0, 0, 0))).toBe(M.weekId(Date.UTC(2026, 8, 27, 12, 0, 0)));
  });

  it('WeekId_NextMondayIsNewWeek', () => {
    expect(M.weekId(Date.UTC(2026, 8, 27))).not.toBe(M.weekId(Date.UTC(2026, 8, 28)));
  });

  it('SeasonId_IsYearMonth', () => {
    expect(M.seasonId(Date.UTC(2026, 8, 23))).toBe(202609);
  });

  it('AddClamped_DoesNotOverflow', () => {
    expect(M.addClamped(2147483647, 50)).toBe(2147483647);
    expect(M.addClamped(-2147483648, -50)).toBe(-2147483648);
    expect(M.addClamped(10, 15)).toBe(25);
  });

  it('StatisticNames_AreStable', () => {
    expect(M.WeeklyEarnings).toBe('FP_WeeklyEarnings');
    expect(M.HandsWon).toBe('FP_HandsWon');
    expect(M.SeasonEarnings).toBe('FP_SeasonEarnings');
    expect(M.WeeklyHandsWon).toBe('FP_WeeklyHandsWon');
  });

  it('PageSize_IsTen', () => {
    expect(M.PageSize).toBe(10);
  });

  it('WeekId golden values (C# WeekOfYear: weeks counted from the first Monday of the Monday\'s year)', () => {
    // 2026-01-05 is the first Monday of 2026; 2026-09-21 is 37 weeks later.
    expect(M.weekId(Date.UTC(2026, 8, 21))).toBe(202638);
    expect(M.weekId(Date.UTC(2026, 0, 5))).toBe(202601);
    // Thu 2026-01-01 belongs to Monday 2025-12-29: week 52 of 2025 (first Monday of 2025 is 2025-01-06).
    expect(M.weekId(Date.UTC(2026, 0, 1, 23, 59))).toBe(202552);
    // 2024-01-01 is a Monday: week 1.
    expect(M.weekId(Date.UTC(2024, 0, 1))).toBe(202401);
    expect(M.weekId(Date.UTC(2024, 0, 7, 23, 59, 59))).toBe(202401);
    expect(M.weekId(Date.UTC(2024, 0, 8))).toBe(202402);
  });
});
