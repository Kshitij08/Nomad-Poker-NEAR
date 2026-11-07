import { describe, expect, it } from 'vitest';
import { isPortrait, orientationOf, safeArea } from '../orientation';
import { overlayScale, PORTRAIT_REF } from '../portraitRects';
import { menuReference, portraitScaleFor } from '../portraitMenu';

describe('orientation', () => {
  it('is portrait only when clearly taller than wide', () => {
    expect(orientationOf(390, 844)).toBe('portrait');
    expect(orientationOf(360, 800)).toBe('portrait');
    expect(orientationOf(844, 390)).toBe('landscape');
    expect(orientationOf(1024, 1024)).toBe('landscape'); // square tablets keep the Unity layout
    expect(orientationOf(1000, 1040)).toBe('landscape');
  });

  it('imports under node without browser globals (landscape, no insets)', () => {
    expect(isPortrait()).toBe(false);
    expect(safeArea()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe('canvas scalers', () => {
  it("keep Unity's CanvasScaler in landscape", () => {
    // Scale With Screen Size 1920×1080, match 0.5: 16:9 → 1, 20:9 2400×1080 → 1.118.
    expect(overlayScale(1920, 1080)).toBeCloseTo(1, 6);
    expect(overlayScale(2400, 1080)).toBeCloseTo(1.118, 3);
    expect(menuReference([1920, 1080])).toEqual([1920, 1080]);
    expect(portraitScaleFor([1920, 1080], 390, 844)).toBeNull();
  });

  it('portrait overlay reference makes an 81-unit Unity button ~44 px on a 390-px phone', () => {
    const s = Math.min(390 / PORTRAIT_REF[0], 844 / PORTRAIT_REF[1]);
    expect(81 * s).toBeGreaterThan(43);
  });
});
