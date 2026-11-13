/**
 * Seats spread evenly round the table. The table has `slotCount` HUD slots in clockwise order (slot 0 = bottom
 * centre, where the local player sits; 1–3 up the left side, 4 at the top, 5–7 down the right). Instead of seating
 * player k at slot k — which crammed a 5-player table onto one side and left the other empty — the occupied seats
 * take slots round(i · slotCount / n) clockwise from the anchor seat, so 2 players face each other, 3 make a
 * triangle, 4 a square, and so on. Empty seats get the slots left over (they are hidden).
 */
export function spreadSlots(seatCount: number, occupied: readonly number[], anchorSeat: number, anchorSlot = 0, slotCount = seatCount): number[] {
  return spreadRing(seatCount, occupied, anchorSeat, anchorSlot, slotCount).map;
}

/**
 * The plan behind spreadSlots, with each occupant's exact place on the ring: `ring[slot]` is the fractional slot
 * position (anchorSlot + i · slotCount / n) of the player drawn in that slot — e.g. 7 players on 8 slots sit at
 * 0, 1.14, 2.29, 3.43, 4.57, 5.71, 6.86 — or null for an empty slot. The HUD slot is the nearest whole one; the table
 * layout (layout/portraitTable.ts) then slides it round the ellipse to the exact angle, so the gaps are all equal.
 */
export function spreadRing(
  seatCount: number,
  occupied: readonly number[],
  anchorSeat: number,
  anchorSlot = 0,
  slotCount = seatCount,
): { map: number[]; ring: (number | null)[] } {
  const n = Math.max(1, seatCount);
  const occ = [...new Set(occupied.filter((s) => s >= 0 && s < n))];
  const anchor = anchorSeat >= 0 && anchorSeat < n ? anchorSeat : (occ.length ? Math.min(...occ) : 0);
  if (!occ.includes(anchor) && anchorSeat >= 0 && anchorSeat < n) occ.push(anchor);
  // Clockwise seat order starting at the anchor.
  const turn = (s: number) => (((s - anchor) % n) + n) % n;
  occ.sort((a, b) => turn(a) - turn(b));
  const map = new Array<number>(n).fill(-1);
  const used = new Set<number>();
  const k = occ.length;
  const ring = new Array<number | null>(slotCount).fill(null);
  occ.forEach((seat, i) => {
    const exact = (anchorSlot + (i * slotCount) / Math.max(1, k)) % slotCount;
    let slot = Math.round(exact) % slotCount;
    const home = slot;
    while (used.has(slot)) slot = (slot + 1) % slotCount; // never two seats on one slot
    used.add(slot);
    map[seat] = slot;
    ring[slot] = slot === home ? exact : slot; // a bumped seat stays on its whole slot
  });
  // Empty seats: the free slots, in order.
  let free = 0;
  for (let seat = 0; seat < n; seat++) {
    if (map[seat] >= 0) continue;
    while (used.has(free)) free++;
    map[seat] = free < slotCount ? free : seat;
    used.add(free);
  }
  return { map, ring };
}

/** A seat plan plus what it was planned for, so the next plan can keep everyone who is still seated in place. */
export interface SeatPlan {
  map: number[];
  ring: (number | null)[];
  /** The occupied seats this plan placed. */
  occ: number[];
  anchorSeat: number;
  anchorSlot: number;
}

/**
 * Stable seats: players keep their places when someone joins or leaves. Everyone still seated stays exactly where the
 * previous plan put them; a newcomer takes the free whole slot between their clockwise neighbours (nearest the middle of
 * that gap); leavers just free their slot. A fresh even spread (spreadRing) is drawn only when there is no previous plan,
 * when the anchor (your seat or its slot) changes — sitting down — when nobody but the anchor is left, or when a
 * newcomer's gap has no free slot (the clockwise turn order always holds). Trade-off: a table that fills up one player
 * at a time can lean to one side until that re-spread.
 */
export function planSeats(
  prev: SeatPlan | null,
  seatCount: number,
  occupied: readonly number[],
  anchorSeat: number,
  anchorSlot = 0,
  slotCount = seatCount,
): SeatPlan {
  const n = Math.max(1, seatCount);
  const occ = [...new Set(occupied.filter((s) => s >= 0 && s < n))];
  const fresh = (): SeatPlan => ({ ...spreadRing(seatCount, occ, anchorSeat, anchorSlot, slotCount), occ: [...occ].sort((a, b) => a - b), anchorSeat, anchorSlot });
  if (!prev || prev.anchorSeat !== anchorSeat || prev.anchorSlot !== anchorSlot || prev.map.length !== n || prev.ring.length !== slotCount) return fresh();
  const stay = occ.filter((s) => prev.occ.includes(s) && prev.map[s]! >= 0);
  const others = stay.filter((s) => s !== anchorSeat);
  if (others.length === 0) return fresh();
  if (stay.length === occ.length && occ.length === prev.occ.length) return prev; // same people: nothing moves

  const map = new Array<number>(n).fill(-1);
  const ring = new Array<number | null>(slotCount).fill(null);
  const used = new Set<number>();
  // Where each placed seat sits on the ring (fractional for evenly spread stayers).
  const pos = new Map<number, number>();
  for (const s of stay) {
    const slot = prev.map[s]!;
    map[s] = slot;
    used.add(slot);
    const exact = prev.ring[slot] ?? slot;
    ring[slot] = exact;
    pos.set(s, exact);
  }
  if (anchorSeat >= 0 && anchorSeat < n && !pos.has(anchorSeat) && !used.has(anchorSlot)) {
    map[anchorSeat] = anchorSlot;
    used.add(anchorSlot);
    ring[anchorSlot] = anchorSlot;
    pos.set(anchorSeat, anchorSlot);
  }
  const fwd = (a: number, b: number) => (((b - a) % slotCount) + slotCount) % slotCount; // clockwise ring distance a → b
  const near = (a: number, b: number) => Math.min(fwd(a, b), fwd(b, a));
  const origin = anchorSeat >= 0 && anchorSeat < n ? anchorSeat : (occ.length ? Math.min(...occ) : 0);
  const turn = (s: number) => (((s - origin) % n) + n) % n;
  const newcomers = occ.filter((s) => !pos.has(s)).sort((a, b) => turn(a) - turn(b));
  for (const seat of newcomers) {
    const free = Array.from({ length: slotCount }, (_, i) => i).filter((i) => !used.has(i));
    if (!free.length) break;
    // Clockwise neighbours among the placed seats (by seat order): the newcomer belongs in the gap between them.
    const placed = [...pos.keys()].sort((a, b) => turn(a) - turn(b));
    const before = [...placed].reverse().find((s) => turn(s) < turn(seat)) ?? placed[placed.length - 1]!;
    const after = placed.find((s) => turn(s) > turn(seat)) ?? placed[0]!;
    const a = pos.get(before)!;
    const gap = before === after ? slotCount : fwd(a, pos.get(after)!) || slotCount;
    const mid = (a + gap / 2) % slotCount;
    const inGap = free.filter((f) => fwd(a, f) > 0 && fwd(a, f) < gap);
    // No free slot between their neighbours: seating them anywhere else would break the clockwise turn order (the action
    // would jump round the table), so the table spreads afresh once instead.
    if (!inGap.length) return fresh();
    const slot = inGap.reduce((best, f) => (near(f, mid) < near(best, mid) ? f : best), inGap[0]!);
    map[seat] = slot;
    used.add(slot);
    ring[slot] = slot;
    pos.set(seat, slot);
  }
  // Empty seats: the free slots, in order (hidden), as spreadRing does.
  let free = 0;
  for (let seat = 0; seat < n; seat++) {
    if (map[seat]! >= 0) continue;
    while (used.has(free)) free++;
    map[seat] = free < slotCount ? free : seat;
    used.add(free);
  }
  return { map, ring, occ: [...occ].sort((x, y) => x - y), anchorSeat, anchorSlot };
}

export const sameMap = (a: readonly number[] | null, b: readonly number[] | null): boolean =>
  !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
