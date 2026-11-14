import type { AppContext, Screen } from '../app/app';
import { HandEvaluator, HUMAN_SEAT, PokerGameController, TEST_SCENE_TABLE_SETTINGS, type AudioPort, type TableSettings } from '@nomad/engine';
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
  /**
   * Optional: a table with no server behind it (the offline engine, the practice tournament). The table chrome then
   * keeps chat local (your messages in your own log) and draws your reactions itself, over your seat at the near HUD
   * slot (slot 0). Returns whether you hold that seat now (reactions are offered only then).
   */
  localPlayerSeated?(): boolean;
  /**
   * Optional: chat and reactions carried by a side channel (on-chain tables: web3/per/perSideChannel.ts). The table
   * chrome binds its chat drawer and reaction tray to them (netChrome ChatPort / ReactionPort).
   */
  readonly sideChannel?: { readonly chat: unknown; readonly reactions: unknown } | null;
}

export interface TableSessionHost {
  readonly view: TableView;
  readonly audio: AudioPort;
  readonly stage: TableStage;
  readonly ctx: AppContext;
  /** Ends the session and returns to `to` (default: the screen registered as 'menu', else stays). */
  leave(to?: string): void;
  /** Starts the same table again (same params): the offline Rebuy / Play again. */
  again(): void;
  /** The session this visit runs (null while the chrome is being built, before the session is made). */
  readonly session?: TableSession | null;
}

/** The message box the menu installs (host.dialogs, rendered as a v2 dialog), if any. */
type MessageBox = (title: string, body: string, ok: string | null, onOk?: () => void, cancel?: string | null, onCancel?: () => void) => void;
function messageBox(ctx: AppContext): MessageBox | null {
  const nomad = (ctx.services as unknown as { nomad?: { message?: MessageBox } }).nomad;
  return nomad?.message ? nomad.message.bind(nomad) : null;
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
    // Redesign v2: when the hand that busts you (or wins you the table) has been shown, say so and offer what's next,
    // instead of leaving the action row up with nothing to act on. The offline table is free: Rebuy starts it again.
    let told = false;
    let timer = 0;
    const tell = (won: boolean): void => {
      if (told || controller.stopped) return;
      told = true;
      host.view.betting?.hide();
      const box = messageBox(host.ctx);
      timer = window.setTimeout(() => {
        if (controller.stopped) return;
        host.view.betting?.hide(); // the last hand's presenter may have re-shown it
        document.documentElement.classList.add('v2t-tableover');
        if (!box) return host.leave();
        if (won) box('You won the table!', 'Every bot is out of chips. Play another table, or head back to the lobby.', 'Play again', () => host.again(), 'Back to lobby', () => host.leave());
        else box("You're out", 'Your stack is gone. Rebuy to keep playing at this table, or head back to the lobby.', 'Rebuy', () => host.again(), 'Back to lobby', () => host.leave());
      }, 1800);
    };
    const human = () => controller.engine.table.seats[HUMAN_SEAT];
    const p = controller.presenter as unknown as { onHandEnded(e: unknown): void; onGameOver(e: unknown): void };
    const handEnded = p.onHandEnded.bind(p);
    p.onHandEnded = (e) => {
      handEnded(e);
      const me = human();
      if (me && me.stack <= 0) tell(false);
    };
    // "Show cards": once a hand is decided, you may show cards that weren't shown at showdown (offline the bots
    // see it as your seat's "Shows · …" chip, like the online table).
    const showBtn = host.stage.hud.showCards;
    const pp = controller.presenter as unknown as { onHandStarted(e: unknown): void; onShowdown(e: { entries: { seat: number }[] }): void; onPotAwarded(e: unknown): void };
    let shown = false;
    const started = pp.onHandStarted.bind(pp);
    pp.onHandStarted = (e) => {
      shown = false;
      showBtn.hide();
      started(e);
    };
    const showdown = pp.onShowdown.bind(pp);
    pp.onShowdown = (e) => {
      if (e.entries.some((x) => x.seat === HUMAN_SEAT)) shown = true;
      showdown(e);
    };
    const awarded = pp.onPotAwarded.bind(pp);
    pp.onPotAwarded = (e) => {
      awarded(e);
      const me = human();
      const hole = me?.holeCards ?? [];
      if (shown || hole.length < 2) return;
      showBtn.offer(() => {
        shown = true;
        const board = controller.engine.table.community;
        let desc = 'Shows';
        try {
          if (board.length >= 3) desc = `Shows · ${HandEvaluator.evaluateHand(hole, board).describe()}`;
        } catch {
          /* plain "Shows" */
        }
        host.view.showShowdown(HUMAN_SEAT, hole[0]!, hole[1]!, desc);
      });
    };
    const gameOver = p.onGameOver.bind(p);
    p.onGameOver = (e) => {
      gameOver(e);
      const me = human();
      tell(!(me && me.stack <= 0));
    };
    return {
      // No server: chat and reactions stay on this screen (table chrome). You are seat 0, drawn at the near slot.
      localPlayerSeated: () => !controller.stopped && !!human(),
      start: () =>
        void controller.start().then(() => {
          // The loop ends without a GameOver when only you are left funded.
          const me = human();
          if (!controller.stopped && me && me.stack > 0 && controller.engine.countFundedPlayers() < 2) tell(true);
        }),
      stop: () => {
        window.clearTimeout(timer);
        showBtn.hide();
        document.documentElement.classList.remove('v2t-tableover');
        controller.stop();
      },
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
    const screen = this;
    const host: TableSessionHost = {
      view: this.stage.newView(),
      audio: this.ctx.audio,
      stage: this.stage,
      ctx: this.ctx,
      leave: (to) => void this.leave(to),
      again: () => void this.ctx.router.navigate('table', this.params),
      get session() {
        return screen.session;
      },
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
