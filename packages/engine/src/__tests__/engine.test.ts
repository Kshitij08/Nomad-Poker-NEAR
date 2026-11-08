// Port of Assets/Scripts/Tests/EngineFlowTests.cs and EngineSetBlindsTests.cs, plus heads-up/odd-chip cases.
import { describe, expect, it } from 'vitest';
import {
  ArgumentOutOfRangeError, BettingRound, Card, HeuristicBot, InvalidOperationError, PlayerAction, PokerEngine,
  SeededRandom, positionOf, tableConfig, type BotContext, type EngineEvent, type IPokerBot, type IRandom,
} from '../index';

function headsUp(seed: number): PokerEngine {
  const engine = new PokerEngine(tableConfig({ seatCount: 2, smallBlind: 25, bigBlind: 50, startingStack: 1000 }), new SeededRandom(seed));
  engine.seatPlayer(0, 'a', 'A', false, 1000);
  engine.seatPlayer(1, 'b', 'B', false, 1000);
  return engine;
}

function buildContext(engine: PokerEngine, seat: number): BotContext {
  const p = engine.table.seats[seat]!;
  return {
    seatIndex: seat, holeCards: p.holeCards, community: engine.table.community, round: engine.table.round,
    pot: engine.table.pot, myStack: p.stack, myCurrentBet: p.currentBet, bigBlind: engine.table.bigBlind,
    opponentsInHand: engine.countInHand() - 1, position: positionOf(engine.table.buttonSeat, seat, engine.table.seatCount),
    legal: engine.currentLegalActions,
  };
}

function playOneHand(engine: PokerEngine, bots: Map<number, IPokerBot>): void {
  engine.startHand();
  let guard = 0;
  while (engine.handInProgress) {
    const seat = engine.awaitingActionSeat;
    expect(seat).toBeGreaterThanOrEqual(0);
    engine.submitAction(seat, bots.get(seat)!.decide(buildContext(engine, seat)));
    expect(++guard).toBeLessThan(100000);
  }
}

const sumStacks = (e: PokerEngine) => e.table.seats.reduce((s, p) => s + p.stack, 0);

/** A rigged IRandom whose shuffle leaves the deck in a chosen order (Fisher-Yates with j = i is the identity). */
function riggedDeck(order: string[]): { random: IRandom; } {
  // Build the permutation the shuffle must apply: identity shuffle when next(i+1) returns i. We instead pre-arrange by
  // simulating Fisher-Yates swaps that move each wanted card into place from the top of the deal order.
  const wanted = order.map((s) => Card.parse(s).index);
  const deck = Array.from({ length: 52 }, (_, i) => i);
  // Target final layout: deal order = deck[0], deck[1], ...  → place wanted[k] at index k.
  const target = [...wanted, ...deck.filter((c) => !wanted.includes(c))];
  // Fisher-Yates from the top: at step i (51..1) choose j such that deck[j] = target[i].
  const picks: number[] = [];
  const cur = [...deck];
  for (let i = 51; i > 0; i--) {
    const j = cur.indexOf(target[i]!);
    picks.push(j);
    [cur[i], cur[j]] = [cur[j]!, cur[i]!];
  }
  let k = 0;
  return { random: { next: () => picks[k++]! } };
}

describe('PokerEngine flow (EngineFlowTests)', () => {
  it('full hands conserve chips and always terminate', () => {
    const config = tableConfig({ seatCount: 4, smallBlind: 25, bigBlind: 50, startingStack: 300 });
    const engine = new PokerEngine(config, new SeededRandom(7));
    const bots = new Map<number, IPokerBot>();
    for (let seat = 0; seat < 4; seat++) {
      engine.seatPlayer(seat, `p${seat}`, `P${seat}`, true, config.startingStack);
      bots.set(seat, new HeuristicBot(100 + seat));
    }
    const total = 4 * config.startingStack;
    for (let hand = 0; hand < 60 && engine.countFundedPlayers() >= 2; hand++) {
      playOneHand(engine, bots);
      expect(engine.table.pot).toBe(0);
      expect(sumStacks(engine)).toBe(total);
    }
  });

  it('cannot check when facing a bet', () => {
    const engine = headsUp(3);
    engine.startHand();
    expect(engine.currentLegalActions.canCheck).toBe(false);
    expect(() => engine.submitAction(engine.awaitingActionSeat, PlayerAction.check())).toThrow(InvalidOperationError);
  });

  it('min raise is enforced; a rejected action leaves state untouched', () => {
    const engine = headsUp(3);
    engine.startHand();
    const seat = engine.awaitingActionSeat;
    const legal = engine.currentLegalActions;
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe(100);
    expect(() => engine.submitAction(seat, PlayerAction.raise(legal.minRaiseTo - 1))).toThrow(InvalidOperationError);
    expect(() => engine.submitAction(seat, PlayerAction.raise(legal.minRaiseTo))).not.toThrow();
    expect(engine.handInProgress).toBe(true);
  });

  it('fold awards the pot to the last player; chips conserved', () => {
    const engine = headsUp(5);
    engine.startHand();
    const sbSeat = engine.awaitingActionSeat; // heads-up: button/SB acts first preflop
    engine.submitAction(sbSeat, PlayerAction.fold());
    expect(engine.handInProgress).toBe(false);
    expect(engine.table.pot).toBe(0);
    expect(engine.table.seats[0]!.stack + engine.table.seats[1]!.stack).toBe(2000);
    const bbSeat = sbSeat === 0 ? 1 : 0;
    expect(engine.table.seats[sbSeat]!.stack).toBe(975);
    expect(engine.table.seats[bbSeat]!.stack).toBe(1025);
  });

  it('last player with chips does not get a turn after opponents are all-in', () => {
    const engine = new PokerEngine(tableConfig({ seatCount: 3, startingStack: 1000 }), new SeededRandom(1));
    engine.seatPlayer(0, 'a', 'A', false, 1000);
    engine.seatPlayer(1, 'b', 'B', false, 100);
    engine.seatPlayer(2, 'c', 'C', false, 100);
    let actionRequests = 0;
    engine.onEvent((e) => { if (e.type === 'ActionRequested') actionRequests++; });

    engine.startHand();
    expect(engine.awaitingActionSeat).toBe(0); // button 0, SB 1, BB 2 — UTG (seat 0) opens
    engine.submitAction(0, PlayerAction.call());
    engine.submitAction(engine.awaitingActionSeat, PlayerAction.allIn());
    engine.submitAction(engine.awaitingActionSeat, PlayerAction.allIn());

    expect(engine.handInProgress).toBe(true);
    expect(engine.awaitingActionSeat).toBe(0);
    expect(engine.currentLegalActions.canCall).toBe(true);
    expect(engine.currentLegalActions.canBet).toBe(false);
    expect(engine.currentLegalActions.canRaise).toBe(false);
    const before = actionRequests;
    engine.submitAction(0, PlayerAction.call());
    expect(engine.handInProgress).toBe(false);
    expect(actionRequests).toBe(before);
    expect(engine.table.community.length).toBe(5);
    expect(engine.table.pot).toBe(0);
  });

  it('covering player gets no turn on turn or river after flop all-ins', () => {
    const engine = new PokerEngine(tableConfig({ seatCount: 4, startingStack: 1000 }), new SeededRandom(1));
    engine.seatPlayer(0, 'cover', 'Cover', false, 2000);
    engine.seatPlayer(1, 'short', 'Short', false, 400);
    engine.seatPlayer(2, 'mid', 'Mid', false, 400);
    engine.seatPlayer(3, 'folder', 'Folder', false, 1000);
    let lateRequests = 0;
    engine.onEvent((e) => { if (e.type === 'ActionRequested' && engine.table.round > BettingRound.Flop) lateRequests++; });

    engine.startHand();
    let guard = 0;
    while (engine.handInProgress && engine.table.round === BettingRound.Preflop) {
      const l = engine.currentLegalActions;
      engine.submitAction(engine.awaitingActionSeat, l.canCheck ? PlayerAction.check() : PlayerAction.call());
      expect(++guard).toBeLessThan(20);
    }
    expect(engine.table.round).toBe(BettingRound.Flop);
    guard = 0;
    while (engine.handInProgress && engine.table.round === BettingRound.Flop && engine.awaitingActionSeat >= 0) {
      const seat = engine.awaitingActionSeat;
      const l = engine.currentLegalActions;
      if (seat === 3 && l.canFold) engine.submitAction(seat, PlayerAction.fold());
      else if ((seat === 1 || seat === 2) && l.canAllIn) engine.submitAction(seat, PlayerAction.allIn());
      else if (l.canCall) engine.submitAction(seat, PlayerAction.call());
      else if (l.canCheck) engine.submitAction(seat, PlayerAction.check());
      else engine.submitAction(seat, PlayerAction.fold());
      expect(++guard).toBeLessThan(20);
    }
    expect(lateRequests).toBe(0);
    expect(engine.table.community.length).toBe(5);
    expect(engine.handInProgress).toBe(false);
  });

  it('blinds are posted at hand start', () => {
    const engine = headsUp(9);
    engine.startHand();
    expect(engine.table.seats.reduce((s, p) => s + p.totalCommitted, 0)).toBe(75);
    expect(engine.table.pot).toBe(75);
    expect(engine.table.currentHighBet).toBe(50);
  });

  it('heads-up: button posts SB and acts first preflop, BB acts first postflop; button moves each hand', () => {
    const engine = headsUp(2);
    const starts: EngineEvent[] = [];
    engine.onEvent((e) => { if (e.type === 'HandStarted') starts.push(e); });
    engine.startHand();
    const hs = starts[0]!;
    if (hs.type !== 'HandStarted') throw new Error();
    expect(hs.buttonSeat).toBe(0);
    expect(hs.smallBlindSeat).toBe(0);
    expect(hs.bigBlindSeat).toBe(1);
    expect(engine.awaitingActionSeat).toBe(0);
    engine.submitAction(0, PlayerAction.call());
    // BB has the option preflop (blinds don't count as having acted).
    expect(engine.awaitingActionSeat).toBe(1);
    expect(engine.currentLegalActions.canCheck).toBe(true);
    expect(engine.currentLegalActions.canBet).toBe(true);
    engine.submitAction(1, PlayerAction.check());
    expect(engine.table.round).toBe(BettingRound.Flop);
    expect(engine.awaitingActionSeat).toBe(1); // postflop: left of the button
    engine.submitAction(1, PlayerAction.fold());
    engine.startHand();
    const hs2 = starts[1]!;
    if (hs2.type !== 'HandStarted') throw new Error();
    expect(hs2.buttonSeat).toBe(1);
  });

  it('3+ players: SB and BB are left of the button; UTG opens; event order of a hand start', () => {
    const engine = new PokerEngine(tableConfig({ seatCount: 4 }), new SeededRandom(4));
    for (let s = 0; s < 4; s++) engine.seatPlayer(s, `p${s}`, `P${s}`, s > 0, 5000);
    const types: string[] = [];
    engine.onEvent((e) => types.push(e.type));
    engine.startHand();
    expect([engine.table.buttonSeat, engine.table.smallBlindSeat, engine.table.bigBlindSeat]).toEqual([0, 1, 2]);
    expect(engine.awaitingActionSeat).toBe(3);
    expect(types).toEqual(['HandStarted', 'BlindPosted', 'BlindPosted', 'HoleCardsDealt', 'HoleCardsDealt', 'HoleCardsDealt',
      'HoleCardsDealt', 'BettingRoundChanged', 'ActionRequested']);
  });

  it('a short raise all-in does not reopen the minimum raise size', () => {
    const engine = new PokerEngine(tableConfig({ seatCount: 3 }), new SeededRandom(8));
    engine.seatPlayer(0, 'a', 'A', false, 5000);
    engine.seatPlayer(1, 'b', 'B', false, 5000);
    engine.seatPlayer(2, 'c', 'C', false, 5000);
    engine.startHand(); // btn 0, sb 1, bb 2; UTG = 0
    engine.submitAction(0, PlayerAction.raise(300)); // raise of 250 over 50
    expect(engine.currentLegalActions.minRaiseTo).toBe(550);
  });

  it('split pot: odd chip goes to the first winner left of the button', () => {
    // Board plays (A-K-Q-J-T straight); everyone ties. 3 players, pot 75+... use heads-up-ish 3 way all-in.
    const { random } = riggedDeck([
      // hole cards in seat order 0,1,2 (two each), then burn, flop, burn, turn, burn, river
      '2c', '3d', '2d', '3c', '2h', '3h', '9s', 'Ah', 'Kd', 'Qs', '8c', 'Jc', '7d', 'Ts',
    ]);
    const engine = new PokerEngine(tableConfig({ seatCount: 3, smallBlind: 25, bigBlind: 50 }), random);
    engine.seatPlayer(0, 'a', 'A', false, 101);
    engine.seatPlayer(1, 'b', 'B', false, 101);
    engine.seatPlayer(2, 'c', 'C', false, 101);
    const awards: { seat: number; amount: number; reason: string }[] = [];
    engine.onEvent((e) => { if (e.type === 'PotAwarded') awards.push({ seat: e.seat, amount: e.amount, reason: e.reason }); });
    engine.startHand(); // btn 0, sb 1, bb 2
    engine.submitAction(0, PlayerAction.allIn());
    engine.submitAction(1, PlayerAction.call());
    engine.submitAction(2, PlayerAction.call());
    expect(engine.table.community.map((c) => c.short)).toEqual(['Ah', 'Kd', 'Qs', 'Jc', 'Ts']);
    // 303 split three ways = 101 each, no remainder.
    expect(awards.map((a) => a.amount)).toEqual([101, 101, 101]);
    // Award order starts left of the button: seats 1, 2, 0.
    expect(awards.map((a) => a.seat)).toEqual([1, 2, 0]);
    expect(awards.every((a) => a.reason === 'Pot')).toBe(true);
  });

  it('split pot with a remainder: extra chip to the seat nearest the button\'s left', () => {
    // Deal order: seat 0, seat 1 (folds), seat 2, burn, flop, burn, turn, burn, river. Board is a broadway straight.
    const { random } = riggedDeck(['2c', '3d', '4h', '5s', '2d', '3c', '9s', 'Ah', 'Kd', 'Qs', '8c', 'Jc', '7d', 'Ts']);
    const engine = new PokerEngine(tableConfig({ seatCount: 3, smallBlind: 25, bigBlind: 50 }), random);
    engine.seatPlayer(0, 'a', 'A', false, 1000);
    engine.seatPlayer(1, 'b', 'B', false, 1000);
    engine.seatPlayer(2, 'c', 'C', false, 1000);
    const awards: { seat: number; amount: number }[] = [];
    engine.onEvent((e) => { if (e.type === 'PotAwarded') awards.push({ seat: e.seat, amount: e.amount }); });
    engine.startHand(); // btn 0, sb 1 (25), bb 2 (50); UTG 0
    engine.submitAction(0, PlayerAction.call()); // 50
    engine.submitAction(1, PlayerAction.fold()); // leaves the 25 small blind in: pot 125
    engine.submitAction(2, PlayerAction.check()); // BB option
    while (engine.handInProgress) engine.submitAction(engine.awaitingActionSeat, PlayerAction.check());
    // The folded small blind (25) is its own contribution level, so the 125 is layered like Unity does it:
    // "Main pot" 75 (25 x 3) split 38/37 — the odd chip to seat 2, first left of the button among the winners —
    // then "Side pot" 50 split 25/25. (Any showdown where someone folded after putting in less produces
    // Main/Side pot awards, all-in or not.)
    expect(awards).toEqual([{ seat: 2, amount: 38 }, { seat: 0, amount: 37 }, { seat: 2, amount: 25 }, { seat: 0, amount: 25 }]);
  });
});

describe('PokerEngine.setBlinds (EngineSetBlindsTests)', () => {
  const hu = (cfg = tableConfig({ seatCount: 2 })) => {
    const e = new PokerEngine(cfg, new SeededRandom(11));
    e.seatPlayer(0, 'a', 'A', false, 5000);
    e.seatPlayer(1, 'b', 'B', false, 5000);
    return e;
  };

  it('new blinds apply to the next hand', () => {
    const e = hu();
    e.setBlinds(100, 200);
    e.startHand();
    expect(e.table.smallBlind).toBe(100);
    expect(e.table.bigBlind).toBe(200);
    expect(e.table.pot).toBe(300);
    expect(e.table.currentHighBet).toBe(200);
    expect(e.currentLegalActions.minRaiseTo).toBe(400);
  });

  it('leaves the shared config alone', () => {
    const cfg = tableConfig({ seatCount: 2 });
    hu(cfg).setBlinds(500, 1000);
    expect(cfg.smallBlind).toBe(25);
    expect(cfg.bigBlind).toBe(50);
  });

  it('refused mid-hand', () => {
    const e = hu();
    e.startHand();
    expect(() => e.setBlinds(100, 200)).toThrow(InvalidOperationError);
    expect(e.table.bigBlind).toBe(50);
  });

  it('rejects nonsense', () => {
    const e = hu();
    expect(() => e.setBlinds(0, 50)).toThrow(ArgumentOutOfRangeError);
    expect(() => e.setBlinds(-25, 50)).toThrow(ArgumentOutOfRangeError);
    expect(() => e.setBlinds(100, 50)).toThrow(ArgumentOutOfRangeError);
  });

  it('blinds bigger than a stack put that player all-in', () => {
    const e = new PokerEngine(tableConfig({ seatCount: 2 }), new SeededRandom(3));
    e.seatPlayer(0, 'a', 'A', false, 150);
    e.seatPlayer(1, 'b', 'B', false, 9850);
    let shortBlind: { amount: number; stackAfter: number } | null = null;
    e.onEvent((ev) => { if (ev.type === 'BlindPosted' && ev.seat === 0) shortBlind = { amount: ev.amount, stackAfter: ev.stackAfter }; });
    e.setBlinds(1000, 2000);
    e.startHand();
    expect(shortBlind).toEqual({ amount: 150, stackAfter: 0 });
  });
});
