/**
 * Phones play in portrait only. The store apps lock it natively (Android MainActivity, iOS
 * UISupportedInterfaceOrientations); a phone browser cannot be locked outside fullscreen, so when one is held
 * sideways a "turn your phone" card covers the game. Tablets and desktops keep both orientations.
 */
import { ico } from './icons';

/** A phone: touch-first and its short side under 600 CSS px. */
export function isPhone(): boolean {
  if (typeof window === 'undefined' || typeof matchMedia === 'undefined') return false;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const short = Math.min(window.screen?.width ?? innerWidth, window.screen?.height ?? innerHeight);
  return coarse && short > 0 && short < 600;
}

export function installPortraitLock(): void {
  if (typeof document === 'undefined') return;
  const card = document.createElement('div');
  card.className = 'v2-rotate';
  card.setAttribute('role', 'alert');
  card.innerHTML = `${ico('rotate', 1)}<b>Turn your phone upright</b><span>Nomad Poker plays in portrait on phones.</span>`;
  document.body.append(card);
  const check = (): void => {
    // The screen's orientation, not the window's: an on-screen keyboard shrinks the window but doesn't turn the phone.
    const type = screen.orientation?.type;
    const landscape = type ? type.startsWith('landscape') : (window.screen?.width ?? innerWidth) > (window.screen?.height ?? innerHeight);
    const native = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
    const sideways = !native && isPhone() && landscape;
    document.documentElement.classList.toggle('v2-phone-landscape', sideways);
  };
  try {
    // Works in fullscreen / installed web apps; ignored elsewhere.
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (isPhone()) void o?.lock?.('portrait').catch(() => undefined);
  } catch {
    /* not supported */
  }
  addEventListener('resize', check);
  addEventListener('orientationchange', () => setTimeout(check, 150));
  check();
}
