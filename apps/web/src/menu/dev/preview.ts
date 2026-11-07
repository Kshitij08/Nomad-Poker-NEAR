/**
 * Dev harness: the menu module alone (no table stage, no other modules), for checking the screens while the rest of
 * the app is mid-change. Open http://localhost:5180/assets/menu/dev/preview.html (?screen=Friends to start elsewhere).
 */
import { EventBus, Router, type AppContext } from '../../app/app';
import { LocalAccount } from '../../app/services';
import { WebAudio } from '../../audio/webAudio';
import { install } from '../install';

const params = new URLSearchParams(location.search);
const events = new EventBus();
const router = new Router(document.getElementById('screens')!);
const audio = new WebAudio();
void audio.load();
const ctx = { router, services: { account: new LocalAccount(events) }, audio, params, events } as unknown as AppContext;
router.attach(ctx);
router.register('table', () => ({ mount: (el: HTMLElement) => void (el.textContent = 'table (not in the harness)'), unmount: () => undefined }));
install(ctx);
void router.navigate('menu').then(() => {
  const s = params.get('screen');
  if (s) ctx.services.nomad?.show(s);
});
(window as unknown as Record<string, unknown>).__ctx = ctx;

// Other modules may be mid-edit: Vite's error overlay for THEIR files would cover the harness.
new MutationObserver(() => document.querySelector('vite-error-overlay')?.remove()).observe(document.documentElement, { childList: true, subtree: true });
