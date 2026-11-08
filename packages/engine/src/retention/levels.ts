/**
 * Account level from total XP, and level-up rewards. Ports of Core/Retention/PlayerLevelMath.cs and
 * LevelRewardCatalog.cs. Level 1 starts at 0 XP; going from level L to L+1 costs 100 * L.
 */
import { RewardGrant } from '../economy/rewards';

export const PlayerLevelMath = {
  XpPerLevelFactor: 100,
  MinLevel: 1,

  xpToReachNext(level: number): number {
    if (level < PlayerLevelMath.MinLevel) level = PlayerLevelMath.MinLevel;
    return PlayerLevelMath.XpPerLevelFactor * level;
  },

  cumulativeXpForLevel(level: number): number {
    if (level <= PlayerLevelMath.MinLevel) return 0;
    const n = level - 1;
    // C# long arithmetic: 100 * n * (n + 1) / 2 (exact: the product is always even).
    return (PlayerLevelMath.XpPerLevelFactor * n * (n + 1)) / 2;
  },

  levelFromTotalXp(totalXp: number): number {
    if (totalXp < 0) totalXp = 0;
    let level = PlayerLevelMath.MinLevel;
    for (;;) {
      const need = PlayerLevelMath.xpToReachNext(level);
      if (totalXp < need) return level;
      totalXp -= need;
      level++;
      if (level > 10_000) return level; // safety
    }
  },

  xpIntoCurrentLevel(totalXp: number): number {
    if (totalXp < 0) totalXp = 0;
    const level = PlayerLevelMath.levelFromTotalXp(totalXp);
    return totalXp - PlayerLevelMath.cumulativeXpForLevel(level);
  },

  xpRemainingToNext(totalXp: number): number {
    const level = PlayerLevelMath.levelFromTotalXp(totalXp);
    const into = PlayerLevelMath.xpIntoCurrentLevel(totalXp);
    return Math.max(0, PlayerLevelMath.xpToReachNext(level) - into);
  },

  /** 0..1 progress through the current level (C# float division, so Math.fround). */
  progress01(totalXp: number): number {
    const level = PlayerLevelMath.levelFromTotalXp(totalXp);
    const need = PlayerLevelMath.xpToReachNext(level);
    if (need <= 0) return 1;
    const v = Math.fround(Math.fround(PlayerLevelMath.xpIntoCurrentLevel(totalXp)) / Math.fround(need));
    return v < 0 ? 0 : v > 1 ? 1 : v;
  },
};

export const LevelRewardCatalog = {
  /** Coins for every level-up; Gems every 5 levels; a cosmetic id every 10 levels. */
  rewardsForLevel(level: number): RewardGrant[] {
    if (level <= 1) return [];
    const coins = 100 + (level - 1) * 25;
    if (level % 10 === 0) {
      return [
        RewardGrant.coins(coins * 2, 'level_up'),
        RewardGrant.gems(5, 'level_up'),
        RewardGrant.cosmetic('frame_lv' + level, 'level_up'),
      ];
    }
    if (level % 5 === 0) return [RewardGrant.coins(coins, 'level_up'), RewardGrant.gems(2, 'level_up')];
    return [RewardGrant.coins(coins, 'level_up')];
  },
};
