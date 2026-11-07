import type { AppContext } from '../app/app';
import { addTableChrome } from '../table/tableScreen';
import { netTableChrome } from './chrome/netChrome';
import { NetService } from './netService';

declare module '../app/app' {
  interface Services {
    /** Multiplayer against the local table server (web/server): Quick Play, party rooms, reconnect. */
    net?: NetService;
  }
}

/**
 * Installs the net module (Unity's Net/: Photon Fusion client + PokerClientGame → the local WebSocket table server):
 * - ctx.services.net (NetService): quickPlay / freePlayJoin (the menu calls these), createParty / joinParty(code),
 *   reconnect, cancelSearch, `current` (the live NetTableSession), and the tournaments module's joinHandler;
 * - table chrome for networked tables: chat, reactions, Join table / Start game / Add bot / room code, the private
 *   buy-in prompt and (with ?voice=1) the seat mic.
 * Debug: `?net=quick` / `?net=create` / `?net=<CODE>` join straight away; `?netPlayer=Name` gives a tab its own
 * identity; `?netServer=ws://host:port` points at another local server.
 */
export function install(ctx: AppContext): void {
  const service = new NetService(ctx);
  ctx.services.net = service;
  addTableChrome(netTableChrome(ctx, service));

  const auto = ctx.params.get('net');
  if (auto) {
    setTimeout(() => {
      // A reload of a tab that was at a table goes back to that table (inside the seat's grace) instead of
      // starting over — what Unity's reconnect does for a page reload.
      let last: string | null = null;
      try {
        last = sessionStorage.getItem('Poker.Net.LastSession');
      } catch {
        /* ignore */
      }
      const go =
        last ? service.reconnect().then(() => undefined)
        : auto === 'quick' ? service.quickPlay()
        : auto === 'create' ? service.createParty()
        : auto === 'reconnect' ? service.reconnect().then(() => undefined)
        : service.joinParty(auto);
      go.catch((e) => console.error('[Net]', e instanceof Error ? e.message : e));
    }, 300);
  }
}
