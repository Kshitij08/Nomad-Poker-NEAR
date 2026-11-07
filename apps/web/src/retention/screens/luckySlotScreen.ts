/**
 * The Lucky Slot as a standalone overlay (router id 'lucky-slot', params { screen?: 'win' | 'lost' }), for places
 * outside the Nomad menu. Inside the menu, retention's Nomad partial binds the menu's own LuckySlot_Win / _Lost
 * screens with the same controller (nomad/luckySlot.ts).
 */
import type { AppContext, Screen } from '../../app/app';
import { whenFontsReady } from '../../hud/unityUi';
import { LuckySlotController, plainNote, type SlotScreen } from '../nomad/luckySlot';
import { CoroutineHost } from '../ui/coroutines';
import { OverlayCanvas, buildCanvas, wireButton } from '../ui/retentionUi';

export class LuckySlotScreen implements Screen {
  readonly overlay = true;
  private readonly host = new CoroutineHost();
  private canvases: Record<SlotScreen, OverlayCanvas> | null = null;
  private controller: LuckySlotController | null = null;
  private showing: SlotScreen = 'win';
  private off: (() => void)[] = [];

  constructor(private readonly ctx: AppContext) {}

  mount(el: HTMLElement, params?: unknown): void {
    const p = (params ?? {}) as { screen?: SlotScreen };
    const make = (key: 'luckyWin' | 'luckyLost') => {
      const built = buildCanvas(key);
      const canvas = new OverlayCanvas(el, built.root, built.data.scaler);
      canvas.host.style.display = 'none';
      built.root.setActive(true);
      whenFontsReady([built.root]);
      wireButton(this.ctx, built.root.find('Btn_Back'), () => this.close());
      return canvas;
    };
    const canvases = (this.canvases = { win: make('luckyWin'), lost: make('luckyLost') });
    this.controller = new LuckySlotController(this.ctx, this.host, {
      roots: { win: canvases.win.root, lost: canvases.lost.root },
      show: (which) => this.show(which),
      isShowing: (which) => this.showing === which && canvases[which].host.style.display !== 'none',
      message: (_title, body) => canvases[this.showing].root.find('Content/SpinNote')?.setText(body),
      bindSpin: (node, onClick) => wireButton(this.ctx, node, onClick),
      newNote: (content, text) => plainNote(content, text),
      signedIn: true,
    });
    this.off.push(this.ctx.events.on('engagement:changed', () => this.controller?.paint(this.showing)));
    if (p.screen === 'lost') this.show('lost');
    else this.controller.open();
  }

  private show(which: SlotScreen): void {
    const c = this.canvases;
    if (!c) return;
    this.showing = which;
    for (const k of ['win', 'lost'] as const) c[k].host.style.display = k === which ? '' : 'none';
    c[which].layout();
    this.controller?.onShown(which);
  }

  unmount(): void {
    for (const o of this.off.splice(0)) o();
    this.controller?.dispose();
    if (this.canvases) for (const c of Object.values(this.canvases)) c.dispose();
    this.host.dispose();
    this.canvases = null;
  }

  private close(): void {
    if (this.ctx.router.current === 'lucky-slot') this.ctx.router.back();
  }
}
