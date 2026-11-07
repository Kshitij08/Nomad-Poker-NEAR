/** Shared plumbing for the retention overlays: build an extracted canvas, mount it full-screen, refresh on events. */
import type { AppContext, Screen } from '../../app/app';
import { whenFontsReady, type UNode } from '../../hud/unityUi';
import type { RetentionService } from '../retentionService';
import { CoroutineHost } from '../ui/coroutines';
import { OverlayCanvas, buildCanvas, refNode, type BuiltCanvas } from '../ui/retentionUi';

export abstract class PanelScreen implements Screen {
  readonly overlay = true;
  protected canvas: OverlayCanvas | null = null;
  protected built!: BuiltCanvas;
  protected root!: UNode;
  protected readonly host = new CoroutineHost();
  private readonly offs: (() => void)[] = [];
  private closed = false;

  constructor(protected readonly ctx: AppContext, private readonly canvasKey: string) {}

  protected get svc(): RetentionService | undefined {
    return this.ctx.services.retention;
  }

  mount(el: HTMLElement, params?: unknown): void {
    this.built = buildCanvas(this.canvasKey);
    this.root = this.built.root;
    this.build(params);
    this.canvas = new OverlayCanvas(el, this.root, this.built.data.scaler);
    this.root.setActive(true);
    this.afterMount();
    this.canvas.layout();
    whenFontsReady([this.root]);
  }

  unmount(): void {
    for (const off of this.offs.splice(0)) off();
    this.host.dispose();
    this.canvas?.dispose();
    this.canvas = null;
  }

  /** Wire the tree (Awake / Wire). The canvas is not laid out yet. */
  protected abstract build(params: unknown): void;
  /** OnEnable / Show: first paint after the canvas exists. */
  protected afterMount(): void {}

  protected ref(fields: Record<string, unknown> | undefined, key: string): UNode | null {
    return refNode(this.root, fields, key);
  }

  protected listen(event: string, fn: () => void): void {
    this.offs.push(this.ctx.events.on(event, fn));
  }

  /** Hide(): gameObject.SetActive(false) → the overlay closes. */
  protected hide(): void {
    if (this.closed) return;
    this.closed = true;
    const stack = (this.ctx.router as unknown as { stack?: { screen: Screen }[] }).stack;
    const top = stack?.at(-1)?.screen;
    if (!stack || top === this) this.ctx.router.back();
  }

  protected relayout(): void {
    this.canvas?.layout();
  }
}
