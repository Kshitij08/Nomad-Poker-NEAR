/**
 * Configuration for a single-player table. Port of Game/TableSettings.cs. Times are seconds.
 */
export interface TableSettings {
  seatCount: number;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  playerName: string;
  botCount: number;
  /** Use a fixed RNG seed so hands replay identically. Bots are then seeded seed + seat * 101. */
  useFixedSeed: boolean;
  seed: number;
  botThinkMin: number;
  botThinkMax: number;
  /** Pause after each BlindPosted and each HoleCardsDealt event. */
  dealDelay: number;
  /** Pause after BettingRoundChanged(Preflop) and after each CommunityDealt, so cards settle before betting. */
  dealSettleDelay: number;
  /** Pause after each PlayerActed. */
  actionDelay: number;
  /** Pause after Showdown and after each PotAwarded. */
  showdownDelay: number;
  /** Pause between HandEnded and the next StartHand. */
  betweenHands: number;
  /** Seconds a seat has to act; on expiry: check if legal, else fold. */
  turnTimer: number;
}

/** TableSettings.cs field initialisers (what a fresh component gets). */
export const DEFAULT_TABLE_SETTINGS: Readonly<TableSettings> = Object.freeze({
  seatCount: 6,
  startingStack: 5000,
  smallBlind: 25,
  bigBlind: 50,
  playerName: 'You',
  botCount: 5,
  useFixedSeed: false,
  seed: 12345,
  botThinkMin: 0.6,
  botThinkMax: 1.4,
  dealDelay: 0.12,
  dealSettleDelay: 0.9,
  actionDelay: 0.4,
  showdownDelay: 2.0,
  betweenHands: 2.5,
  turnTimer: 15,
});

/**
 * The values actually serialized on PokerGameController in Assets/Test/Test.unity — the table scene in the build
 * (7 seats: you + 6 bots; 5 s deal settle). This is what "single player in Unity" plays like.
 */
export const TEST_SCENE_TABLE_SETTINGS: Readonly<TableSettings> = Object.freeze({
  ...DEFAULT_TABLE_SETTINGS,
  seatCount: 7,
  botCount: 6,
  dealSettleDelay: 5,
});
