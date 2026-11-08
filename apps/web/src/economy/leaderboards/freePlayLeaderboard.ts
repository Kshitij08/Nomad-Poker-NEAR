/**
 * Port of Game/Leaderboards/FreePlayLeaderboard.cs: free-play scores (virtual Coins only). Local counters always
 * update (same PlayerPrefs keys, weekly / monthly resets); PlayFab statistics are optional through
 * submitOverride / fetchOverride, which the PlayFab leaderboard bridge installs after sign-in.
 */
import { PlayerPrefs } from '../../app/services';
import { FreePlayLeaderboardMath, LeaderboardKind } from '@nomad/engine/leaderboards/freePlayLeaderboardMath';
import { Signal } from '../signal';

const WeekKey = 'Poker.LB.WeekId';
const SeasonKey = 'Poker.LB.SeasonId';
const WeeklyEarnKey = 'Poker.LB.WeeklyEarnings';
const WeeklyHandsKey = 'Poker.LB.WeeklyHandsWon';
const SeasonEarnKey = 'Poker.LB.SeasonEarnings';
const HandsWonKey = 'Poker.LB.HandsWon';

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  score: number;
  isLocal: boolean;
}

export interface LeaderboardSnapshot {
  kind: LeaderboardKind;
  title: string;
  status: string;
  localRank: number;
  localScore: number;
  pageIndex: number;
  pageSize: number;
  hasMore: boolean;
  rows: readonly LeaderboardEntry[];
}

let loaded = false;
let weeklyEarnings = 0;
let weeklyHandsWon = 0;
let seasonEarnings = 0;
let handsWon = 0;

function ensurePeriod(now = Date.now()): void {
  if (!loaded) {
    weeklyEarnings = PlayerPrefs.getInt(WeeklyEarnKey, 0);
    weeklyHandsWon = PlayerPrefs.getInt(WeeklyHandsKey, 0);
    seasonEarnings = PlayerPrefs.getInt(SeasonEarnKey, 0);
    handsWon = PlayerPrefs.getInt(HandsWonKey, 0);
    loaded = true;
  }
  const week = FreePlayLeaderboardMath.weekId(now);
  const season = FreePlayLeaderboardMath.seasonId(now);
  if (PlayerPrefs.getInt(WeekKey, 0) !== week) {
    weeklyEarnings = 0;
    weeklyHandsWon = 0;
    PlayerPrefs.setInt(WeekKey, week);
  }
  if (PlayerPrefs.getInt(SeasonKey, 0) !== season) {
    seasonEarnings = 0;
    PlayerPrefs.setInt(SeasonKey, season);
  }
}

function persist(): void {
  PlayerPrefs.setInt(WeeklyEarnKey, weeklyEarnings);
  PlayerPrefs.setInt(WeeklyHandsKey, weeklyHandsWon);
  PlayerPrefs.setInt(SeasonEarnKey, seasonEarnings);
  PlayerPrefs.setInt(HandsWonKey, handsWon);
}

export const FreePlayLeaderboard = {
  changed: new Signal(),
  /** kind, zero-based page → snapshot for that page (null = fall back to local). */
  fetchOverride: null as ((kind: LeaderboardKind, pageIndex: number) => Promise<LeaderboardSnapshot | null>) | null,
  submitOverride: null as (() => void) | null,
  localDisplayName: 'You',

  get weeklyEarnings(): number {
    ensurePeriod();
    return weeklyEarnings;
  },
  get weeklyHandsWon(): number {
    ensurePeriod();
    return weeklyHandsWon;
  },
  get seasonEarnings(): number {
    ensurePeriod();
    return seasonEarnings;
  },
  get handsWon(): number {
    ensurePeriod();
    return handsWon;
  },

  /** Called once per finished hand at a free-play table (PokerClientGame does in Unity). */
  recordHand(netChips: number, won: boolean): void {
    ensurePeriod();
    weeklyEarnings = FreePlayLeaderboardMath.addClamped(weeklyEarnings, netChips);
    seasonEarnings = FreePlayLeaderboardMath.addClamped(seasonEarnings, netChips);
    if (won) {
      weeklyHandsWon = FreePlayLeaderboardMath.addClamped(weeklyHandsWon, 1);
      handsWon = FreePlayLeaderboardMath.addClamped(handsWon, 1);
    }
    persist();
    FreePlayLeaderboard.submitOverride?.();
    FreePlayLeaderboard.changed.emit();
  },

  async fetchAsync(kind: LeaderboardKind, pageIndex = 0): Promise<LeaderboardSnapshot> {
    ensurePeriod();
    if (pageIndex < 0) pageIndex = 0;
    const override = FreePlayLeaderboard.fetchOverride;
    if (override) {
      try {
        const cloud = await override(kind, pageIndex);
        if (cloud) return cloud;
      } catch (e) {
        console.warn('[Leaderboard] Fetch failed', e);
      }
    }
    return localOnly(kind, pageIndex);
  },

  titleFor(kind: LeaderboardKind): string {
    switch (kind) {
      case LeaderboardKind.HandsWon: return 'Hands won';
      case LeaderboardKind.SeasonEarnings: return 'Season earnings';
      case LeaderboardKind.WeeklyHandsWon: return 'Hands won this week';
      case LeaderboardKind.FriendsWeekly: return 'Friends · weekly';
      default: return 'Weekly earnings';
    }
  },

  scoreColumnFor(kind: LeaderboardKind): string {
    return kind === LeaderboardKind.HandsWon || kind === LeaderboardKind.WeeklyHandsWon ? 'Wins' : 'Coins';
  },

  localScore(kind: LeaderboardKind): number {
    ensurePeriod();
    switch (kind) {
      case LeaderboardKind.HandsWon: return handsWon;
      case LeaderboardKind.SeasonEarnings: return seasonEarnings;
      case LeaderboardKind.WeeklyHandsWon: return weeklyHandsWon;
      default: return weeklyEarnings;
    }
  },

  statisticName(kind: LeaderboardKind): string {
    switch (kind) {
      case LeaderboardKind.HandsWon: return FreePlayLeaderboardMath.HandsWon;
      case LeaderboardKind.SeasonEarnings: return FreePlayLeaderboardMath.SeasonEarnings;
      case LeaderboardKind.WeeklyHandsWon: return FreePlayLeaderboardMath.WeeklyHandsWon;
      default: return FreePlayLeaderboardMath.WeeklyEarnings;
    }
  },

  /** EditorResetForTests. */
  resetForTests(): void {
    loaded = false;
    weeklyEarnings = weeklyHandsWon = seasonEarnings = handsWon = 0;
    FreePlayLeaderboard.fetchOverride = null;
    FreePlayLeaderboard.submitOverride = null;
  },
};

function localOnly(kind: LeaderboardKind, pageIndex: number): LeaderboardSnapshot {
  const name = FreePlayLeaderboard.localDisplayName || 'You';
  const score = FreePlayLeaderboard.localScore(kind);
  return {
    kind,
    title: FreePlayLeaderboard.titleFor(kind),
    status: 'Sign in to PlayFab to see global ranks.',
    localRank: 1,
    localScore: score,
    pageIndex,
    pageSize: FreePlayLeaderboardMath.PageSize,
    hasMore: false,
    rows: pageIndex === 0 ? [{ rank: 1, displayName: name, score, isLocal: true }] : [],
  };
}
