import { describe, expect, it } from 'vitest';
import {
  Deck, HmacDrbgRandom, PlayerAction, PokerEngine, deckCommitment, deckFromSeed, newDeckSeed, verifyDeck,
  type DealtHand, type EngineEvent,
} from '../index';
import { PokerEventCodec } from '../events/pokerEventCodec';

const seedOf = (byte: number) => new Uint8Array(32).fill(byte);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const order = (seed: Uint8Array) => deckFromSeed(seed).map((c) => c.short);

describe('HmacDrbgRandom', () => {
  it('same seed, same deck', () => {
    const seed = newDeckSeed();
    expect(order(seed)).toEqual(order(seed.slice()));
    expect(new Set(order(seed)).size).toBe(52);
  });

  it('pins the shuffle for a fixed seed (the verifier and every past reveal depend on it)', () => {
    expect(order(seedOf(7)).slice(0, 9).join(' ')).toMatchInlineSnapshot(`"7h 7d 6d 3h 9h 5d 9c 2s Ks"`);
  });

  it('different seeds give different decks', () => {
    expect(order(seedOf(1))).not.toEqual(order(seedOf(2)));
  });

  it('reseed starts the stream over', () => {
    const rng = new HmacDrbgRandom(seedOf(3));
    const a = Array.from({ length: 20 }, () => rng.next(1000));
    rng.reseed(seedOf(3));
    expect(Array.from({ length: 20 }, () => rng.next(1000))).toEqual(a);
  });

  it('draws stay in range', () => {
    const rng = new HmacDrbgRandom(seedOf(9));
    for (let n = 1; n <= 52; n++) for (let i = 0; i < 20; i++) expect(rng.next(n)).toBeLessThan(n);
  });

  it('rejects a short seed', () => {
    expect(() => new HmacDrbgRandom(new Uint8Array(8))).toThrow(RangeError);
  });
});

describe('deck commitment', () => {
  it('is 64 hex chars and binds seed, table and hand', () => {
    const seed = seedOf(5);
    const c = deckCommitment(seed, 't-abc', 12);
    expect(c).toMatch(/^[0-9a-f]{64}$/);
    expect(deckCommitment(hex(seed), 't-abc', 12)).toBe(c);
    expect(deckCommitment(seed, 't-abd', 12)).not.toBe(c);
    expect(deckCommitment(seed, 't-abc', 13)).not.toBe(c);
    expect(deckCommitment(seedOf(6), 't-abc', 12)).not.toBe(c);
  });

  it('fresh seeds differ', () => {
    expect(hex(newDeckSeed())).not.toBe(hex(newDeckSeed()));
  });
});

/** Plays one hand on a real engine shuffled from `seed`, everyone checking or calling to the river. */
function playHand(seed: Uint8Array, players = 4): DealtHand {
  const engine = new PokerEngine({ seatCount: 6, smallBlind: 5, bigBlind: 10, startingStack: 1000 }, new HmacDrbgRandom(seed));
  // Leave gaps so seat order, not join order, decides the deal.
  const seats = [0, 2, 3, 5].slice(0, players);
  for (const s of seats) engine.seatPlayer(s, `p${s}`, `P${s}`, false, 1000);
  const events: EngineEvent[] = [];
  engine.onEvent((e) => events.push(e));
  engine.startHand();
  while (engine.handInProgress && engine.awaitingActionSeat >= 0) {
    const legal = engine.currentLegalActions;
    engine.submitAction(engine.awaitingActionSeat, legal.canCheck ? PlayerAction.check() : PlayerAction.call());
  }
  const holeCards: DealtHand['holeCards'] = [];
  let board: string[] = [];
  for (const e of events) {
    if (e.type === 'HoleCardsDealt') holeCards.push({ seat: e.seat, cards: [e.card0.short, e.card1.short] });
    if (e.type === 'CommunityDealt') board = e.board.map((c) => c.short);
  }
  return { holeCards, board };
}

describe('verifyDeck', () => {
  const seed = seedOf(42);
  const reveal = (dealt: DealtHand, over: Partial<{ seed: string; commitment: string; handNumber: number }> = {}) => ({
    tableId: 't-1',
    handNumber: 1,
    seed: hex(seed),
    commitment: deckCommitment(seed, 't-1', 1),
    dealt,
    ...over,
  });

  it('accepts the hand the engine dealt from the seed', () => {
    const dealt = playHand(seed);
    expect(dealt.board).toHaveLength(5);
    expect(verifyDeck(reveal(dealt))).toEqual({ ok: true, reason: null });
  });

  it('accepts a player checking only their own cards and the board', () => {
    const dealt = playHand(seed);
    const mine = { holeCards: dealt.holeCards.map((h) => (h.seat === 3 ? h : { seat: h.seat })), board: dealt.board };
    expect(verifyDeck(reveal(mine)).ok).toBe(true);
  });

  it('rejects a tampered seed', () => {
    const dealt = playHand(seed);
    const other = seed.slice();
    other[0] ^= 1;
    const r = verifyDeck(reveal(dealt, { seed: hex(other) }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('commitment');
  });

  it('rejects a seed revealed for another hand', () => {
    expect(verifyDeck(reveal(playHand(seed), { handNumber: 2 })).ok).toBe(false);
  });

  it('rejects a swapped hole card', () => {
    const dealt = playHand(seed);
    const bad = structuredClone(dealt);
    bad.holeCards[1]!.cards = [dealt.holeCards[2]!.cards![0]!, dealt.holeCards[1]!.cards![1]!];
    const r = verifyDeck(reveal(bad));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('hole card');
  });

  it('rejects a tampered board card', () => {
    const dealt = playHand(seed);
    const deck = deckFromSeed(seed).map((c) => c.short);
    const unused = deck[deck.length - 1]!;
    const bad = { ...dealt, board: [...dealt.board.slice(0, 4), unused] };
    const r = verifyDeck(reveal(bad));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('board card 5');
  });

  it('rejects a hand with a seat left out (positions shift)', () => {
    const dealt = playHand(seed);
    expect(verifyDeck(reveal({ ...dealt, holeCards: dealt.holeCards.slice(1) })).ok).toBe(false);
  });
});

describe('HandStarted wire', () => {
  const base = { type: 'HandStarted' as const, handNumber: 3, buttonSeat: 1, smallBlindSeat: 2, bigBlindSeat: 0, seats: [] };

  it('carries the commitment when present', () => {
    const commitment = deckCommitment(seedOf(1), 't', 3);
    const { event } = PokerEventCodec.decode(PokerEventCodec.encode({ ...base, deckCommitment: commitment }, 9));
    expect(event).toMatchObject({ type: 'HandStarted', handNumber: 3, deckCommitment: commitment });
  });

  it('is byte-identical to the old format without one', () => {
    const plain = PokerEventCodec.encode(base, 9);
    const committed = PokerEventCodec.encode({ ...base, deckCommitment: deckCommitment(seedOf(1), 't', 3) }, 9);
    expect(committed.length).toBe(plain.length + 33);
    expect(committed.subarray(0, plain.length)).toEqual(plain);
    const { event } = PokerEventCodec.decode(plain);
    expect(event && 'deckCommitment' in event).toBe(false);
  });
});

describe('Deck with HmacDrbgRandom', () => {
  it('is the same Fisher-Yates the engine uses', () => {
    const d = new Deck();
    d.shuffle(new HmacDrbgRandom(seedOf(7)));
    expect(d.deal().short).toBe(order(seedOf(7))[0]);
  });
});
