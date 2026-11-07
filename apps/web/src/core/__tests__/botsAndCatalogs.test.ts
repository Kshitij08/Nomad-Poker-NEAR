// Port of BotProfileTests.cs, BotBrainTests.cs (evaluator/equity parts), StakeCatalogTests.cs, QuickPlayFreeBotsTests.cs.
import { describe, expect, it } from 'vitest';
import {
  AvatarCatalog, BotProfile, Card, DotNetRandom, Equity, HandEvaluator, HeuristicBot, QuickPlayFreeBots, Rank,
  StakeCatalog, Suit, legalActions, roundHalfEven, type BotContext, BettingRound, ActionType, clampBuyIn, maxBuyInChips,
} from '../index';

describe('BotProfile', () => {
  it('fromPreset resolves named strategies', () => {
    expect(BotProfile.fromPreset('conservative').foldBelow).toBe(BotProfile.Conservative.foldBelow);
    expect(BotProfile.fromPreset('aggressive').aggression).toBe(BotProfile.Aggressive.aggression);
    expect(BotProfile.fromPreset('balanced').raiseAbove).toBe(BotProfile.Balanced.raiseAbove);
    expect(BotProfile.fromPreset('unknown').foldBelow).toBe(BotProfile.Balanced.foldBelow);
  });

  it('HeuristicBot uses the provided profile (clamped)', () => {
    const bot = new HeuristicBot(BotProfile.Aggressive, 42);
    expect(bot.Profile.aggression).toBeCloseTo(BotProfile.Aggressive.clamped().aggression, 4);
    expect(bot.Profile.foldBelow).toBeCloseTo(BotProfile.Aggressive.clamped().foldBelow, 4);
  });

  it('clamped caps out-of-range fields', () => {
    const c = BotProfile.numbers(2, -1, 5, -0.5, 9).clamped();
    expect(c.foldBelow).toBeLessThanOrEqual(0.55 + 1e-6);
    expect(c.raiseAbove).toBeGreaterThanOrEqual(0.45 - 1e-6);
    expect(c.aggression).toBeLessThanOrEqual(0.95 + 1e-6);
    expect(c.bluffChance).toBeGreaterThanOrEqual(0);
    expect(c.raiseFractionOfPot).toBeLessThanOrEqual(1.2 + 1e-6);
  });

  it('clamped keeps the v2 fields', () => {
    const p = BotProfile.Balanced;
    p.positionWeight = 3;
    p.brain = BotProfile.BrainV2;
    const flop = BotProfile.Balanced;
    flop.aggression = 2;
    const c = p.withStreet(1, flop).clamped();
    expect(c.positionWeight).toBe(1);
    expect(c.brain).toBe(BotProfile.BrainV2);
    expect(c.hasStreet![1]).toBe(true);
    expect(c.streets![1]!.aggression).toBeCloseTo(0.95, 6);
    expect(BotProfile.Balanced.clamped().streets).toBeNull();
  });

  it('personality stays inside its ranges', () => {
    for (let s = 0; s < 200; s++) {
      const p = BotProfile.personality(new DotNetRandom(s));
      expect(p.foldBelow).toBeGreaterThanOrEqual(Math.fround(0.15));
      expect(p.foldBelow).toBeLessThanOrEqual(Math.fround(0.45));
      expect(p.raiseFractionOfPot).toBeLessThanOrEqual(Math.fround(0.95));
    }
  });
});

describe('HeuristicBot', () => {
  const ctx = (over: Partial<BotContext>): BotContext => ({
    seatIndex: 0, holeCards: [Card.parse('As'), Card.parse('Ah')], community: [], round: BettingRound.Preflop, pot: 75,
    myStack: 5000, myCurrentBet: 0, bigBlind: 50, opponentsInHand: 3, position: 2,
    legal: legalActions(true, false, true, 50, false, true, 100, 5000, true), ...over,
  });

  it('always returns a legal action and snaps wagers to a whole big blind', () => {
    const r = new DotNetRandom(3);
    for (let i = 0; i < 3000; i++) {
      const bot = new HeuristicBot(i);
      const deck = Array.from({ length: 52 }, (_, k) => k).sort(() => r.nextDouble() - 0.5).map(Card.fromIndex);
      const facing = r.next(2) === 0;
      const l = facing ? legalActions(true, false, true, 50, false, true, 100, 5000, true) : legalActions(true, true, false, 0, true, false, 50, 5000, true);
      const a = bot.decide(ctx({ holeCards: deck.slice(0, 2), community: deck.slice(2, 2 + [0, 3, 4, 5][i % 4]!), legal: l }));
      if (a.type === ActionType.Bet || a.type === ActionType.Raise) {
        expect(a.amount).toBeGreaterThanOrEqual(l.minRaiseTo);
        expect(a.amount).toBeLessThanOrEqual(l.maxRaiseTo);
        expect(a.amount % 50 === 0 || a.amount === l.maxRaiseTo || a.amount === l.minRaiseTo).toBe(true);
        expect(a.type).toBe(facing ? ActionType.Raise : ActionType.Bet);
      } else if (a.type === ActionType.Check) expect(l.canCheck).toBe(true);
      else if (a.type === ActionType.Call) expect(l.canCall).toBe(true);
    }
  });

  it('headsUpEquivalent is the identity heads-up and monotonic otherwise', () => {
    expect(HeuristicBot.headsUpEquivalent(0.4, 1)).toBe(0.4);
    let prev = -1;
    for (let e = 0; e <= 1; e += 0.01) {
      const v = HeuristicBot.headsUpEquivalent(e, 4);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('Equity', () => {
  it('handValue orders hands like the engine', () => {
    const r = new DotNetRandom(7);
    for (let i = 0; i < 4000; i++) {
      const idx = Array.from({ length: 52 }, (_, k) => k).map((k) => [r.next(), k] as const).sort((a, b) => a[0] - b[0]).slice(0, 9).map((x) => x[1]);
      const board = idx.slice(4).map(Card.fromIndex);
      const a = HandEvaluator.evaluateHand([Card.fromIndex(idx[0]!), Card.fromIndex(idx[1]!)], board);
      const b = HandEvaluator.evaluateHand([Card.fromIndex(idx[2]!), Card.fromIndex(idx[3]!)], board);
      const va = Equity.handValue([idx[0]!, idx[1]!, ...idx.slice(4)]);
      const vb = Equity.handValue([idx[2]!, idx[3]!, ...idx.slice(4)]);
      expect(Math.sign(va - vb)).toBe(Math.sign(a.compareTo(b)));
      expect(va >> 20).toBe(a.category);
    }
  });

  it('matches known matchups', () => {
    const rng = new DotNetRandom(3);
    const aces = Equity.estimate([new Card(Rank.Ace, Suit.Spades), new Card(Rank.Ace, Suit.Hearts)], [], 1, rng, 4000);
    const trash = Equity.estimate([new Card(Rank.Seven, Suit.Spades), new Card(Rank.Two, Suit.Hearts)], [], 1, rng, 4000);
    expect(Math.abs(aces - 0.85)).toBeLessThan(0.03);
    expect(Math.abs(trash - 0.35)).toBeLessThan(0.03);
  });
});

describe('StakeCatalog', () => {
  it('ladder matches the published buy-ins', () => {
    expect(StakeCatalog.Tiers.map((t) => t.minBuyIn)).toEqual([50, 100, 500, 1000, 5000, 10000]);
  });

  it('default tier keeps the shipped blinds', () => {
    const d = StakeCatalog.Default;
    expect([d.minBuyIn, d.smallBlind, d.bigBlind, d.startingStack]).toEqual([1000, 25, 50, 5000]);
    expect(d.blindsLabel).toBe('25 / 50');
    expect(StakeCatalog.get(10000).buyInLabel).toBe('10,000');
  });

  it('highestAffordable picks the top table the balance can enter', () => {
    expect(StakeCatalog.highestAffordable(49)).toBeNull();
    expect(StakeCatalog.highestAffordable(50)!.minBuyIn).toBe(50);
    expect(StakeCatalog.highestAffordable(4999)!.minBuyIn).toBe(1000);
    expect(StakeCatalog.highestAffordable(10000)!.minBuyIn).toBe(10000);
  });

  it('resolve honours a manual pick when affordable, otherwise falls back', () => {
    expect(StakeCatalog.resolve(500, 800).minBuyIn).toBe(500);
    expect(StakeCatalog.resolve(500, 100).minBuyIn).toBe(100);
    expect(StakeCatalog.resolve(0, 80).minBuyIn).toBe(50);
    expect(StakeCatalog.resolve(10000, 20).minBuyIn).toBe(50);
  });

  it('buy-in clamp: min buy-in .. min(full stack, coins)', () => {
    const mid = StakeCatalog.get(500);
    expect(maxBuyInChips(mid, 10000)).toBe(2500);
    expect(maxBuyInChips(mid, 800)).toBe(800);
    expect(clampBuyIn(99999, mid, 10000)).toBe(2500);
    expect(clampBuyIn(10, mid, 10000)).toBe(500);
  });
});

describe('QuickPlayFreeBots / AvatarCatalog / .NET math', () => {
  it('rollCount matches the published weights', () => {
    expect([0, 49, 50, 79, 80, 94, 95, 99].map(QuickPlayFreeBots.rollCount)).toEqual([4, 4, 3, 3, 2, 2, 1, 1]);
  });

  it('names fit the wire and stay unique', () => {
    expect(new Set(QuickPlayFreeBots.Names).size).toBe(QuickPlayFreeBots.Names.length);
    for (const n of QuickPlayFreeBots.Names) expect(n.length).toBeLessThanOrEqual(24);
  });

  it('avatar fallback is a stable 1..19 face per name', () => {
    for (const name of ['You', 'Bot 1', 'Bot 6', '']) {
      const a = AvatarCatalog.fallbackFor(name);
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(19);
      expect(AvatarCatalog.fallbackFor(name)).toBe(a);
    }
    expect(AvatarCatalog.resolve(5, 'You')).toBe(5);
  });

  it("roundHalfEven is C#'s Math.Round", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6].map(roundHalfEven)).toEqual([0, 2, 2, -0, -2, 2, 3]);
  });
});
