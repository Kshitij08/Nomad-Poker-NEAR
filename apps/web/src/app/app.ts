/**
 * The app shell: screens, a router, and the services registry every module plugs into.
 *
 * Unity splits the game into a menu scene (FusionSampleMenu_Game: wallet login, the Fusion "Nomad" menu,
 * RetentionHud, ThemeManager) and the table scene (Test.unity) loaded on top of it. Here each of those is a
 * Screen; the router swaps them inside #screens and keeps the 3D table stage (#stage) alive across visits.
 *
 * Modules add their services without touching this file, by augmenting `Services`:
 *
 *   declare module '../app/app' { interface Services { retention: RetentionService } }
 *   ctx.services.retention = new RetentionService(ctx);       // in the module's install()
 *
 * and register their screens with `ctx.router.register('daily-spin', (ctx) => new DailySpinScreen(ctx))`.
 */
import type { WebAudio } from '../audio/webAudio';

/** A full-screen view. mount() may be async; unmount() must release DOM, listeners and tweens. */
export interface Screen {
  mount(root: HTMLElement, params?: unknown): void | Promise<void>;
  unmount(): void;
  /** Optional: overlays (popups/panels) keep the screen below mounted. */
  readonly overlay?: boolean;
}

export type ScreenFactory = (ctx: AppContext) => Screen;

/** Services registry. Modules extend this interface via declaration merging (see file comment). */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Services {}

export interface AppContext {
  readonly router: Router;
  readonly services: Services;
  readonly audio: WebAudio;
  /** Query-string flags (debug: speed, paused, demo, offline…). */
  readonly params: URLSearchParams;
  /** Small app-wide event bus (e.g. 'wallet:changed', 'theme:changed', 'account:changed'). */
  readonly events: EventBus;
}

export class EventBus {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  on<T = unknown>(event: string, fn: (payload: T) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn as (p: unknown) => void);
    return () => set!.delete(fn as (p: unknown) => void);
  }
  emit<T = unknown>(event: string, payload?: T): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(payload);
  }
}

interface Entry {
  id: string;
  screen: Screen;
  el: HTMLElement;
}

/** Screen stack: navigate() replaces the base screen, push() opens an overlay on top, back() pops. */
export class Router {
  private readonly factories = new Map<string, ScreenFactory>();
  private readonly stack: Entry[] = [];
  private ctx!: AppContext;

  constructor(private readonly root: HTMLElement) {}

  attach(ctx: AppContext): void {
    this.ctx = ctx;
  }

  register(id: string, factory: ScreenFactory): void {
    this.factories.set(id, factory);
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  get current(): string | null {
    return this.stack.at(-1)?.id ?? null;
  }

  /** Replaces everything with screen `id`. */
  async navigate(id: string, params?: unknown): Promise<void> {
    while (this.stack.length) this.popTop();
    await this.open(id, params);
    this.ctx.events.emit('router:changed', id);
  }

  /** Opens `id` on top of the current screen (popups, panels). */
  async push(id: string, params?: unknown): Promise<void> {
    await this.open(id, params);
    this.ctx.events.emit('router:changed', id);
  }

  /** Screens open (1 = only the base screen). */
  get depth(): number {
    return this.stack.length;
  }

  /** Closes the top screen. */
  back(): void {
    if (this.stack.length > 1) this.popTop();
    this.ctx.events.emit('router:changed', this.current);
  }

  private async open(id: string, params?: unknown): Promise<void> {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`[router] no screen registered as '${id}'`);
    const screen = factory(this.ctx);
    const el = document.createElement('div');
    el.className = 'screen';
    el.dataset.screen = id;
    el.style.zIndex = String(10 + this.stack.length);
    this.root.append(el);
    this.stack.push({ id, screen, el });
    await screen.mount(el, params);
  }

  private popTop(): void {
    const top = this.stack.pop();
    if (!top) return;
    try {
      top.screen.unmount();
    } finally {
      top.el.remove();
    }
  }
}

/** A module: installs services and registers screens. Called once at boot, in order. */
export type AppModule = (ctx: AppContext) => void | Promise<void>;
