import { ArgumentOutOfRangeError } from '../errors';

/**
 * The fixed numbers of a hosted round-format tournament (design doc v0.5). One place, so the director, the server
 * and the tests agree. Port of Core/Tournament/TournamentRules.cs.
 */
export const TournamentRules = {
  /** Every player starts every round with this many tournament chips. */
  StartingStack: 5000,
  /** Fewer registrants than this at the start time cancels the tournament. */
  MinEntrants: 2,
  MaxEntrants: 30,
  /** Up to this many play a single table straight to heads-up — no rounds. */
  SingleTableMaxEntrants: 7,
  /** Up to this many play two Round 1 tables, then the final. */
  TwoTableMaxEntrants: 15,
  SeatsPerTable: 8,
  /** A Round 1 or Round 2 table stops when this many are left; they go through. */
  SurvivorsPerTable: 2,
  /** Delay between the draw at the start time and the first hands. */
  FirstDealDelayMs: 15_000,
  /** Countdown before a next-round table deals, so waiting players can get back. */
  NextTableCountdownMs: 60_000,
  /** Share of the net pool paid to 1st, in basis points. 2nd gets the rest. */
  FirstPlaceBps: 6000,
} as const;

/** The host's blind speed: how long each blind level lasts. Port of TournamentSpeed.cs. */
export enum TournamentSpeed {
  Turbo = 0,
  Regular = 1,
  Slow = 2,
}

/** TournamentSpeedExtensions.LevelMs. */
export function speedLevelMs(speed: TournamentSpeed): number {
  switch (speed) {
    case TournamentSpeed.Turbo: return 5 * 60_000;
    case TournamentSpeed.Regular: return 8 * 60_000;
    case TournamentSpeed.Slow: return 12 * 60_000;
    default: throw new ArgumentOutOfRangeError(`speed: ${String(speed)}`);
  }
}

/** The backend's speed strings ("turbo" / "regular" / "slow"), as TournamentServerGame.ApplyRoster reads them. */
export function speedFromString(s: string | null | undefined): TournamentSpeed {
  return s === 'turbo' ? TournamentSpeed.Turbo : s === 'slow' ? TournamentSpeed.Slow : TournamentSpeed.Regular;
}

/** Tournament XP (design doc §9). Port of TournamentRewards.cs. */
export const TournamentRewards = {
  PlayXp: 20,
  RoundPassedXp: 15,
  ChampionXp: 150,
  HostXp: 100,
  HostXpMinEntrants: 16,
  playerXp(roundsPassed: number, champion: boolean): number {
    return TournamentRewards.PlayXp + TournamentRewards.RoundPassedXp * (roundsPassed < 0 ? 0 : roundsPassed) + (champion ? TournamentRewards.ChampionXp : 0);
  },
  hostXpFor(entrants: number, finished: boolean): number {
    return finished && entrants >= TournamentRewards.HostXpMinEntrants ? TournamentRewards.HostXp : 0;
  },
} as const;
