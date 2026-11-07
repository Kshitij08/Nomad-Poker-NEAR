import type { AppContext, Screen } from '../app/app';
import { PokerGameController, TEST_SCENE_TABLE_SETTINGS, type AudioPort, type TableSettings } from '../core';
import type { TableStage } from './tableStage';
import { tickerWait, type TableView } from './tableView';

/**
 * What drives a table: the offline engine (PokerGameController), a network client mirroring a server's
 * events, a tournament table, a replay… Each gets a fresh TableView and the shared audio, and is stopped
 * when the player leaves the table.
 */
export interface TableSession {
  start(): void | Promise<void>;
  stop(): void;
  /**
   * Optional: runs when the player chooses to leave, BEFORE stop(), while the table is still live — e.g. an
   * on-chain cash-out that must finish at the table (PER/escrow). leave() awaits it, then stops the session.
   */
  requestLeave?(): Promise<void>;
}

export interface TableSessionHost {
  readonly view: TableView;
  readonly audio: AudioPort;
  readonly stage: TableStage;
  readonly ctx: AppContext;
  /** Ends the session and returns to `to` (default: the screen registered as 'menu', else stays). */
  leave(to?: string): void;
}

export type TableSessionFactory = (host: TableSessionHost) => TableSession;

export interface TableScreenParams {
  /** Defaults to the offline single-player engine with Test.unity's settings. */
  session?: TableSessionFactory;
  /** Offline only: overrides on TEST_SCENE_TABLE_SETTINGS (blinds, stack, bots…). */
  settings?: Partial<TableSettings>;
  /** Called after the session stops (e.g. to cash out); runs before navigating away. */
  onLeave?: () => void | Promise<void>;
}

/** The single-player table Unity runs when no NetworkRunner exists (PokerGameController). */
export function offlineSession(settings?: Partial<TableSettings>): TableSessionFactory {
  return (host) => {
    const controller = new PokerGameController({ ...TEST_SCENE_TABLE_SETTINGS, ...settings }, host.view, host.audio, { wait: tickerWait });
    (window as unknown as Record<string, unknown>).__controller = controller;
    return {
      start: () => void controller.start(),
      stop: () => controller.stop(),
    };
  };
}

/** Hooks other modules use to add table chrome (leave button, chat, reactions…) on every table visit. */
export type TableChrome = (host: TableSessionHost, layer: HTMLElement) => () => void;
const chrome: TableChrome[] = [];
export function addTableChrome(c: TableChrome): void {
  chrome.push(c);
}

export class TableScreen implements Screen {
  private session: TableSession | null = null;
  private disposers: (() => void)[] = [];
  private params: TableScreenParams = {};

  constructor(
    private readonly ctx: AppContext,
    private readonly stage: TableStage,
  ) {}

  mount(root: HTMLElement, params?: unknown): void {
    this.params = (params as TableScreenParams) ?? {};
    root.classList.add('screen-table');
    this.stage.setVisible(true);
    const host: TableSessionHost = {
      view: this.stage.newView(),
      audio: this.ctx.audio,
      stage: this.stage,
      ctx: this.ctx,
      leave: (to) => void this.leave(to),
    };
    for (const c of chrome) this.disposers.push(c(host, root));
    const factory = this.params.session ?? offlineSession(this.params.settings);
    this.session = factory(host);
    void this.session.start();
  }

  private async leave(to?: string): Promise<void> {
    try {
      await this.session?.requestLeave?.();
    } catch (err) {
      console.warn('[table] requestLeave failed; leaving anyway', err);
    }
    this.session?.stop();
    this.session = null;
    await this.params.onLeave?.();
    const target = to ?? (this.ctx.router.has('menu') ? 'menu' : null);
    if (target) await this.ctx.router.navigate(target);
  }

  unmount(): void {
    this.session?.stop();
    this.session = null;
    for (const d of this.disposers.splice(0)) d();
    this.stage.newView(); // clear the felt for next time
    this.stage.setVisible(false);
  }
}
