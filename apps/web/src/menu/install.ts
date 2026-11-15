import type { AppContext, Screen } from '../app/app';
import { addTableChrome } from '../table/tableScreen';
import { NomadHost, registerNomadPartial } from './host';
import { nomadTableChrome } from './table/nomadTableHud';
import { PokerAudio } from './audio';
import { PokerFunnel } from './funnel';
import '../hud/hud.css'; // .u-gfx / .u-text / .u-slice base styles (the table HUD imports it too)
import './menu.css';

declare module '../app/app' {
  interface Services {
    /** The Nomad menu host: screen navigation, dialogs, stakes, refresh. See src/menu/README.md. */
    nomad?: NomadHost;
  }
}

export { registerNomadPartial };

/**
 * The menu scene as a router screen: mounting it is the menu scene loading (the host shows Login or MainMenu and
 * starts its once-a-second refresh); unmounting is the table scene replacing it.
 */
class MenuScreen implements Screen {
  constructor(private readonly host: NomadHost) {}
  mount(root: HTMLElement): void {
    root.classList.add('screen-menu');
    this.host.attach(root);
  }
  unmount(): void {
    this.host.detach();
  }
}

/** Installs the Nomad menu: ctx.services.nomad, the 'menu' screen, and the table chrome (Settings, LEAVE). */
export function install(ctx: AppContext): void {
  PokerAudio.attach(ctx);
  PokerFunnel.sessionStarted();
  window.addEventListener('pagehide', () => PokerFunnel.quitting());
  const host = new NomadHost(ctx);
  ctx.services.nomad = host;
  // The other modules' partials (registered from their install()).
  host.init();
  ctx.router.register('menu', () => new MenuScreen(host));
  addTableChrome(nomadTableChrome(host));
  (window as unknown as Record<string, unknown>).__nomad = host;
}
