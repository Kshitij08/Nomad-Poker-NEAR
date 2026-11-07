/**
 * Orientation for the whole web client. The Unity game is landscape-only; the web port adds a portrait layout for
 * orientation-locked phones and in-app webviews (docs/portrait-design.md).
 *
 *   isPortrait()            current orientation (viewport taller than wide)
 *   onOrientation(fn)       called with the new value whenever it flips (resize / rotation), returns an unsubscribe
 *   safeArea()              notch / home-bar insets in CSS px (env(safe-area-inset-*), measured once per change)
 *
 * `<html data-orient="portrait|landscape">` mirrors the value so CSS can switch too. Debug: `?orient=portrait` or
 * `?orient=landscape` forces one regardless of the viewport.
 */
import './portrait.css';

export type Orientation = 'portrait' | 'landscape';

/** False under node (vitest): every browser global below is guarded so importing this module never throws. */
const BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

const forced = ((): Orientation | null => {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('orient');
  return v === 'portrait' || v === 'landscape' ? v : null;
})();

/** Portrait when the viewport is taller than wide (a square-ish tablet counts as landscape). */
export function orientationOf(w: number, h: number): Orientation {
  if (forced) return forced;
  return h > w * 1.05 ? 'portrait' : 'landscape';
}

let current: Orientation = BROWSER ? orientationOf(window.innerWidth, window.innerHeight) : 'landscape';
const listeners = new Set<(o: Orientation) => void>();

export function isPortrait(): boolean {
  return current === 'portrait';
}

export function orientation(): Orientation {
  return current;
}

export function onOrientation(fn: (o: Orientation) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- Safe area ------------------------------------------------------------------------------------

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

let probe: HTMLDivElement | null = null;
let insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

function measureSafeArea(): Insets {
  if (!BROWSER || !document.body) return insets;
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.append(probe);
  }
  const cs = getComputedStyle(probe);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}

/** Notch / home-bar insets in CSS px (0 on desktop). */
export function safeArea(): Insets {
  return insets;
}

// ---- Wiring -----------------------------------------------------------------------------------------

function update(): void {
  insets = measureSafeArea();
  const next = orientationOf(window.innerWidth, window.innerHeight);
  document.documentElement.dataset.orient = next;
  if (next === current) return;
  current = next;
  for (const fn of [...listeners]) {
    try {
      fn(next);
    } catch (err) {
      console.error('[orientation] listener failed', err);
    }
  }
}

if (BROWSER) {
  document.documentElement.dataset.orient = current;
  // Capture phase so this runs before the table stage / menu resize handlers read isPortrait().
  window.addEventListener('resize', update, true);
  window.addEventListener('orientationchange', () => {
    update();
    // iOS Safari reports the new innerWidth/innerHeight a frame or two after orientationchange.
    setTimeout(update, 120);
    setTimeout(update, 400);
  });
  window.visualViewport?.addEventListener('resize', update);
  if (document.body) insets = measureSafeArea();
  else window.addEventListener('DOMContentLoaded', () => (insets = measureSafeArea()), { once: true });
}
