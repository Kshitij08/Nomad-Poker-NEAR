/**
 * Redesign v2 (Screen Atlas): the game's menu. Installs after the Nomad menu host (src/menu/host.ts) and draws every
 * screen it is asked to show: each v2 screen lists the screen names it answers to (`replaces`: the old Unity menu's
 * names, kept as the app's screen ids), and host.show(name) opens it.
 */
import type { AppContext } from '../app/app';
// Base v2 styles first: the screens' own stylesheets (imported by the screen modules below) override them.
import './ui2.css';
import type { NomadHost } from '../menu/host';
import { V2, type V2Screen } from './core';
import { PokerSound } from '@nomad/engine';
import { installPortraitLock } from './portraitLock';
import { setUi } from './ctx';
import { lobbyScreens } from './screens/lobby';
import { playScreens } from './screens/play';
import { rewardScreens } from './screens/rewards';
import { socialScreens } from './screens/social';
import { shopScreens } from './screens/shop';
import { tournamentScreens } from './screens/tournaments';
import { agentScreens } from './screens/agents';
import { entryScreens, installEntryOverlays } from './screens/entry';
import { openNearTableLink } from './screens/nearTables';

declare module '../app/app' {
  interface Services {
    /** Redesign v2 screen layer (src/ui2). */
    ui2?: V2;
  }
}

/** Every v2 screen; `replaces` lists the host screen names (the old Unity menu's) that open it. */
export interface ScreenDef extends V2Screen {
  replaces?: string[];
}

export function install(ctx: AppContext): void {
  installPortraitLock();
  const host = ctx.services.nomad;
  if (!host) return;
  const ui = new V2();
  ui.onPress = (kind) => ctx.audio?.play(kind === 'start' ? PokerSound.ButtonStart : PokerSound.ButtonGeneric);
  ctx.services.ui2 = ui;
  setUi(ui, ctx, host);
  (window as unknown as Record<string, unknown>).__ui2 = ui;

  const defs: ScreenDef[] = [
    ...lobbyScreens(),
    ...playScreens(),
    ...rewardScreens(),
    ...socialScreens(),
    ...shopScreens(),
    ...tournamentScreens(),
    ...agentScreens(),
    ...entryScreens(),
  ];
  const byUnity = new Map<string, string>();
  for (const d of defs) {
    ui.register(d);
    for (const u of d.replaces ?? []) byUnity.set(u, d.id);
  }
  wire(ctx, host, ui, byUnity);
  installEntryOverlays(ctx, host, ui);
  openNearTableLink(ctx.params, ui);
}

function wire(ctx: AppContext, host: NomadHost, ui: V2, byUnity: Map<string, string>): void {
  const origShow = host.show.bind(host);
  const origIsShowing = host.isShowing.bind(host);
  const origGoBack = host.goBack.bind(host);
  const origAttach = host.attach.bind(host);
  const origDetach = host.detach.bind(host);

  // A screen name → its v2 screen (then the host's onScreenShown hooks and refresh).
  host.show = (name: string) => {
    const id = byUnity.get(name);
    if (!id) {
      console.warn(`[ui2] no screen for '${name}'`);
      return;
    }
    if (ui.currentId !== id) ui.show(id);
    origShow(name);
  };
  // "Is Friends showing?": the open v2 screen answers for the names it replaces.
  host.isShowing = (name: string) => {
    const def = ui.currentId ? (ui.get(ui.currentId) as { replaces?: string[] } | undefined) : undefined;
    return !!def?.replaces?.includes(name) || origIsShowing(name);
  };
  // Escape / Android back: v2 dialog, then v2 screen's back target, then the host's own.
  host.goBack = () => {
    if (host.dialogs.isOpen) return origGoBack();
    if (ui.isOpen && ui.back()) return;
    if (ui.isOpen) return; // at the v2 main menu
    origGoBack();
  };
  host.attach = (parent: HTMLElement) => {
    parent.append(ui.el);
    origAttach(parent);
  };
  host.detach = () => {
    ui.hide();
    ui.el.remove();
    origDetach();
  };
  // Weekly rewards and missions open as v2 pages.
  host.actions.openWeeklyRewards = () => host.show('__v2:weekly');
  byUnity.set('__v2:weekly', 'weekly');
  host.actions.openMissions = () => host.show('LevelRewards');
  // Data changes repaint the open v2 screen.
  for (const ev of ['wallet:changed', 'account:changed', 'progression:changed', 'retention:changed', 'stake:changed', 'engagement:changed', 'agents:changed','tournaments:ready'])
    ctx.events.on(ev, () => ui.render());
  host.onRefresh(() => ui.render());
}
