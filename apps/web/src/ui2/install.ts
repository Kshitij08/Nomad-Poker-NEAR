/**
 * Redesign v2 (Screen Atlas). Installs after the Nomad menu and takes over the Unity screens it has a v2 version of:
 * when the menu host is asked to show one of those (by code or by the art's own SetActive navigation), the v2 layer
 * shows its screen instead and every Unity screen is hidden. Screens the atlas marks "Unchanged" (Login, Lucky Slot,
 * the message / busy dialogs…) stay Unity's; the v2 layer hides while they are up.
 */
import type { AppContext } from '../app/app';
// Base v2 styles first: the screens' own stylesheets (imported by the screen modules below) override them.
import './ui2.css';
import type { NomadHost } from '../menu/host';
import { V2, type V2Screen } from './core';
import { installPortraitLock } from './portraitLock';
import { setUi } from './ctx';
import { lobbyScreens } from './screens/lobby';
import { playScreens } from './screens/play';
import { rewardScreens } from './screens/rewards';
import { socialScreens } from './screens/social';
import { shopScreens } from './screens/shop';
import { tournamentScreens } from './screens/tournaments';
import { agentScreens } from './screens/agents';

declare module '../app/app' {
  interface Services {
    /** Redesign v2 screen layer (src/ui2). */
    ui2?: V2;
  }
}

/** Every v2 screen; `replaces` lists the Unity screens it stands in for. */
export interface ScreenDef extends V2Screen {
  replaces?: string[];
}

export function install(ctx: AppContext): void {
  installPortraitLock();
  const host = ctx.services.nomad;
  if (!host) return;
  // ?ui=unity keeps the old menus (comparison and fallback).
  if (typeof location !== 'undefined' && /[?&]ui=unity\b/.test(location.search)) return;

  const ui = new V2();
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
  ];
  const byUnity = new Map<string, string>();
  for (const d of defs) {
    ui.register(d);
    for (const u of d.replaces ?? []) byUnity.set(u, d.id);
  }
  wire(ctx, host, ui, byUnity);
}

function wire(ctx: AppContext, host: NomadHost, ui: V2, byUnity: Map<string, string>): void {
  const HIDE_ALL = '__ui2__';
  const origShow = host.show.bind(host);
  const origIsShowing = host.isShowing.bind(host);
  const origGoBack = host.goBack.bind(host);
  const origAttach = host.attach.bind(host);
  const origDetach = host.detach.bind(host);

  // A Unity screen the v2 layer replaces → its v2 screen; any other → Unity (v2 hides).
  host.show = (name: string) => {
    const id = byUnity.get(name);
    if (id) {
      origShow(HIDE_ALL);
      if (ui.currentId !== id) ui.show(id);
      return;
    }
    ui.hide();
    origShow(name);
  };
  // The art's own SetActive navigation turns a Unity screen on without host.show: redirect it the same way.
  for (const [name, id] of byUnity)
    host.onScreenShown(name, () => {
      queueMicrotask(() => {
        origShow(HIDE_ALL);
        if (ui.currentId !== id) ui.show(id);
      });
    });
  // Partials ask "is Friends showing?" before painting or prompting: answer for the v2 screen too.
  host.isShowing = (name: string) => {
    const id = byUnity.get(name);
    if (id && ui.currentId) {
      const def = ui.get(ui.currentId) as { replaces?: string[] } | undefined;
      if (def?.replaces?.includes(name)) return true;
    }
    return origIsShowing(name);
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
  for (const ev of ['wallet:changed', 'account:changed', 'progression:changed', 'retention:changed', 'stake:changed', 'engagement:changed', 'agents:changed', 'web3:wallet-changed', 'tournaments:ready'])
    ctx.events.on(ev, () => ui.render());
  host.onRefresh(() => ui.render());
}
