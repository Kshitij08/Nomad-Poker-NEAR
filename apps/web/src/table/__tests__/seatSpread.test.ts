import { describe, expect, it } from 'vitest';
import { planSeats, spreadRing, spreadSlots } from '../seatSpread';

const slotsOf = (map: number[], seats: number[]) => seats.map((s) => map[s]);

describe('spreadSlots: players spread evenly round an 8-slot table', () => {
  it('keeps the anchor (local player) at the bottom slot', () => {
    expect(spreadSlots(8, [0, 1, 2], 0)[0]).toBe(0);
    expect(spreadSlots(8, [2, 5, 6], 5)[5]).toBe(0);
  });

  it('2 players face each other, 3 a triangle, 4 a square', () => {
    expect(slotsOf(spreadSlots(8, [0, 1], 0), [0, 1])).toEqual([0, 4]);
    expect(slotsOf(spreadSlots(8, [0, 1, 2], 0), [0, 1, 2])).toEqual([0, 3, 5]);
    expect(slotsOf(spreadSlots(8, [0, 1, 2, 3], 0), [0, 1, 2, 3])).toEqual([0, 2, 4, 6]);
  });

  it('5 and 6 players use both sides (no side left empty)', () => {
    const five = slotsOf(spreadSlots(8, [0, 1, 2, 3, 4], 0), [0, 1, 2, 3, 4]);
    expect(five).toEqual([0, 2, 3, 5, 6]);
    expect(five.some((s) => s >= 5)).toBe(true); // right side used
    const six = slotsOf(spreadSlots(8, [0, 1, 2, 3, 4, 5], 0), [0, 1, 2, 3, 4, 5]);
    expect(six).toEqual([0, 1, 3, 4, 5, 7]);
  });

  it('a full table is the identity; every seat gets its own slot', () => {
    const full = spreadSlots(8, [0, 1, 2, 3, 4, 5, 6, 7], 0);
    expect(full).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const map = spreadSlots(8, [1, 4, 6], 4);
    expect(new Set(map).size).toBe(8);
  });

  it('keeps clockwise order from the anchor', () => {
    const map = spreadSlots(8, [6, 1, 3], 3);
    // clockwise from seat 3: 3, 6, 1
    expect(map[3]).toBe(0);
    expect(map[6]).toBeLessThan(map[1]!);
  });

  it('gives every player an exact, evenly spaced place on the ring (7 players fill the top)', () => {
    const { map, ring } = spreadRing(8, [0, 1, 2, 3, 4, 5, 6], 0, 0, 8);
    const places = [0, 1, 2, 3, 4, 5, 6].map((s) => ring[map[s]!]!);
    places.forEach((f, i) => expect(f).toBeCloseTo((i * 8) / 7, 6));
    // Gaps are all equal, so the 1 empty slot's worth of room is shared out, not left as a hole at the top.
    const gaps = places.map((f, i) => (((places[(i + 1) % 7]! - f) % 8) + 8) % 8);
    gaps.forEach((g) => expect(g).toBeCloseTo(8 / 7, 6));
    // Each player is drawn by the nearest whole slot.
    places.forEach((f, i) => expect(map[i]).toBe(Math.round(f) % 8));
    expect(ring.filter((f) => f === null)).toHaveLength(1);
  });

  it('whole-slot spreads (2, 4, 8 players) need no sliding', () => {
    for (const n of [2, 4, 8]) {
      const seats = Array.from({ length: n }, (_, i) => i);
      const { map, ring } = spreadRing(8, seats, 0, 0, 8);
      for (const s of seats) expect(ring[map[s]!]).toBe(map[s]);
    }
  });
});

describe('planSeats: players keep their seats when someone joins or leaves', () => {
  const at = (p: { map: number[] }, seats: number[]) => seats.map((s) => p.map[s]);

  it('starts with the even spread', () => {
    const p = planSeats(null, 8, [0, 1, 2, 3], 0);
    expect(at(p, [0, 1, 2, 3])).toEqual(at(spreadRing(8, [0, 1, 2, 3], 0), [0, 1, 2, 3]));
  });

  it('a newcomer joins without moving anyone already seated', () => {
    const four = planSeats(null, 8, [0, 1, 2, 3], 0);
    const five = planSeats(four, 8, [0, 1, 2, 3, 4], 0);
    expect(at(five, [0, 1, 2, 3])).toEqual(at(four, [0, 1, 2, 3]));
    expect(new Set(five.map).size).toBe(8); // still one slot per seat
    // Seat 4 sits clockwise after seat 3 (between seat 3 and you), in the free slot nearest that gap's middle.
    expect(five.map[4]).toBe(7);
  });

  it('a leaver frees their slot and nobody else moves', () => {
    const five = planSeats(null, 8, [0, 1, 2, 3, 4], 0);
    const four = planSeats(five, 8, [0, 1, 3, 4], 0);
    expect(at(four, [0, 1, 3, 4])).toEqual(at(five, [0, 1, 3, 4]));
    expect(four.ring[five.map[2]!]).toBeNull();
  });

  it('keeps exact ring places for players who stay', () => {
    const seven = planSeats(null, 8, [0, 1, 2, 3, 4, 5, 6], 0);
    const six = planSeats(seven, 8, [0, 1, 2, 3, 5, 6], 0);
    for (const s of [1, 2, 3, 5, 6]) expect(six.ring[six.map[s]!]).toBeCloseTo(seven.ring[seven.map[s]!]!, 6);
  });

  it('the same players give back the same plan', () => {
    const p = planSeats(null, 8, [0, 2, 5], 0);
    expect(planSeats(p, 8, [5, 2, 0], 0)).toBe(p);
  });

  it('spreads afresh when your seat changes (sitting down) or nobody else is left', () => {
    const watching = planSeats(null, 8, [1, 2, 3], -1);
    const seated = planSeats(watching, 8, [1, 2, 3, 4], 4);
    expect(seated.map[4]).toBe(0);
    expect(at(seated, [4, 1, 2, 3])).toEqual(at(spreadRing(8, [1, 2, 3, 4], 4), [4, 1, 2, 3]));
    const alone = planSeats(seated, 8, [4], 4);
    const pair = planSeats(alone, 8, [4, 6], 4);
    expect(at(pair, [4, 6])).toEqual([0, 4]); // two players face each other again
  });
});

describe('planSeats keeps the clockwise turn order', () => {
  it('spreads afresh (once) when a newcomer has no free slot between their neighbours', () => {
    // You at 0, seat 1 at 4, seat 2 at 6, seat 3 at 7: seat 4 belongs between seat 3 (7) and you (0) — no slot there.
    let p = planSeats(null, 8, [0, 1], 0);
    p = planSeats(p, 8, [0, 1, 2], 0);
    p = planSeats(p, 8, [0, 1, 2, 3], 0);
    expect([p.map[1], p.map[2], p.map[3]]).toEqual([4, 6, 7]);
    const five = planSeats(p, 8, [0, 1, 2, 3, 4], 0);
    expect([0, 1, 2, 3, 4].map((s) => five.map[s])).toEqual([0, 1, 2, 3, 4].map((s) => spreadRing(8, [0, 1, 2, 3, 4], 0).map[s]));
  });

  it('never puts two players closer than one slot apart (no overlapping plates)', () => {
    // Joins and leaves that left a player at 6.4 and a newcomer at slot 7: plates 0.6 apart.
    const steps = [[0], [0, 1], [0, 1, 2], [0, 1], [0, 1, 6], [0, 1, 6, 3], [0, 1, 6, 3, 4], [0, 1, 6, 3, 4, 7]];
    let p = planSeats(null, 8, steps[0]!, 0);
    for (const seats of steps.slice(1)) p = planSeats(p, 8, seats, 0);
    const places = steps[steps.length - 1]!.map((s) => p.ring[p.map[s]!] ?? p.map[s]!).sort((a, b) => a - b);
    for (let i = 1; i < places.length; i++) expect(places[i]! - places[i - 1]!).toBeGreaterThanOrEqual(0.95);
    expect(8 + places[0]! - places[places.length - 1]!).toBeGreaterThanOrEqual(0.95);
  });

  it('never seats anyone out of clockwise order', () => {
    let p = planSeats(null, 8, [0], 0);
    const seats = [0];
    for (const s of [3, 6, 1, 5, 2, 7, 4]) {
      seats.push(s);
      p = planSeats(p, 8, seats, 0);
      const order = [...seats].sort((a, b) => a - b).map((x) => p.ring[p.map[x]!] ?? p.map[x]!);
      for (let i = 1; i < order.length; i++) expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    }
  });
});
