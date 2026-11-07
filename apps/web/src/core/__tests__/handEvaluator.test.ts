// Port of Assets/Scripts/Tests/HandEvaluatorTests.cs (+ describe() strings).
import { describe, expect, it } from 'vitest';
import { Card, HandCategory, HandEvaluator, Rank, Suit } from '../index';

const C = (r: Rank, s: Suit) => new Card(r, s);
const evalCards = (...cards: Card[]) => HandEvaluator.evaluate(cards);
const H = (s: string) => HandEvaluator.evaluate(s.split(' ').map(Card.parse));

describe('HandEvaluator', () => {
  it('royal flush is a straight flush, ace high', () => {
    const v = evalCards(C(Rank.Ten, Suit.Hearts), C(Rank.Jack, Suit.Hearts), C(Rank.Queen, Suit.Hearts), C(Rank.King, Suit.Hearts), C(Rank.Ace, Suit.Hearts));
    expect(v.category).toBe(HandCategory.StraightFlush);
    expect(v.t0).toBe(14);
    expect(v.describe()).toBe('Royal Flush');
  });

  it('wheel is a five-high straight', () => {
    const v = evalCards(C(Rank.Ace, Suit.Hearts), C(Rank.Two, Suit.Clubs), C(Rank.Three, Suit.Diamonds), C(Rank.Four, Suit.Spades), C(Rank.Five, Suit.Hearts));
    expect(v.category).toBe(HandCategory.Straight);
    expect(v.t0).toBe(5);
    expect(v.describe()).toBe('Straight, Five high');
  });

  it('full house beats flush', () => {
    const fullHouse = evalCards(C(Rank.King, Suit.Hearts), C(Rank.King, Suit.Clubs), C(Rank.King, Suit.Spades), C(Rank.Two, Suit.Diamonds), C(Rank.Two, Suit.Hearts));
    const flush = evalCards(C(Rank.Ace, Suit.Spades), C(Rank.Jack, Suit.Spades), C(Rank.Nine, Suit.Spades), C(Rank.Six, Suit.Spades), C(Rank.Three, Suit.Spades));
    expect(fullHouse.category).toBe(HandCategory.FullHouse);
    expect(flush.category).toBe(HandCategory.Flush);
    expect(fullHouse.gt(flush)).toBe(true);
    expect(fullHouse.describe()).toBe('Full House, Kings full of Twos');
  });

  it('flush beats straight', () => {
    const flush = evalCards(C(Rank.Ace, Suit.Clubs), C(Rank.Ten, Suit.Clubs), C(Rank.Seven, Suit.Clubs), C(Rank.Four, Suit.Clubs), C(Rank.Two, Suit.Clubs));
    const straight = evalCards(C(Rank.Five, Suit.Hearts), C(Rank.Six, Suit.Clubs), C(Rank.Seven, Suit.Diamonds), C(Rank.Eight, Suit.Spades), C(Rank.Nine, Suit.Hearts));
    expect(flush.gt(straight)).toBe(true);
  });

  it('higher pair wins', () => {
    const aces = evalCards(C(Rank.Ace, Suit.Hearts), C(Rank.Ace, Suit.Clubs), C(Rank.Five, Suit.Spades), C(Rank.Nine, Suit.Diamonds), C(Rank.King, Suit.Hearts));
    const kings = evalCards(C(Rank.King, Suit.Hearts), C(Rank.King, Suit.Clubs), C(Rank.Five, Suit.Spades), C(Rank.Nine, Suit.Diamonds), C(Rank.Queen, Suit.Hearts));
    expect(aces.category).toBe(HandCategory.Pair);
    expect(aces.gt(kings)).toBe(true);
    expect(aces.describe()).toBe('Pair of Aces');
  });

  it('kicker decides a tie', () => {
    const aceKing = evalCards(C(Rank.Ace, Suit.Hearts), C(Rank.Ace, Suit.Clubs), C(Rank.King, Suit.Spades), C(Rank.Three, Suit.Diamonds), C(Rank.Two, Suit.Hearts));
    const aceQueen = evalCards(C(Rank.Ace, Suit.Diamonds), C(Rank.Ace, Suit.Spades), C(Rank.Queen, Suit.Spades), C(Rank.Three, Suit.Clubs), C(Rank.Two, Suit.Clubs));
    expect(aceKing.gt(aceQueen)).toBe(true);
  });

  it('identical ranks with different suits tie', () => {
    const a = evalCards(C(Rank.Ace, Suit.Hearts), C(Rank.King, Suit.Clubs), C(Rank.Queen, Suit.Spades), C(Rank.Jack, Suit.Diamonds), C(Rank.Nine, Suit.Hearts));
    const b = evalCards(C(Rank.Ace, Suit.Clubs), C(Rank.King, Suit.Diamonds), C(Rank.Queen, Suit.Hearts), C(Rank.Jack, Suit.Spades), C(Rank.Nine, Suit.Diamonds));
    expect(a.equals(b)).toBe(true);
    expect(a.describe()).toBe('High Card, Ace');
  });

  it('seven cards: picks the best five', () => {
    const hole = [C(Rank.Ace, Suit.Spades), C(Rank.King, Suit.Spades)];
    const board = [C(Rank.Queen, Suit.Spades), C(Rank.Two, Suit.Spades), C(Rank.Seven, Suit.Spades), C(Rank.Nine, Suit.Hearts), C(Rank.Three, Suit.Clubs)];
    const v = HandEvaluator.evaluateHand(hole, board);
    expect(v.category).toBe(HandCategory.Flush);
    expect(v.t0).toBe(14);
    expect(v.describe()).toBe('Flush, Ace high');
  });

  it('two pair beats pair; quads beat a full house', () => {
    const twoPair = evalCards(C(Rank.Ten, Suit.Hearts), C(Rank.Ten, Suit.Clubs), C(Rank.Four, Suit.Spades), C(Rank.Four, Suit.Diamonds), C(Rank.Ace, Suit.Hearts));
    const pair = evalCards(C(Rank.Ace, Suit.Hearts), C(Rank.Ace, Suit.Clubs), C(Rank.King, Suit.Spades), C(Rank.Nine, Suit.Diamonds), C(Rank.Two, Suit.Hearts));
    expect(twoPair.category).toBe(HandCategory.TwoPair);
    expect(twoPair.gt(pair)).toBe(true);
    expect(twoPair.describe()).toBe('Two Pair, Tens and Fours');

    const quads = evalCards(C(Rank.Six, Suit.Hearts), C(Rank.Six, Suit.Clubs), C(Rank.Six, Suit.Spades), C(Rank.Six, Suit.Diamonds), C(Rank.Ace, Suit.Hearts));
    const boat = evalCards(C(Rank.Ace, Suit.Hearts), C(Rank.Ace, Suit.Clubs), C(Rank.Ace, Suit.Spades), C(Rank.King, Suit.Diamonds), C(Rank.King, Suit.Hearts));
    expect(quads.category).toBe(HandCategory.FourOfAKind);
    expect(quads.gt(boat)).toBe(true);
    // Unity pluralises with a bare "s" (RankWord + "s"): "Sixs" — kept faithfully.
    expect(quads.describe()).toBe('Four of a Kind, Sixs');
  });

  it('full ranking ladder, low to high', () => {
    const ladder = [
      H('2c 5d 9h Js Kc'), H('2c 2d 9h Js Kc'), H('2c 2d 9h 9s Kc'), H('2c 2d 2h 9s Kc'), H('Ac 2d 3h 4s 5c'),
      H('6c 7d 8h 9s Tc'), H('2h 5h 9h Jh Kh'), H('3c 3d 3h 9s 9c'), H('7c 7d 7h 7s 2c'), H('5d 6d 7d 8d 9d'), H('Th Jh Qh Kh Ah'),
    ];
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]!.gt(ladder[i - 1]!), `step ${i}`).toBe(true);
    expect(H('3c 3d 3h 9s 9c').describe()).toBe('Full House, Threes full of Nines');
    expect(H('5d 6d 7d 8d 9d').describe()).toBe('Straight Flush, Nine high');
    expect(H('2c 2d 2h 9s Kc').describe()).toBe('Three of a Kind, Twos');
  });

  it('rejects fewer than 5 or more than 7 cards', () => {
    expect(() => H('2c 3d 4h 5s')).toThrow();
    expect(() => H('2c 3d 4h 5s 6c 7d 8h 9s')).toThrow();
  });
});
