/**
 * Bit-exact parity with the Unity C# sources. `golden/unity-golden.json` is produced by `golden/gen` — a .NET console
 * app that compiles the real Assets/Scripts/Core + Assets/Scripts/Bots files and dumps: System.Random sequences, seeded
 * deck orders, bot personalities, hand-strength values, and three full seeded bot-vs-bot simulations (every engine event
 * plus every bot decision). Regenerate after changing the C# core:
 *   cd packages/engine/src/__tests__/golden/gen && dotnet run -c Release -p:UNITY_REPO=<Unity Poker checkout> -- ../unity-golden.json
 * If any of these drift, the port no longer behaves exactly like Unity.
 */
import { describe, expect, it } from 'vitest';
import golden from './golden/unity-golden.json';
import {
  ActionType, AvatarCatalog, BettingRound, BotProfile, Card, Deck, DotNetRandom, HandStrength, HeuristicBot, PokerEngine, SeededRandom,
  positionOf, type BotContext, type EngineEvent, type IPokerBot, type LegalActions,
} from '../index';

const G = golden as unknown as {
  random: Record<string, { next: number[]; next52: number[]; nextDouble: number[] }>;
  deck: Record<string, number[]>;
  personality: Record<string, number[]>;
  handStrength: [string, string, number][];
  avatarFallback: Record<string, number>;
  simClassic7: string[];
  simShortStacks: string[];
  simBrainV2: string[];
};

const cards = (cs: readonly Card[]) => cs.map((c) => c.short).join('');
const parseCards = (s: string) => (s.match(/../g) ?? []).map(Card.parse);
const b = (x: boolean) => (x ? '1' : '0');
const legal = (l: LegalActions) =>
  `${b(l.canFold)}${b(l.canCheck)}${b(l.canCall)}:${l.callAmount}:${b(l.canBet)}${b(l.canRaise)}:${l.minRaiseTo}:${l.maxRaiseTo}:${b(l.canAllIn)}`;

function ser(e: EngineEvent): string {
  switch (e.type) {
    case 'HandStarted':
      return `HS ${e.handNumber} b${e.buttonSeat} s${e.smallBlindSeat} B${e.bigBlindSeat} ` +
        e.seats.map((s) => `${s.name ?? ''}:${s.stack}:${b(s.isOccupied)}${b(s.isBusted)}${b(s.isBot)}`).join(',');
    case 'BlindPosted': return `BP ${e.seat} ${e.amount} ${b(e.isSmallBlind)} ${e.stackAfter} ${e.potAfter}`;
    case 'HoleCardsDealt': return `HC ${e.seat} ${e.card0.short}${e.card1.short}`;
    case 'ActionRequested': return `AR ${e.seat} ${legal(e.legal)}`;
    case 'PlayerActed': return `PA ${e.seat} ${ActionType[e.action]} ${e.amount} ${e.stackAfter} ${e.potAfter}`;
    case 'BettingRoundChanged': return `RC ${BettingRound[e.round]}`;
    case 'CommunityDealt': return `CD ${BettingRound[e.round]} ${cards(e.newCards)}|${cards(e.board)}`;
    case 'Showdown': return 'SD ' + e.entries.map((x) => `${x.seat}:${x.card0.short}${x.card1.short}:${x.description}`).join(';');
    case 'PotAwarded': return `PW ${e.seat} ${e.seatName} ${e.amount} ${e.stackAfter} ${e.potAfter} ${e.reason}`;
    case 'HandEnded': return `HE ${e.handNumber}`;
    case 'GameOver': return `GO ${e.winnerSeat} ${e.winnerName ?? ''}`;
  }
}

function simulate(seed: number, stacks: number[], makeBot: (s: number) => IPokerBot, maxHands: number, sb: number, bb: number): string[] {
  const log: string[] = [];
  const n = stacks.length;
  const engine = new PokerEngine({ seatCount: n, smallBlind: sb, bigBlind: bb, startingStack: 5000 }, new SeededRandom(seed));
  engine.onEvent((e) => log.push(ser(e)));
  const bots = new Map<number, IPokerBot>();
  for (let s = 0; s < n; s++) {
    if (stacks[s]! < 0) continue;
    engine.seatPlayer(s, `bot${s}`, s === 0 ? 'You' : `Bot ${s}`, s !== 0, stacks[s]!);
    bots.set(s, makeBot(s));
  }
  for (let h = 0; h < maxHands && engine.countFundedPlayers() >= 2; h++) {
    engine.startHand();
    while (engine.handInProgress) {
      const seat = engine.awaitingActionSeat;
      const p = engine.table.seats[seat]!;
      const ctx: BotContext = {
        seatIndex: seat, holeCards: p.holeCards, community: engine.table.community, round: engine.table.round,
        pot: engine.table.pot, myStack: p.stack, myCurrentBet: p.currentBet, bigBlind: engine.table.bigBlind,
        opponentsInHand: engine.countInHand() - 1,
        position: positionOf(engine.table.buttonSeat, seat, engine.table.seatCount),
        legal: engine.currentLegalActions,
      };
      const a = bots.get(seat)!.decide(ctx);
      log.push(`DE ${seat} ${ActionType[a.type]} ${a.amount}`);
      engine.submitAction(seat, a);
    }
  }
  return log;
}

function expectSameLog(actual: string[], expected: string[]): void {
  const n = Math.min(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    if (actual[i] !== expected[i]) {
      const ctx = expected.slice(Math.max(0, i - 4), i).join('\n');
      expect(actual[i], `line ${i} differs; preceding lines:\n${ctx}`).toBe(expected[i]);
    }
  }
  expect(actual.length).toBe(expected.length);
}

describe('parity with the Unity C# build', () => {
  it('DotNetRandom reproduces System.Random(seed) exactly', () => {
    for (const [seed, v] of Object.entries(G.random)) {
      const r = new DotNetRandom(Number(seed));
      expect(Array.from({ length: 5 }, () => r.next()), `seed ${seed} Next()`).toEqual(v.next);
      expect(Array.from({ length: 5 }, () => r.next(52)), `seed ${seed} Next(52)`).toEqual(v.next52);
      expect(Array.from({ length: 3 }, () => r.nextDouble()), `seed ${seed} NextDouble()`).toEqual(v.nextDouble);
    }
  });

  it('SeededRandom deals the same shuffled deck', () => {
    for (const [seed, order] of Object.entries(G.deck)) {
      const d = new Deck();
      d.shuffle(new SeededRandom(Number(seed)));
      expect(Array.from({ length: 52 }, () => d.deal().index)).toEqual(order);
    }
  });

  it('seeded filler bots draw the same personality (float32)', () => {
    for (const [seed, nums] of Object.entries(G.personality)) {
      const p = new HeuristicBot(Number(seed)).Profile;
      expect([p.foldBelow, p.raiseAbove, p.aggression, p.bluffChance, p.raiseFractionOfPot]).toEqual(nums);
    }
  });

  it('HandStrength.estimate matches (preflop + postflop, float32)', () => {
    for (const [hole, board, v] of G.handStrength) {
      expect(HandStrength.estimate(parseCards(hole), parseCards(board)), `${hole} ${board}`).toBe(v);
    }
  });

  it('7-seat table, classic bots (the single-player setup): identical events and decisions over 60 hands', () => {
    const log = simulate(12345, [5000, 5000, 5000, 5000, 5000, 5000, 5000], (s) => new HeuristicBot(12345 + s * 101), 60, 25, 50);
    expectSameLog(log, G.simClassic7);
  });

  it('short stacks + empty seat (all-ins, side pots, busts, game over): identical', () => {
    const log = simulate(7, [300, 120, 900, -1, 75, 2000], (s) => new HeuristicBot(100 + s), 200, 25, 50);
    expectSameLog(log, G.simShortStacks);
  });

  it('brain-2 agents with position weight: identical', () => {
    const log = simulate(99, [2000, 2000, 1500, 800], (s) => {
      const p = BotProfile.fromPreset(s % 2 === 0 ? 'aggressive' : 'conservative');
      p.brain = BotProfile.BrainV2;
      p.positionWeight = Math.fround(0.5);
      return new HeuristicBot(p, 500 + s);
    }, 40, 10, 20);
    expectSameLog(log, G.simBrainV2);
  });
});

describe('parity: default avatars', () => {
  it('AvatarCatalog.fallbackFor(name) picks the same face as Unity (pro_pic id = Ids[n-1])', () => {
    for (const [name, n] of Object.entries(G.avatarFallback)) expect(AvatarCatalog.fallbackFor(name), name).toBe(n);
  });
});
