/**
 * The portrait table's footprint check. On phones the hole cards used to land on their own seat's name bar (the three
 * top seats), touch the pot, and your two enlarged cards sat almost exactly on top of each other (9 Nov report:
 * "cards and other things overlap"). Every seat part, card pair, the board, the pot pill and the chip piles must now
 * be clear of each other.
 */
import { describe, expect, it } from 'vitest';
import { type Box, PORTRAIT_CARD, PORTRAIT_LAYOUT, portraitBoxes, portraitCardSpot, portraitOverlaps } from '../portraitLayout';

describe('portrait table layout', () => {
  it('has no overlaps between seats, hole cards, board, pot and chips', () => {
    expect(portraitOverlaps()).toEqual([]);
  });

  it('shows at least 40 % of your first card beside the second', () => {
    const [x0] = portraitCardSpot(0, 0);
    const [x1] = portraitCardSpot(0, 1);
    const w = PORTRAIT_CARD.w * PORTRAIT_LAYOUT.ownCardScale;
    expect((x1 - x0) / w).toBeGreaterThanOrEqual(0.4);
  });

  it("puts each seat's cards nearer that seat (avatar, bar or status pill) than any other seat", () => {
    const boxes = portraitBoxes();
    const get = (n: string) => boxes.find((b) => b.name === n)!;
    const gap = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));
    const seatGap = (cards: Box, j: number) => Math.min(gap(cards, get(`seat${j}.avatar`)), gap(cards, get(`seat${j}.bars`)));
    PORTRAIT_LAYOUT.seats.forEach((_, i) => {
      const cards = get(`seat${i}.cards`);
      for (let j = 0; j < PORTRAIT_LAYOUT.seats.length; j++) if (j !== i) expect(seatGap(cards, i), `seat ${i} vs ${j}`).toBeLessThan(seatGap(cards, j));
    });
  });

  it("keeps every seat's cards out of the board's row, so a showdown never reads as one long row of cards", () => {
    const boxes = portraitBoxes();
    const board = boxes.find((b) => b.name === 'board')!;
    for (const c of boxes.filter((b) => b.name.endsWith('.cards'))) {
      const shared = Math.min(c.y1, board.y1) - Math.max(c.y0, board.y0);
      expect(shared, c.name).toBeLessThan(0.25 * (c.y1 - c.y0));
    }
  });

  it('the overlap check does catch a collision', () => {
    const boxes = portraitBoxes();
    const top = boxes.find((b) => b.name === 'seat4.bars')!;
    boxes.push({ name: 'probe', x0: top.x0, x1: top.x0 + 0.5, y0: top.y0 - 0.2, y1: top.y0 + 0.2 });
    expect(portraitOverlaps(boxes).some((o) => o.includes('probe'))).toBe(true);
  });
});
