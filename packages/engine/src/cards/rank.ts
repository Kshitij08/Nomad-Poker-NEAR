/**
 * Card ranks. Numeric values double as comparison weights (Ace high = 14).
 * Ace-low straights (the "wheel") are handled explicitly in HandEvaluator.
 * Port of Assets/Scripts/Core/Cards/Rank.cs.
 */
export enum Rank {
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9,
  Ten = 10,
  Jack = 11,
  Queen = 12,
  King = 13,
  Ace = 14,
}
