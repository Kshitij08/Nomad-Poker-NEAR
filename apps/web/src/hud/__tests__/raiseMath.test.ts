import { describe, expect, it } from 'vitest';
import { legalActions, presetAmount, bettingPanelState } from '@nomad/engine';
import { nudgeRaise, snapRaise } from '../raiseMath';

describe('raise slider snapping', () => {
  // Blinds 25/50, facing the big blind with 2,500 behind: min raise to 100, increment 50, all-in 2,500.
  const min = 100;
  const max = 2500;
  const step = 50;

  it('snaps to the min-raise grid and reaches all-in at the far end', () => {
    expect(snapRaise(100, min, max, step)).toBe(100);
    expect(snapRaise(137, min, max, step)).toBe(150);
    expect(snapRaise(124, min, max, step)).toBe(100);
    expect(snapRaise(2499, min, max, step)).toBe(2500);
    expect(snapRaise(5000, min, max, step)).toBe(2500);
    expect(snapRaise(10, min, max, step)).toBe(100);
  });

  it('all-in is reachable when the stack is not a whole number of increments', () => {
    // all-in 2,480: grid 100, 150 … 2,450, then all-in.
    expect(snapRaise(2470, 100, 2480, 50)).toBe(2480);
    expect(snapRaise(2440, 100, 2480, 50)).toBe(2450);
  });

  it('−/+ step one increment on the grid, from min to all-in and back', () => {
    expect(nudgeRaise(100, +1, min, max, step)).toBe(150);
    expect(nudgeRaise(137, +1, min, max, step)).toBe(150);
    expect(nudgeRaise(150, -1, min, max, step)).toBe(100);
    expect(nudgeRaise(100, -1, min, max, step)).toBe(100);
    expect(nudgeRaise(2450, +1, min, max, step)).toBe(2500);
    expect(nudgeRaise(2500, +1, min, max, step)).toBe(2500);
    expect(nudgeRaise(2480, -1, 100, 2480, 50)).toBe(2450);
  });

  it('presets come from the shared rules: min raise, ¼ / ½ / ¾ of the stack, all-in', () => {
    // A legal-actions snapshot: 2,500 behind, nothing in yet, facing 50 to call → min raise to 100.
    const legal = legalActions(true, false, true, 50, false, true, 100, 2500, true);
    expect(presetAmount('MIN', legal, 0)).toBe(100);
    expect(presetAmount('1/4', legal, 0)).toBe(625);
    expect(presetAmount('1/2', legal, 0)).toBe(1250);
    expect(presetAmount('3/4', legal, 0)).toBe(1875);
    expect(presetAmount('ALL IN', legal, 0)).toBe(2500);
    expect(bettingPanelState(legal, 0).step).toBe(50);
  });
});
