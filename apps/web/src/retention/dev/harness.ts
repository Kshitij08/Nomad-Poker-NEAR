/**
 * Dev-only harness: boots the retention module alone on a blank router with an in-memory wallet, so its screens can be
 * checked in the browser without the rest of the app. From the console of any page on the dev server:
 *
 *   const h = await import('/src/retention/dev/harness.ts'); const r = await h.setup();
 *   await r.router.push('level-up', { level: 5 }); await r.step(3);
 *
 * Time only moves through r.step(seconds) (the shared ticker in 1/60 s frames). Not imported by the app.
 */
import { EventBus, Router, type AppContext } from '../../app/app';
import { RewardKind, type RewardGrant, type VirtualWallet } from '../../app/services';
import { ticker } from '../../anim/tween';
import { install } from '../install';

export class MemoryWallet implements VirtualWallet {
  coins = 5000;
  gems = 0;
  xp = 0;
  streakTokens = 1;
  ownedItems: string[] = [];
  constructor(private readonly events: EventBus) {}
  canAfford = (c: number) => this.coins >= c;
  owns = (id: string) => this.ownedItems.includes(id);
  grant(g: RewardGrant): void {
    if (g.kind === RewardKind.Coins) this.coins += g.amount;
    else if (g.kind === RewardKind.Gems) this.gems += g.amount;
    else if (g.kind === RewardKind.Xp) this.xp += g.amount;
    else if (g.kind === RewardKind.StreakToken) this.streakTokens += g.amount;
    else this.ownedItems.push(g.itemId);
    this.events.emit('wallet:changed');
  }
  tryGrant(g: RewardGrant): boolean {
    this.grant(g);
    return true;
  }
  tryConsumeStreakToken(): boolean {
    if (this.streakTokens <= 0) return false;
    this.streakTokens--;
    return true;
  }
}

export async function setup(opts: { clearPrefs?: boolean } = { clearPrefs: true }) {
  if (opts.clearPrefs) for (const k of Object.keys(localStorage)) if (k.startsWith('Poker.')) localStorage.removeItem(k);
  const events = new EventBus();
  const screens = document.getElementById('screens')!;
  screens.innerHTML = '';
  document.getElementById('stage')?.style.setProperty('display', 'none');
  const router = new Router(screens);
  const sounds: number[] = [];
  const wallet = new MemoryWallet(events);
  const ctx = {
    router,
    services: { account: { displayName: 'Me' }, wallet },
    audio: { play: (s: number) => sounds.push(s), startTurnTimer() {}, stopTurnTimer() {} },
    params: new URLSearchParams(),
    events,
  } as unknown as AppContext;
  router.attach(ctx);
  router.register('base', () => ({
    mount(el: HTMLElement) {
      el.style.background = 'linear-gradient(#1b2a3a, #0c141d)';
    },
    unmount() {},
  }));
  install(ctx);
  await router.navigate('base');
  const step = async (seconds: number) => {
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) {
      ticker.update(1 / 60);
      if (i % 6 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  };
  const r = { ctx, router, wallet, sounds, step, retention: ctx.services.retention! };
  (window as unknown as Record<string, unknown>).__rh = r;
  return r;
}
