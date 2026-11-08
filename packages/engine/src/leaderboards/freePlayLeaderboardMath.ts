/**
 * Port of Core/Leaderboards/FreePlayLeaderboardMath.cs: week / season buckets and PlayFab int clamping for the
 * free-play leaderboards. Rankings stay on virtual Coins — never SOL cash-table results.
 */
export enum LeaderboardKind {
  WeeklyEarnings = 0,
  HandsWon = 1,
  SeasonEarnings = 2,
  WeeklyHandsWon = 3,
  FriendsWeekly = 4,
}

const INT_MAX = 2147483647;
const INT_MIN = -2147483648;
const DAY_MS = 86_400_000;

/** Midnight UTC of the given instant's day (DateTime.Date for a UTC DateTime). */
const utcDate = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
/** Days to subtract to reach the Monday on/before: C# `-((int)DayOfWeek + 6) % 7` (Sunday = 0). */
const toMonday = (dayMs: number): number => dayMs + ((-(new Date(dayMs).getUTCDay() + 6)) % 7) * DAY_MS;

function weekOfYear(mondayMs: number): number {
  const year = new Date(mondayMs).getUTCFullYear();
  let firstMonday = toMonday(Date.UTC(year, 0, 1));
  if (new Date(firstMonday).getUTCFullYear() < year) firstMonday += 7 * DAY_MS;
  const week = 1 + Math.trunc(Math.round((mondayMs - firstMonday) / DAY_MS) / 7);
  return week < 1 ? 1 : week;
}

export const FreePlayLeaderboardMath = {
  /** Rows requested per GetLeaderboard page (UI + PlayFab MaxResultsCount). */
  PageSize: 10,

  WeeklyEarnings: 'FP_WeeklyEarnings',
  HandsWon: 'FP_HandsWon',
  WeeklyHandsWon: 'FP_WeeklyHandsWon',
  SeasonEarnings: 'FP_SeasonEarnings',

  /** ISO-like UTC week id: YYYYWW (Monday-start week of year). `utc` is epoch ms or a Date. */
  weekId(utc: number | Date): number {
    const monday = toMonday(utcDate(+utc));
    return new Date(monday).getUTCFullYear() * 100 + weekOfYear(monday);
  },

  /** Calendar month as a season until LiveOps supplies a named season. YYYYMM. */
  seasonId(utc: number | Date): number {
    const d = new Date(+utc);
    return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
  },

  clampScore(value: number): number {
    if (value > INT_MAX) return INT_MAX;
    if (value < INT_MIN) return INT_MIN;
    return Math.trunc(value);
  },

  addClamped(current: number, delta: number): number {
    return FreePlayLeaderboardMath.clampScore(current + delta);
  },
};
