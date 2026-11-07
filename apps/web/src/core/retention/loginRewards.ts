/**
 * 7-day login track and streak rules. Ports of Core/Retention/LoginRewardCatalog.cs and LoginStreakMath.cs.
 * Missing a single day consumes a Streak Protection Token instead of resetting; a gap of two or more days always
 * resets, even if tokens remain. After day 7 the track wraps to day 1.
 */
import { RewardGrant, RewardKind } from '../../app/services';
import { formatN0 } from '../util/dotnetMath';

export interface LoginDayReward {
  readonly day: number;
  readonly title: string;
  readonly primary: RewardGrant;
  readonly secondary: RewardGrant | null;
  readonly tertiary: RewardGrant | null;
}

const SOURCE = 'login_reward';

function formatGrant(g: RewardGrant): string {
  switch (g.kind) {
    case RewardKind.Coins:
      return `${formatN0(g.amount)} Coins`;
    case RewardKind.Gems:
      return g.amount === 1 ? '1 Gem' : `${formatN0(g.amount)} Gems`;
    case RewardKind.Xp:
      return `${formatN0(g.amount)} XP`;
    case RewardKind.StreakToken:
      return g.amount === 1 ? 'Streak Shield' : `${g.amount} Streak Shields`;
    case RewardKind.Cosmetic:
      return 'Cosmetic';
    default:
      return String(RewardKind[g.kind] ?? g.kind);
  }
}

/** LoginDayReward.Summary(): "5,000 Coins + 500 XP". */
export function loginRewardSummary(r: LoginDayReward): string {
  let text = formatGrant(r.primary);
  if (r.secondary) text += ' + ' + formatGrant(r.secondary);
  if (r.tertiary) text += ' + ' + formatGrant(r.tertiary);
  return text;
}

const day = (n: number, primary: RewardGrant, secondary: RewardGrant | null = null): LoginDayReward =>
  Object.freeze({ day: n, title: `Day ${n}`, primary, secondary, tertiary: null });

export const LoginRewardCatalog = {
  TrackLength: 7,
  Source: SOURCE,
  Days: Object.freeze([
    day(1, RewardGrant.coins(500, SOURCE)),
    day(2, RewardGrant.coins(750, SOURCE)),
    day(3, RewardGrant.xp(100, SOURCE)),
    day(4, RewardGrant.coins(1000, SOURCE)),
    day(5, RewardGrant.xp(250, SOURCE)),
    day(6, RewardGrant.coins(2500, SOURCE)),
    day(7, RewardGrant.coins(5000, SOURCE), RewardGrant.xp(500, SOURCE)),
  ]) as readonly LoginDayReward[],

  day(dayNumber: number): LoginDayReward {
    if (dayNumber < 1 || dayNumber > LoginRewardCatalog.TrackLength) throw new RangeError('dayNumber');
    return LoginRewardCatalog.Days[dayNumber - 1]!;
  },
};

export interface LoginClaimPreview {
  readonly canClaim: boolean;
  readonly day: number;
  readonly tokensAfter: number;
  readonly tokenConsumed: boolean;
  readonly reset: boolean;
  readonly error: string;
}

export const LoginClaimPreview = {
  alreadyClaimed: (d: number, tokens: number): LoginClaimPreview => ({
    canClaim: false,
    day: d < 1 ? 1 : d,
    tokensAfter: tokens,
    tokenConsumed: false,
    reset: false,
    error: "Today's login reward is already claimed.",
  }),
  claim: (d: number, tokensAfter: number, tokenConsumed: boolean, reset: boolean): LoginClaimPreview => ({
    canClaim: true,
    day: d,
    tokensAfter,
    tokenConsumed,
    reset,
    error: '',
  }),
  /** C# preview.Reward. */
  reward: (p: LoginClaimPreview): LoginDayReward => LoginRewardCatalog.day(p.day),
};

export const LoginStreakMath = {
  preview(lastLoginDay: number, todayDay: number, streakDay: number, tokens: number): LoginClaimPreview {
    if (todayDay <= 0) todayDay = 0;
    if (lastLoginDay === todayDay && lastLoginDay !== 0) return LoginClaimPreview.alreadyClaimed(streakDay, tokens);
    if (lastLoginDay <= 0) return LoginClaimPreview.claim(1, tokens, false, false);
    const gap = todayDay - lastLoginDay;
    if (gap <= 0) return LoginClaimPreview.alreadyClaimed(streakDay, tokens);
    if (gap === 1) return LoginClaimPreview.claim(LoginStreakMath.nextDay(streakDay), tokens, false, false);
    if (gap === 2 && tokens > 0) return LoginClaimPreview.claim(LoginStreakMath.nextDay(streakDay), tokens - 1, true, false);
    return LoginClaimPreview.claim(1, tokens, false, true);
  },

  nextDay(streakDay: number): number {
    if (streakDay < 1 || streakDay >= LoginRewardCatalog.TrackLength) return 1;
    return streakDay + 1;
  },
};
