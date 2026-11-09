/**
 * The portrait deal paths, built from Unity's real seat splines. Unity deals as one stream: every card leaves the deck,
 * swirls once round the table with the others and peels off to its seat. Portrait used to give each seat its own turn
 * and scale of that swirl, so the cards scattered in every direction, flew 11 to 35 units and left the screen
 * (10 Nov report: "the cards flying in and out as well as the splines look messed up").
 */
import { describe, expect, it } from 'vitest';
import sceneData from '../../data/unity-scene.json';
import { splineFromData } from '../../three/tableScene';
import { portraitPath, PORTRAIT_SLOT_SHIFT } from '../portraitTable';
import { portraitCardSpot } from '../portraitLayout';

type Raw = Parameters<typeof splineFromData>[0];
const landscape = sceneData.splines.map((seat) => [splineFromData(seat.card0 as unknown as Raw), splineFromData(seat.card1 as unknown as Raw)]);
const n = landscape.length;
const portrait = landscape.map((_, slot) => landscape[(slot + PORTRAIT_SLOT_SHIFT) % n].map((s, card) => portraitPath(s, portraitCardSpot(slot, card))));
/** Unity world → portrait screen coords (x right, y up). */
const screen = (p: { x: number; z: number }) => [-p.z, p.x];
const all = portrait.flat();
const spread = (paths: typeof all, t: number) => {
  const pts = paths.map((s) => s.evaluatePosition(t));
  let max = 0;
  for (const a of pts) for (const b of pts) max = Math.max(max, Math.hypot(a.x - b.x, a.z - b.z));
  return max;
};

describe('portrait deal paths', () => {
  it("end on each card's portrait spot", () => {
    portrait.forEach((pair, slot) =>
      pair.forEach((s, card) => {
        const [x, y] = screen(s.evaluatePosition(1));
        const [sx, sy] = portraitCardSpot(slot, card);
        expect(x, `slot ${slot} card ${card}`).toBeCloseTo(sx, 3);
        expect(y, `slot ${slot} card ${card}`).toBeCloseTo(sy, 3);
      }),
    );
  });

  it('travel together like Unity’s stream: as tight as landscape through the swirl, and no wider than it', () => {
    const flat = landscape.flat();
    for (const t of [0.2, 0.35, 0.5]) expect(spread(all, t), `t ${t}`).toBeLessThanOrEqual(spread(flat, t) * 1.0 + 1e-6);
  });

  it('stay on a phone screen: inside the fitted table width, never far above the top seat', () => {
    for (const s of all) {
      for (let i = 0; i <= 200; i++) {
        const [x, y] = screen(s.evaluatePosition(i / 200));
        expect(Math.abs(x), s.name).toBeLessThan(4.9);
        expect(y, s.name).toBeLessThan(7.0);
      }
    }
  });

  it('are about the same length for every seat (Unity: 24–35 units; the old portrait paths: 11–35)', () => {
    const lengths = all.map((s) => s.length);
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeLessThan(1.6);
  });
});
