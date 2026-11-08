// Port of Poker.Core RewardGrant: what a reward pays out. Shared by retention (levels, login rewards, missions),
// the wallet and, later, the API's ledger.

export enum RewardKind {
  Coins = 0,
  Gems = 1,
  Xp = 2,
  Cosmetic = 3,
  StreakToken = 4,
}

export interface RewardGrant {
  readonly kind: RewardKind;
  readonly amount: number;
  readonly itemId: string;
  readonly source: string;
}

export const RewardGrant = {
  of: (kind: RewardKind, amount: number, itemId = '', source = ''): RewardGrant => Object.freeze({ kind, amount, itemId, source }),
  coins: (amount: number, source: string) => RewardGrant.of(RewardKind.Coins, amount, '', source),
  gems: (amount: number, source: string) => RewardGrant.of(RewardKind.Gems, amount, '', source),
  xp: (amount: number, source: string) => RewardGrant.of(RewardKind.Xp, amount, '', source),
  cosmetic: (itemId: string, source: string) => RewardGrant.of(RewardKind.Cosmetic, 1, itemId, source),
  streakToken: (amount: number, source: string) => RewardGrant.of(RewardKind.StreakToken, amount, '', source),
};
