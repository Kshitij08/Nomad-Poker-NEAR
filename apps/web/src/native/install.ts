/**
 * The store apps' native shell (Capacitor, Phase 8). On the web this module does nothing. In the iOS / Android app it:
 * - hides the splash once the first screen is up, and draws the status bar over the game (the layout already pads for
 *   safe areas: layout/orientation.ts);
 * - maps Android's back button to closing the top screen, and to leaving the app from the base screen;
 * - opens deep links (nomadpoker://join/CODE, https://…/?net=CODE, …/t/CODE): joins the party or finds the tournament;
 * - refreshes the server state when the app comes back to the foreground.
 * Plugins are loaded only on a device, so the web bundle doesn't carry them on its start path.
 */
import type { AppContext } from '../app/app';
import { parseDeepLink, type DeepLink } from './deepLink';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

export function isNativeApp(): boolean {
  return !!(globalThis as { Capacitor?: CapacitorGlobal }).Capacitor?.isNativePlatform?.();
}

/** Acts on a deep link (shared with the web's ?net= flag handling). */
export async function openDeepLink(ctx: AppContext, link: DeepLink): Promise<void> {
  if (link.kind === 'party') {
    await ctx.services.net?.joinParty(link.code).catch((e: unknown) => console.warn('[native] join failed', e));
  } else if (link.kind === 'tournament') {
    // Show it, never register: registering spends the entry fee, which the player confirms on the screen.
    // The v2 Join by code screen, with the code looked up; the Unity-era panel only when the v2 UI isn't running.
    const v2 = await import('../ui2/ctx').then((m) => m.ui()).catch(() => undefined);
    if (v2) return v2.show('t-code', link.code);
    const t = ctx.services.tournaments;
    if (!t || !ctx.router.has('tournaments')) return;
    await ctx.router.push('tournaments', { code: link.code });
  }
}

export async function install(ctx: AppContext): Promise<void> {
  if (!isNativeApp()) return;
  const [{ App }, { StatusBar, Style }, { SplashScreen }] = await Promise.all([
    import('@capacitor/app'),
    import('@capacitor/status-bar'),
    import('@capacitor/splash-screen'),
  ]);

  void StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
  void StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
  const hide = () => void SplashScreen.hide().catch(() => undefined);
  const off = ctx.events.on('router:changed', () => {
    off();
    hide();
  });
  setTimeout(hide, 8000); // never leave the splash up if the first screen fails

  void App.addListener('backButton', () => {
    if (ctx.router.depth > 1) ctx.router.back();
    else void App.minimizeApp();
  });
  void App.addListener('appUrlOpen', ({ url }) => void openDeepLink(ctx, parseDeepLink(url)));
  void App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) void ctx.services.nomadProgress?.refresh().catch(() => undefined);
  });
  // A cold start from a link: the app was opened by it.
  const launch = await App.getLaunchUrl().catch(() => undefined);
  if (launch?.url) setTimeout(() => void openDeepLink(ctx, parseDeepLink(launch.url)), 500);
}
