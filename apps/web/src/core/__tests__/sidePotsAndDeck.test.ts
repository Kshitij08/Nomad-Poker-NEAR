// Port of Assets/Scripts/Tests/SidePotTests.cs and DeckTests.cs.
import { describe, expect, it } from 'vitest';
import { Deck, InvalidOperationError, PlayerState, PlayerStatus, SeededRandom, SidePotCalculator } from '../index';

const player = (seat: number, committed: number, status: PlayerStatus) =>
  new PlayerState({ seatIndex: seat, totalCommitted: committed, status });

describe('SidePotCalculator', () => {
  it('three-way all-in builds a main and a side pot', () => {
    const pots = SidePotCalculator.build([player(0, 100, PlayerStatus.AllIn), player(1, 300, PlayerStatus.Active), player(2, 300, PlayerStatus.Active)]);
    expect(pots.length).toBe(2);
    expect(pots[0]!.amount).toBe(300);
    expect([...pots[0]!.eligibleSeats].sort()).toEqual([0, 1, 2]);
    expect(pots[1]!.amount).toBe(400);
    expect([...pots[1]!.eligibleSeats].sort()).toEqual([1, 2]);
  });

  it('uncalled overbet is refunded via a single-player pot', () => {
    const pots = SidePotCalculator.build([player(0, 300, PlayerStatus.Active), player(1, 100, PlayerStatus.AllIn)]);
    expect(pots.length).toBe(2);
    expect(pots[0]!.amount).toBe(200);
    expect([...pots[0]!.eligibleSeats].sort()).toEqual([0, 1]);
    expect(pots[1]!.amount).toBe(200);
    expect(pots[1]!.eligibleSeats).toEqual([0]);
  });

  it("folded contributor's chips stay but they are never eligible", () => {
    const pots = SidePotCalculator.build([player(0, 50, PlayerStatus.Folded), player(1, 200, PlayerStatus.Active), player(2, 200, PlayerStatus.Active)]);
    expect(pots.reduce((s, p) => s + p.amount, 0)).toBe(450);
    for (const pot of pots) expect(pot.eligibleSeats).not.toContain(0);
  });

  it('a layer only folded players reached is refunded to them', () => {
    const pots = SidePotCalculator.build([player(0, 500, PlayerStatus.Folded), player(1, 100, PlayerStatus.AllIn), player(2, 100, PlayerStatus.AllIn)]);
    expect(pots.length).toBe(2);
    expect(pots[1]!.amount).toBe(400);
    expect(pots[1]!.eligibleSeats).toEqual([0]);
  });
});

describe('Deck', () => {
  const dealAll = (d: Deck) => Array.from({ length: 52 }, () => d.deal().index);
  const shuffled = (seed: number) => { const d = new Deck(); d.shuffle(new SeededRandom(seed)); return d; };

  it('new deck has 52 unique cards', () => {
    const d = new Deck();
    expect(d.remaining).toBe(52);
    expect(new Set(dealAll(d)).size).toBe(52);
    expect(d.remaining).toBe(0);
  });

  it('shuffle is deterministic for the same seed', () => {
    expect(dealAll(shuffled(42))).toEqual(dealAll(shuffled(42)));
  });

  it('shuffle differs for different seeds', () => {
    expect(dealAll(shuffled(1))).not.toEqual(dealAll(shuffled(2)));
  });

  it('dealing past the end throws', () => {
    const d = new Deck();
    dealAll(d);
    expect(() => d.deal()).toThrow(InvalidOperationError);
  });
});
