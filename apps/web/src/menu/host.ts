/**
 * The Nomad menu host (from Net/NomadUi/NomadUiHost.cs): the menu scene's plumbing the Redesign v2 screens (src/ui2)
 * run on — screen navigation by name, the once-a-second refresh, the message box, the stake selection and the menu
 * actions other modules take over. It draws nothing itself: ui2/install.ts wraps show / isShowing / goBack / attach /
 * detach so every screen name (the Unity names are kept as the app's screen ids: 'MainMenu', 'Login', 'Friends'…)
 * opens its v2 screen. Other modules hook in through `registerNomadPartial` (see README.md).
 */
import type { AppContext } from '../app/app';
import { AvatarCatalog } from '@nomad/engine';
import { globalDialogs, type GlobalDialogs } from '../ui2/globalDialogs';
import { StakeSelection } from './stakes';
import { accountExtras } from './deps';

/** A module's hook on the host (NomadUiHost.Agents.cs etc. in Unity): runs once the host exists. */
export type NomadPartial = (host: NomadHost, ctx: AppContext) => void;
const partials: NomadPartial[] = [];
let instance: NomadHost | null = null;

/**
 * Registers a partial. Call it from your module's install(): the menu installs last and runs every registered partial
 * once (later registrations run immediately).
 */
export function registerNomadPartial(p: NomadPartial): void {
  partials.push(p);
  if (instance) instance.runPartial(p);
}

export class NomadHost {
  /** The game's one dialog layer (v2 dialogs: message, form, busy note, settings). */
  readonly dialogs: GlobalDialogs = globalDialogs();
  readonly stakes: StakeSelection;
  /**
   * Menu actions another module takes over: the daily spin, weekly rewards and missions (ui2 sets them; the retention
   * module's lucky slot screen is the fallback for the spin).
   */
  readonly actions: { openDailySpin?: () => void; openWeeklyRewards?: () => void; openMissions?: () => void } = {};

  private readonly shownHooks = new Map<string, ((name: string) => void)[]>();
  private readonly refreshHooks: (() => void)[] = [];
  private attached = false;
  private nextRefresh = 0;
  private timer = 0;

  constructor(readonly ctx: AppContext) {
    instance = this;
    this.stakes = new StakeSelection(ctx);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.attached) this.goBack();
    });
    for (const ev of ['wallet:changed', 'account:changed', 'progression:changed', 'retention:changed', 'stake:changed']) ctx.events.on(ev, () => this.refreshSoon());
    ctx.events.on('account:changed', () => this.onAccountChanged());
  }

  /** Runs the partials registered so far (called by install). */
  init(): void {
    for (const p of partials) this.runPartial(p);
  }

  runPartial(p: NomadPartial): void {
    try {
      p(this, this.ctx);
    } catch (e) {
      console.error('[menu] a Nomad partial failed to bind', e);
    }
  }

  // ------------------------------------------------------------------------------ mounting (the menu scene)

  /** The menu scene loads: the host shows Login or MainMenu and starts its refresh (NomadUiHost.Init). */
  attach(_parent: HTMLElement): void {
    this.attached = true;
    this.show(this.signedIn ? 'MainMenu' : 'Login');
    this.timer = window.setInterval(() => this.update(), 250);
  }

  detach(): void {
    this.attached = false;
    window.clearInterval(this.timer);
    this.closeConnecting();
  }

  get isAttached(): boolean {
    return this.attached;
  }

  private update(): void {
    if (performance.now() < this.nextRefresh) return;
    this.nextRefresh = performance.now() + 1000;
    this.refreshAll();
  }

  refreshSoon(): void {
    this.nextRefresh = 0;
    if (this.attached) queueMicrotask(() => this.update());
  }

  /** Runs every second while the menu is up (and right after refreshSoon). */
  onRefresh(fn: () => void): () => void {
    this.refreshHooks.push(fn);
    return () => this.refreshHooks.splice(this.refreshHooks.indexOf(fn), 1);
  }

  private refreshAll(): void {
    if (!this.signedIn && !this.isShowing('Login') && !accountExtras(this.ctx).keepSignedIn) this.show('Login');
    for (const fn of [...this.refreshHooks]) {
      try {
        fn();
      } catch (e) {
        console.error('[menu] refresh hook failed', e);
      }
    }
  }

  get signedIn(): boolean {
    return this.ctx.services.account.signedIn;
  }

  private onAccountChanged(): void {
    if (this.signedIn && this.isShowing('Login')) this.show('MainMenu');
    else if (!this.signedIn && !this.isShowing('Login') && !accountExtras(this.ctx).keepSignedIn) this.show('Login');
    this.refreshSoon();
  }

  // ------------------------------------------------------------------------------ screens (the v2 layer wraps these)

  /** Is this screen up? (ui2 answers for its screens.) */
  isShowing(_name: string): boolean {
    return false;
  }

  /** Shows a screen by name (ui2 opens the v2 screen that stands in for it). */
  show(name: string): void {
    this.onScreenShown(name);
  }

  /** `fn(name)` whenever that screen is shown; without `fn`, tells the hooks it was. */
  onScreenShown(name: string, fn?: (name: string) => void): () => void {
    if (fn) {
      const list = this.shownHooks.get(name) ?? [];
      list.push(fn);
      this.shownHooks.set(name, list);
      return () => list.splice(list.indexOf(fn), 1);
    }
    this.refreshSoon();
    for (const h of [...(this.shownHooks.get(name) ?? [])]) {
      try {
        h(name);
      } catch (e) {
        console.error('[menu] onScreenShown hook failed', name, e);
      }
    }
    return () => undefined;
  }

  goBack(): void {
    if (this.dialogs.isOpen) this.dialogs.close();
    else if (this.signedIn && !this.isShowing('MainMenu') && !this.isShowing('Login')) this.show('MainMenu');
  }

  // ------------------------------------------------------------------------------ message box

  /** Runs an op that returns an error (or null) and shows the error in the message box. */
  async run(op: () => Promise<string | null | undefined>, onOk?: () => void): Promise<void> {
    let error: string | null | undefined;
    try {
      error = await op();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error(e);
    }
    if (error) this.message('Something went wrong', error);
    else onOk?.();
    this.refreshSoon();
  }

  message(title: string, body: string, ok: string | null = 'OK', onOk?: () => void, cancel: string | null = null, onCancel?: () => void, inputPlaceholder: string | null = null, onInput?: (v: string) => void, inputValue: string | null = null): void {
    this.dialogs.message(title, body, ok, onOk, cancel, onCancel, inputPlaceholder, onInput, inputValue);
  }

  busy(title: string, text: string): void {
    this.dialogs.busyNote(title, text);
  }

  closeMessage(): void {
    this.dialogs.close();
  }

  /** Full-screen cover while Quick Play or Join Table looks for a room (Disconnect cancels). ui2 draws it. */
  showConnecting(_onDisconnect: () => void): void {}

  closeConnecting(): void {}

  // ------------------------------------------------------------------------------ static helpers

  static until(unix: number): string {
    const left = Math.floor(unix - Date.now() / 1000);
    if (left <= 0) return 'Started';
    if (left >= 86400) return `Starts in ${Math.floor(left / 86400)}d ${Math.floor((left % 86400) / 3600)}h`;
    if (left >= 3600) return `Starts in ${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m`;
    return `Starts in ${Math.max(1, Math.floor(left / 60))}m`;
  }
}

export function avatarId(avatar: number, name: string): string | null {
  return AvatarCatalog.idOf(AvatarCatalog.resolve(avatar, name));
}
