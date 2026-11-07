import { EventBus, Router, type AppContext } from './app/app';
import { LocalAccount } from './app/services';
import { WebAudio } from './audio/webAudio';
import { TableStage } from './table/tableStage';
import { TableScreen, type TableScreenParams } from './table/tableScreen';
import { ticker } from './anim/tween';
import { MODULES } from './modules';
import { bindThemeToTable } from './theming/install';
import type { CardFace } from './table/cardView';

/**
 * Boot: the persistent table stage, the router, base services, then every module. Starts on the menu
 * when the menu module registered one, otherwise straight at the offline table (as before).
 *
 * Debug flags: ?table=1 (skip the menu), ?demo=1 (animation-only loop), ?speed=N, ?paused=1 (+ __poker.step(s)).
 */
const params = new URLSearchParams(location.search);

const stage = new TableStage(
  document.getElementById('stage')!,
  document.getElementById('table3d') as HTMLCanvasElement,
  document.getElementById('hud')!,
  { paused: params.get('paused') === '1', speed: Number(params.get('speed') ?? 1) },
);

const events = new EventBus();
const router = new Router(document.getElementById('screens')!);
const audio = new WebAudio();
void audio.load();
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
void boot();

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
