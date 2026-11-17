import { EventBus, Router, type AppContext } from './app/app';
import { LocalAccount } from './app/services';
import { WebAudio } from './audio/webAudio';
import { TableStage } from './table/tableStage';
import { TableScreen, type TableScreenParams } from './table/tableScreen';
import { ticker } from './anim/tween';
import { MODULES } from './modules';
import { bindThemeToTable } from './theming/install';
import type { CardFace } from './table/cardView';
import { firstScreenArt } from './ui2/screens/play';

/**
 * Boot: the persistent table stage, the router, base services, then every module. Starts on the menu
 * when the menu module registered one, otherwise straight at the offline table (as before).
 *
 * Debug flags: ?table=1 (skip the menu), ?demo=1 (animation-only loop), ?speed=N, ?paused=1 (+ __poker.step(s)).
 */
const params = new URLSearchParams(location.search);

// The Unity build that used to live on this domain left a service worker (/sw.js) in its visitors' browsers. It sits
// between this page and the network and serves from its old cache, which stalled audio on the first visit. Remove it,
// and when it controlled this load, reload once so everything comes straight from the network. (public/sw.js is the
// replacement script, which does the same for browsers that update the worker before opening the page.)
void (async () => {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  try {
    const regs = await sw.getRegistrations();
    if (!regs.length) return;
    await Promise.all(regs.map((r) => r.unregister()));
    if ('caches' in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    if (sw.controller && sessionStorage.getItem('np.swCleared') !== '1') {
      sessionStorage.setItem('np.swCleared', '1');
      location.reload();
    }
  } catch {
    /* storage blocked: nothing we can do, the page still works */
  }
})();

const stage = new TableStage(
  document.getElementById('stage')!,
  document.getElementById('table3d') as HTMLCanvasElement,
  document.getElementById('hud')!,
  { paused: params.get('paused') === '1', speed: Number(params.get('speed') ?? 1) },
);

const events = new EventBus();
const router = new Router(document.getElementById('screens')!);
const audio = new WebAudio();
// The first screen's art downloads first (it starts here, while the modules load); the sound effects follow once the
// first screen is up, so they don't compete with it. play() is silent for a clip that hasn't arrived yet.
const art = preloadImages(firstScreenArt(), (done, total) => setBootProgress(done / total));
const ctx: AppContext = { router, services: { account: new LocalAccount(events) }, audio, params, events };
router.attach(ctx);
router.register('table', (c) => new TableScreen(c, stage));

(window as unknown as Record<string, unknown>).__poker = {
  ctx,
  stage,
  ticker,
  table: stage.table,
  dealer: stage.dealer,
  hud: stage.hud,
  slam: stage.slam,
  lens: stage.lens,
  potTokens: stage.potTokens,
  step: (s: number) => stage.step(s),
  pause: (p: boolean) => stage.setPaused(p),
};

async function boot(): Promise<void> {
  for (const install of MODULES) await install(ctx);
  bindThemeToTable(stage, ctx.services.theme);
  if (params.get('demo') === '1') {
    stage.setVisible(true);
    runDemoHand();
    return;
  }
  if (params.get('table') !== '1' && router.has('menu')) await router.navigate('menu');
  else await router.navigate('table', {} satisfies TableScreenParams);
}
/** The loading cover (index.html #boot) fades out once the first screen is up, or if boot fails. */
function hideBootCover(): void {
  const el = document.getElementById('boot');
  if (!el) return;
  el.classList.add('out');
  window.setTimeout(() => el.remove(), 400);
}

/** Downloads and decodes images; reports each one done (loaded or failed). Resolves when all are done. */
function preloadImages(urls: string[], onEach: (done: number, total: number) => void): Promise<void> {
  let done = 0;
  return Promise.all(
    urls.map(async (url) => {
      const img = new Image();
      img.decoding = 'async';
      (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = 'high';
      img.src = url;
      try {
        await img.decode();
      } catch {
        /* a missing picture just falls back to the room's colour */
      }
      onEach(++done, urls.length);
    }),
  ).then(() => undefined);
}

/** The loading bar on the cover (0..1). */
function setBootProgress(f: number): void {
  const bar = document.getElementById('boot-bar');
  if (bar) bar.style.transform = `scaleX(${Math.max(0.08, Math.min(1, f))})`;
}

/** The first screen is up and its art is in (or 6 s have passed on a slow connection): show it, then load sounds. */
void boot()
  .then(() => Promise.race([art, new Promise((r) => window.setTimeout(r, 6000))]))
  .finally(() => {
    setBootProgress(1);
    hideBootCover();
    window.setTimeout(() => void audio.load(), 300);
  });

/** ?demo=1: scripted hand that exercises every card animation without the engine. */
function runDemoHand(): void {
  const { dealer, table } = stage;
  dealer.clear();
  const deck: CardFace[] = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const hands = table.seatSplines.map(() => [deck.pop()!, deck.pop()!] as const);
  const board = deck.splice(0, 5);
  table.seatSplines.forEach(([s0, s1], seat) => dealer.dealHoleCards(seat, s0, s1, hands[seat][0], hands[seat][1], seat === 0));
  const at = (t: number, fn: () => void) => ticker.delayedCall(t, fn);
  at(4.0, () => dealer.greyOutHoleCards(3));
  at(4.5, () => dealer.dealCommunity(board.slice(0, 3), board.slice(0, 3)));
  at(6.5, () => dealer.dealCommunity(board.slice(3, 4), board.slice(0, 4)));
  at(9.0, () => dealer.dealCommunity(board.slice(4, 5), board));
  at(11.0, () => [1, 5].forEach((s) => dealer.revealHoleCards(s, hands[s][0], hands[s][1])));
  at(13.5, () => {
    dealer.returnHoleCards();
    dealer.withdrawCommunityCards();
  });
  at(16.5, runDemoHand);
}
