/** Poker hand rankings, ordered so a higher value always beats a lower one. Port of HandCategory.cs. */
export enum HandCategory {
  HighCard = 0,
  Pair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8, // includes the royal flush (T-J-Q-K-A)
}
