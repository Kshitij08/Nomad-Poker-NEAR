/**
 * Router overlay helpers shared by the web3 module's screens (wallet picker, private buy-in). The private-table
 * panels that used to load lazily here are Redesign v2 pages now (src/ui2/screens).
 */
import type { AppContext } from '../../app/app';

/** Closes `root`'s screen if it's still the top one (Router.back pops whatever is on top). */
export function closeScreen(ctx: AppContext, root: HTMLElement): void {
  const id = root.dataset.screen;
  if (root.isConnected && (!id || ctx.router.current === id)) ctx.router.back();
}
