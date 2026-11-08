import { Pot, type PlayerState } from './state';

/**
 * Splits the chips committed this hand into a main pot plus any side pots, layering by each distinct all-in level.
 * Folded players' chips stay in the pots they could reach, but they are never eligible to win. A top layer
 * contributed by only one (still-in-hand) player resolves to that player winning their own uncalled chips back.
 * Port of Core/State/SidePotCalculator.cs.
 */
export const SidePotCalculator = {
  build(seats: readonly PlayerState[]): Pot[] {
    const pots: Pot[] = [];

    // Distinct positive contribution levels, ascending.
    const levels: number[] = [];
    for (const p of seats) if (p.totalCommitted > 0 && !levels.includes(p.totalCommitted)) levels.push(p.totalCommitted);
    levels.sort((a, b) => a - b);

    let prev = 0;
    for (const level of levels) {
      const layerPerPlayer = level - prev;
      if (layerPerPlayer <= 0) { prev = level; continue; }

      const pot = new Pot();
      const refundSeats: number[] = [];
      for (const p of seats) {
        if (p.totalCommitted < level) continue;
        pot.amount += layerPerPlayer;
        refundSeats.push(p.seatIndex);
        if (p.isInHand) pot.eligibleSeats.push(p.seatIndex);
      }

      if (pot.amount <= 0) { prev = level; continue; }

      // No in-hand contributor for this layer (only folded players reached it): refund to those who put it in.
      if (pot.eligibleSeats.length === 0) pot.eligibleSeats.push(...refundSeats);

      pots.push(pot);
      prev = level;
    }
    return pots;
  },
};
