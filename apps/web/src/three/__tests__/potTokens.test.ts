import { describe, expect, it } from 'vitest';
import { updateTokenCounts } from '../potTokens';

const VALUES = [5, 10, 50, 100, 500, 1000]; // Test.unity PotView denominations

describe('PotView token counts', () => {
  it('adds only the delta as the pot grows (blinds 25 then 50)', () => {
    const c = [0, 0, 0, 0, 0, 0];
    updateTokenCounts(c, VALUES, 0, 25, 12); // 25 = 10 + 10 + 5
    expect(c).toEqual([1, 2, 0, 0, 0, 0]);
    updateTokenCounts(c, VALUES, 25, 75, 12); // +50
    expect(c).toEqual([1, 2, 1, 0, 0, 0]);
  });

  it('recounts from scratch when the pot shrinks, and clears at zero', () => {
    const c = [1, 2, 1, 0, 0, 0];
    updateTokenCounts(c, VALUES, 75, 1600, 12);
    expect(c.reduce((a, b) => a + b)).toBeLessThanOrEqual(12);
    updateTokenCounts(c, VALUES, 1600, 600, 12);
    expect(c).toEqual([0, 0, 0, 1, 1, 0]);
    updateTokenCounts(c, VALUES, 600, 0, 12);
    expect(c).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('caps the total at maxTokens and rounds a leftover up with one smallest token', () => {
    const c = [0, 0, 0, 0, 0, 0];
    updateTokenCounts(c, VALUES, 0, 99999, 12);
    expect(c).toEqual([0, 0, 0, 0, 0, 12]);
    const d = [0, 0, 0, 0, 0, 0];
    updateTokenCounts(d, VALUES, 0, 3, 12);
    expect(d).toEqual([1, 0, 0, 0, 0, 0]);
  });
});
