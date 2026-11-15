import { describe, expect, it } from 'vitest';
import { formatNear, parseNear, wholeOf } from './backing';

describe('wholeOf: a 4-decimal amount that rounds to the whole means all of it', () => {
  const total = 10_143_555_284_513_218_666_961n; // 0.010143... NEAR

  it('takes everything for the rounded prefill', () => {
    expect(formatNear(total)).toBe('0.0101');
    expect(wholeOf(parseNear(formatNear(total)), total)).toBe(total);
  });

  it('takes everything when rounding went up', () => {
    const t = 10_150_000_000_000_000_000_000n; // 0.01015 → "0.0102"
    expect(wholeOf(parseNear(formatNear(t)), t)).toBe(t);
  });

  it('keeps a smaller amount as typed', () => {
    expect(wholeOf(parseNear('0.005'), total)).toBe(parseNear('0.005'));
  });

  it('leaves a clearly larger amount alone (the prompt refuses it)', () => {
    expect(wholeOf(parseNear('0.02'), total)).toBe(parseNear('0.02'));
  });
});
