/**
 * Screens whose code needs @solana/web3.js (the private-table panels) load it on first open: the router screen is
 * registered from the boot chunk, and its implementation is a dynamic import plus `ctx.services.per.get()`. Until
 * both are in, the screen shows nothing (Unity's panels appear a frame later too); if loading fails, the error is
 * shown in a small PerUi panel instead of throwing.
 */
import type { AppContext, Screen } from '../../app/app';
import type { PerRuntime } from '../per/service';
import { w3 } from '../services';

/** What a lazily loaded panel module exports per screen. */
export interface PanelImpl {
  unmount(): void;
}
export type PanelFactory<P> = (ctx: AppContext, per: PerRuntime, root: HTMLElement, params: P) => PanelImpl;

export class LazyPanelScreen<P> implements Screen {
  readonly overlay = true;
  private impl: PanelImpl | null = null;
  private gone = false;
  private root: HTMLElement | null = null;
  /** Escape / Android back close the top panel (they used to trap the player over the menu). */
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.root) return;
    if (document.querySelector('.v2-global:not([hidden])')) return; // a dialog on top answers first
    const id = this.root.dataset.screen;
    if (id && this.ctx.router.current !== id) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    closeScreen(this.ctx, this.root);
  };

  constructor(
    private readonly ctx: AppContext,
    private readonly load: () => Promise<PanelFactory<P>>,
  ) {}

  async mount(root: HTMLElement, params?: unknown): Promise<void> {
    root.style.pointerEvents = 'auto';
    this.root = root;
    window.addEventListener('keydown', this.onKey, true);
    try {
      const [factory, per] = await Promise.all([this.load(), w3(this.ctx).per.get()]);
      if (this.gone) return;
      this.impl = factory(this.ctx, per, root, (params ?? {}) as P);
    } catch (e) {
      if (this.gone) return;
      console.error('[web3] private tables failed to load', e);
      const { PerCanvas, box, column, text, line, button, PerColor, friendlyError } = await import('./perUi');
      const canvas = new PerCanvas(root, 'PerError');
      box(canvas.root, 'Dim', PerColor.Dim, [0, 0], [1, 1]);
      const panel = box(canvas.root, 'Panel', PerColor.Panel, [0.3, 0.35], [0.7, 0.65]);
      const col = column(panel, 'Column', [0, 0], [1, 1]);
      text(col, '<b>Private tables</b>', 38);
      text(col, friendlyError("Couldn't open the private tables: " + (e instanceof Error ? e.message : String(e))), 22);
      const bottom = line(col, 64, PerColor.Clear);
      text(bottom, '', 20);
      button(bottom, 'Close', () => this.ctx.router.back(), PerColor.Muted, 180);
      this.impl = { unmount: () => canvas.dispose() };
    }
  }

  unmount(): void {
    this.gone = true;
    window.removeEventListener('keydown', this.onKey, true);
    this.impl?.unmount();
    this.impl = null;
  }
}

/** Closes `root`'s screen if it's still the top one (Router.back pops whatever is on top). */
export function closeScreen(ctx: AppContext, root: HTMLElement): void {
  const id = root.dataset.screen;
  if (root.isConnected && (!id || ctx.router.current === id)) ctx.router.back();
}
