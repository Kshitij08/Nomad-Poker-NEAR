/**
 * Port of Net/NomadUi/NomadUiHost.cs: the Nomad menu. Builds the art team's screens (PokerUI.unity, extracted to
 * data/menu-ui.json), keeps their own SetActive navigation (Button persistent calls), and binds every control by NAME
 * to the game's systems. Other modules add their screens' wiring as partials (NomadUiHost.Agents / .Onchain / .Social /
 * .Tournaments in Unity) through `registerNomadPartial` — see README.md for the API.
 */
import type { AppContext } from '../app/app';
import type { UNode } from '../hud/unityUi';
import { AvatarCatalog, formatN0 } from '../core';
import { MENU_DATA, nodeDataAt, type MenuCanvasData } from './data';
import { NomadDialogs, fitText } from './dialogs';
import { StakeSelection } from './stakes';
import { ScreenCanvas, destroy, imageComp, instantiate, make, newImage, newText, setRuntimeEnv, stretch, synth } from './ui/canvas';
import { addButton, applyAspectFitters, rebuildLayouts, buildTree, nodeData, refreshOrnaments, runLayout, widgetsOf, type MButton, type TreeEnv } from './ui/tree';
import { accountExtras } from './deps';
import type { PersistentCall } from './data';

/** NomadUiHost.ScreenNames. */
export const SCREEN_NAMES = [
  'Login', 'MainMenu', 'TableSelect_TownLobby', 'Friends', 'PartyMenu',
  'Tournaments_Browse', 'Tournaments_MyTournaments', 'Tournaments_Host', 'Tournaments_JoinByCode',
  'Leaderboard', 'Agents_Overview', 'Agents_Strategy', 'Agents_SessionHistory',
  'LevelRewards', 'LuckySlot_Win', 'LuckySlot_Lost',
] as const;
export type ScreenName = (typeof SCREEN_NAMES)[number];

/** Screens whose content keeps the 16:9 frame (Fit169), a little inside the screen edge; backgrounds still fill. */
const FRAMED = ['Agents_Overview', 'Agents_Strategy', 'Agents_SessionHistory', 'Tournaments_Browse', 'Tournaments_MyTournaments', 'Tournaments_Host', 'Tournaments_JoinByCode', 'Friends', 'Leaderboard', 'LevelRewards', 'TableSelect_TownLobby', 'PartyMenu'];
const FRAME_169 = 'Frame169';
const FRAME_SCALE = 0.94;

/** A partial of the host from another module (NomadUiHost.Agents.cs etc.): binds its screens' controls. */
export type NomadPartial = (host: NomadHost, ctx: AppContext) => void;
const partials: NomadPartial[] = [];
let instance: NomadHost | null = null;

/**
 * Registers a partial. Call it from your module's install(): the menu installs last and runs every registered partial
 * once its screens exist (later registrations run immediately).
 */
export function registerNomadPartial(p: NomadPartial): void {
  partials.push(p);
  if (instance) instance.runPartial(p);
}

type Root = UNode | string | null | undefined;

export class NomadHost {
  readonly dialogs = new NomadDialogs();
  readonly stakes: StakeSelection;
  /** ONCHAIN mode (the web3 partial sets it; DEMO = Coins by default). Screens read it to pick Coins or SOL. */
  onchain = false;
  /** The SOL capsule text in ONCHAIN mode ("$0"), set by the web3 partial. */
  solShort = '$0';
  readonly el = document.createElement('div');
  /**
   * Menu actions a partial may take over (NomadUiHost methods that live in other partials in Unity): the daily spin
   * (.Agents.cs: shows LuckySlot_Win), weekly rewards and missions (retention).
   */
  readonly actions: { openDailySpin?: () => void; openWeeklyRewards?: () => void; openMissions?: () => void } = {};

  private readonly screens = new Map<string, UNode>();
  private readonly canvases: ScreenCanvas[] = [];
  private readonly shownHooks = new Map<string, ((name: string) => void)[]>();
  private readonly refreshHooks: (() => void)[] = [];
  private readonly persistentHandlers = new Map<string, (call: PersistentCall, from: UNode) => void>();
  private attached = false;
  private nextRefresh = 0;
  private timer = 0;
  private connecting: { layer: HTMLDivElement; canvas: ScreenCanvas } | null = null;
  readonly env: TreeEnv;

  constructor(readonly ctx: AppContext) {
    instance = this;
    this.stakes = new StakeSelection(ctx);
    this.el.className = 'nm-screens';
    this.env = {
      playSound: (s) => ctx.audio.play(s),
      persistentCall: (call, from) => {
        const h = this.persistentHandlers.get(call.method);
        if (!h) return false;
        h(call, from);
        return true;
      },
    };
    setRuntimeEnv(this.env);
    for (const name of SCREEN_NAMES) {
      const data = MENU_DATA.canvases.find((c) => c.name === name);
      if (data) this.buildScreen(data);
    }
    for (const name of FRAMED) this.fit169(this.screen(name));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.attached) this.goBack();
    });
    for (const ev of ['wallet:changed', 'account:changed', 'progression:changed', 'retention:changed', 'stake:changed']) ctx.events.on(ev, () => this.refreshSoon());
    ctx.events.on('account:changed', () => this.onAccountChanged());
  }

  private buildScreen(data: MenuCanvasData): void {
    const root = buildTree(data.root, this.env);
    const holder = document.createElement('div');
    holder.className = 'nm-screen';
    holder.dataset.screen = data.name;
    this.el.append(holder);
    this.canvases.push(new ScreenCanvas(holder, root));
    this.screens.set(data.name, root);
    // NomadScreenHook: tells the host when a screen is shown (by the art's SetActive navigation or by Show).
    root.onEnable.push(() => this.onScreenShown(data.name));
  }

  /** Runs the Init sequence after the menu's own binders (called by install). */
  init(binders: ((host: NomadHost) => void)[]): void {
    for (const b of binders) b(this);
    for (const p of partials) this.runPartial(p);
    for (const [, root] of this.screens) {
      this.hidePlaceholders(root);
      this.fitTexts(root);
    }
    this.shortenCopy();
  }

  runPartial(p: NomadPartial): void {
    try {
      p(this, this.ctx);
    } catch (e) {
      console.error('[menu] a Nomad partial failed to bind', e);
    }
  }

  // ------------------------------------------------------------------------------ mounting (the menu scene)

  /** The menu scene loads: screens go on screen and the host shows Login or MainMenu (NomadUiHost.Init). */
  attach(parent: HTMLElement): void {
    parent.append(this.el);
    this.attached = true;
    for (const c of this.canvases) c.layout();
    this.show(this.signedIn ? 'MainMenu' : 'Login');
    this.timer = window.setInterval(() => this.update(), 250);
  }

  detach(): void {
    this.attached = false;
    window.clearInterval(this.timer);
    this.el.remove();
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

  private readonly menuPainters: (() => void)[] = [];
  /** The menu's own per-second painters (PaintLogin, PaintTopBars, PaintMainMenu…), run before partial hooks. */
  addPainter(fn: () => void): void {
    this.menuPainters.push(fn);
  }

  private refreshAll(): void {
    if (!this.signedIn && !this.isShowing('Login') && !accountExtras(this.ctx).keepSignedIn) this.show('Login');
    for (const fn of this.menuPainters) fn();
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
    if (this.signedIn && this.isShowing('Login')) {
      this.show('MainMenu');
      for (const fn of this.afterGuest) fn();
    } else if (!this.signedIn && !this.isShowing('Login') && !accountExtras(this.ctx).keepSignedIn) this.show('Login');
    this.refreshSoon();
  }
  /** OfferWalletAfterGuest hooks (web3 partial). */
  readonly afterGuest: (() => void)[] = [];

  // ------------------------------------------------------------------------------ screens

  /** A screen's root node. */
  screen(name: string): UNode | null {
    return this.screens.get(name) ?? null;
  }

  get screenNames(): string[] {
    return [...this.screens.keys()];
  }

  isShowing(name: string): boolean {
    return !!this.screens.get(name)?.activeSelf;
  }

  /** Shows one screen and hides the others (the art's own buttons do the same with SetActive). */
  show(name: string): void {
    for (const [k, root] of this.screens) if (k !== name) root.setActive(false);
    const r = this.screens.get(name);
    if (r) {
      if (!r.activeSelf) r.setActive(true);
      else this.onScreenShown(name);
    }
    this.refreshSoon();
  }

  /** Called whenever a screen becomes active; `fn(name)`. */
  onScreenShown(name: string, fn?: (name: string) => void): () => void {
    if (fn) {
      const list = this.shownHooks.get(name) ?? [];
      list.push(fn);
      this.shownHooks.set(name, list);
      return () => list.splice(list.indexOf(fn), 1);
    }
    const root = this.screens.get(name);
    if (root) this.afterLayout(root);
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

  /** Aspect fitters and title ornaments need the laid-out sizes. */
  afterLayout(root: UNode): void {
    rebuildLayouts(root);
    applyAspectFitters(root);
    refreshOrnaments(root);
  }

  goBack(): void {
    if (this.dialogs.isOpen) {
      this.dialogs.close();
      return;
    }
    if (!this.signedIn || this.isShowing('MainMenu') || this.isShowing('Login')) return;
    this.show('MainMenu');
  }

  // ------------------------------------------------------------------------------ helpers (NomadUiHost statics)

  private rootOf(r: Root): UNode | null {
    return typeof r === 'string' ? this.screen(r) : (r ?? null);
  }

  /** A child by path ("A/B/C", also under Frame169) or, for a bare name, the first descendant with that name. */
  find(root: Root, path: string): UNode | null {
    const r = this.rootOf(root);
    if (!r || !path) return null;
    if (path.includes('/')) return r.find(path) ?? r.find(FRAME_169 + '/' + path);
    return findDeep(r, path);
  }

  /** TMP text (or the single TMP child of a non-button node). */
  setText(root: Root, path: string, text: string, onlyIfText = false): void {
    const t = this.find(root, path);
    if (!t) return;
    if (t.text) t.setText(text);
    else if (!onlyIfText && !widgetsOf(t).button && t.children.length === 1) {
      const child = [...t.walk()].find((n) => n !== t && n.text);
      child?.setText(text);
    }
  }

  setActive(root: Root, path: string, on: boolean): void {
    const t = this.find(root, path);
    if (t && t.activeSelf !== on) t.setActive(on);
  }

  /**
   * Binds a button to `action`. `replaceNavigation` turns off the scene's own onClick calls (for buttons that must do
   * something first). Adds a Button (and a raycast target) when the node has none, like the C#.
   */
  bind(root: Root, path: string, action: (() => void) | null, replaceNavigation = false): MButton | null {
    const r = this.rootOf(root);
    const t = this.find(r, path);
    if (!t) {
      console.warn(`[NomadUi] ${r?.name ?? '?'}: no '${path}'`);
      return null;
    }
    const b = this.ensureButton(t);
    if (replaceNavigation) b.disablePersistent();
    if (action) b.addListener(action);
    return b;
  }

  /** EnsureClickable + GetComponent<Button>() ?? AddComponent<Button>() (default ColorTint over its own graphic). */
  ensureButton(t: UNode): MButton {
    this.ensureClickable(t);
    return addButton(t, this.env);
  }

  /** EnsureClickable: the element takes clicks (its graphic as a raycast target, or an invisible one). */
  ensureClickable(t: UNode): void {
    t.el.classList.add('nm-hit');
    widgetsOf(t).raycast = true;
  }

  /** Sets a bar's fill (0..1): the fill is stretched across its container from the left. */
  setFill(root: Root, path: string, f: number): void {
    const t = this.find(root, path);
    if (!t) return;
    f = Math.max(0, Math.min(1, f));
    t.anchorMin = [0, t.anchorMin[1]];
    t.anchorMax = [f, t.anchorMax[1]];
    const offMinY = t.anchoredPosition[1] - t.sizeDelta[1] * t.pivot[1];
    const offMaxY = offMinY + t.sizeDelta[1];
    t.sizeDelta = [0, offMaxY - offMinY];
    t.anchoredPosition = [0, offMinY + t.sizeDelta[1] * t.pivot[1]];
    if (t.parent?.activeInHierarchy) t.layout();
  }

  /** A repeating list (NomadUiHost.RowList). */
  rowList(container: UNode | null, prefix: string): RowList {
    return new RowList(container, prefix);
  }

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
    this.dialogs.busy(title, text);
  }

  closeMessage(): void {
    this.dialogs.close();
  }

  /** A persistent onClick method other than SetActive (e.g. the art's RetentionMenuHud.OpenLoginRewards). */
  handlePersistent(method: string, fn: (call: PersistentCall, from: UNode) => void): void {
    this.persistentHandlers.set(method, fn);
  }

  /** A note centred over an empty list ("No friends yet…"); hidden when the list has rows. */
  emptyNote(list: UNode | null, text: string, show: boolean): void {
    if (!list) return;
    let note = this.find(list, 'EmptyNote');
    if (!note) {
      if (!show) return;
      note = newText(list, 'EmptyNote', text, 28, false, [0, 0], [600, 120]);
      note.anchorMin = [0.1, 0.3];
      note.anchorMax = [0.9, 0.7];
      note.sizeDelta = [0, 0];
      note.setTextColor({ r: 0.62, g: 0.69, b: 0.85, a: 1 });
    }
    note.setText(text);
    note.setActive(show);
    note.setAsLastSibling();
    if (list.activeInHierarchy) note.layout();
  }

  /** Labels that belong together at one size: the smallest that fits all of them. */
  evenSizes(texts: (UNode | null)[]): void {
    let size = Infinity;
    for (const t of texts) {
      if (!t?.text || !t.text.text) continue;
      t.text.autoSize = true;
      t.invalidateText();
      if (t.parent?.activeInHierarchy) t.layout();
      size = Math.min(size, fittedSize(t));
    }
    if (!Number.isFinite(size)) return;
    for (const t of texts) if (t?.text) {
      t.text.autoSize = true;
      t.text.max = size;
      t.invalidateText();
      if (t.parent?.activeInHierarchy) t.layout();
    }
  }

  /** Avatar art for a player (AvatarLibrary.For: the picked face, else the name's FNV-1a default). */
  setAvatar(root: Root, path: string, playerName: string, avatar?: number): void {
    const n = this.find(root, path);
    if (!n?.image) return;
    const id = avatarId(avatar ?? this.ctx.services.account.avatar, playerName);
    if (!id) return;
    const file = `assets/ui/Test/UI/Common_UI/Pro_Pic/${id}.webp`;
    if (n.image.sprite?.file === file) return;
    n.image.sprite = { ...(n.image.sprite ?? { ppu: 100, rect: [0, 0, 1, 1], border: [0, 0, 0, 0] }), name: id, file, border: [0, 0, 0, 0] };
    n.image.type = 'Simple';
    n.render();
  }

  // ------------------------------------------------------------------------------ Connecting cover

  /** Full-screen cover while Quick Play or Join Table looks for a room (Disconnect cancels). */
  showConnecting(onDisconnect: () => void): void {
    this.closeConnecting();
    const layer = document.createElement('div');
    layer.className = 'nm-layer nm-connecting-layer';
    document.body.append(layer);
    const root = make(null, synth('Connecting', { rect: { anchorMin: [0, 0], anchorMax: [1, 1], sizeDelta: [0, 0] } }));
    const dim = newImage(root, 'Dim', { r: 0.04, g: 0.05, b: 0.12, a: 1 });
    stretch(dim);
    const panel = newImage(root, 'Panel', { r: 0.1, g: 0.08, b: 0.22, a: 1 }, [640, 280]);
    newText(panel, 'Title', 'Connecting', 40, true, [0, 70], [560, 60]);
    newText(panel, 'Body', 'Looking for an open room. This can take a moment.', 26, false, [0, 5], [560, 80]);
    const btn = make(panel, synth('Btn_Disconnect', { rect: { anchoredPosition: [0, -90], sizeDelta: [260, 72] }, components: { image: imageComp({ r: 0.98, g: 0.76, b: 0.18, a: 1 }) } }));
    const label = newText(btn, 'Label', 'Disconnect', 30, true, [0, 0], [250, 70]);
    label.setTextColor({ r: 0.12, g: 0.08, b: 0.25, a: 1 });
    this.ensureButton(btn).addListener(() => {
      this.closeConnecting();
      onDisconnect();
    });
    this.connecting = { layer, canvas: new ScreenCanvas(layer, root) };
  }

  closeConnecting(): void {
    if (!this.connecting) return;
    this.connecting.canvas.dispose();
    this.connecting.layer.remove();
    this.connecting = null;
  }

  // ------------------------------------------------------------------------------ init passes

  /** Moves a screen's content (all but its "BG…" backgrounds) into a centred 1920x1080 frame at 94 %. */
  private fit169(root: UNode | null): void {
    if (!root || root.find(FRAME_169)) return;
    const frame = make(null, synth(FRAME_169, { rect: { sizeDelta: [1920, 1080], scale: [FRAME_SCALE, FRAME_SCALE, 1] } }));
    const move = root.children.filter((c) => !c.name.startsWith('BG'));
    root.add(frame);
    for (const c of move) {
      root.children.splice(root.children.indexOf(c), 1);
      frame.add(c);
    }
  }

  /** The art's "*_PLACEHOLDER" objects stay hidden. */
  private hidePlaceholders(root: UNode): void {
    for (const n of root.walk()) if (n.name.endsWith('_PLACEHOLDER') && n.activeSelf) n.setActive(false);
  }

  /** Every label shrinks to fit (down to 65 % of its size, never under 12) and ends with "…" if it still doesn't. */
  fitTexts(root: UNode): void {
    const walk = (n: UNode, inInput: boolean) => {
      const inside = inInput || !!widgetsOf(n).input;
      if (n.text && !inside) {
        const size = n.text.autoSize ? n.text.max : n.text.fontSize;
        fitText(n, size, Math.min(size, Math.max(12, size * 0.65)));
      }
      for (const c of n.children) walk(c, inside);
    };
    walk(root, false);
  }

  /** Art text that wrapped into the field under it (UI pass 20 Oct): shorter wording, one line. */
  private shortenCopy(): void {
    const party = this.screen('PartyMenu');
    if (!party) return;
    for (const t of party.walk()) {
      if (!t.text) continue;
      if ((t.text.text ?? '').startsWith('Enter a session code')) t.setText("Join a friend's table with their code.");
      else if ((t.text.text ?? '').trim() === 'a private table.') t.setActive(false);
    }
  }

  // ------------------------------------------------------------------------------ static helpers

  static short(s: string, n: number): string {
    return !s || s.length <= n ? s : s.slice(0, n - 1) + '…';
  }

  static duration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  static until(unix: number): string {
    const left = Math.floor(unix - Date.now() / 1000);
    if (left <= 0) return 'Started';
    if (left >= 86400) return `Starts in ${Math.floor(left / 86400)}d ${Math.floor((left % 86400) / 3600)}h`;
    if (left >= 3600) return `Starts in ${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m`;
    return `Starts in ${Math.max(1, Math.floor(left / 60))}m`;
  }

  static n0 = formatN0;
}

function findDeep(t: UNode, name: string): UNode | null {
  for (const ch of t.children) {
    if (ch.name === name) return ch;
    const r = findDeep(ch, name);
    if (r) return r;
  }
  return null;
}

/** The font size a TMP label ended up at (auto-size result). */
export function fittedSize(t: UNode): number {
  const box = t.el.querySelector<HTMLElement>(':scope > .u-text');
  return (box && parseFloat(box.style.fontSize)) || t.text?.fontSize || 0;
}

export function avatarId(avatar: number, name: string): string | null {
  return AvatarCatalog.idOf(AvatarCatalog.resolve(avatar, name));
}

/** A repeating list: the first child named `prefix*` is the template (kept hidden), other samples are removed, Fill clones. */
export class RowList {
  private readonly template: UNode | null = null;
  readonly rows: UNode[] = [];

  constructor(
    private readonly container: UNode | null,
    prefix: string,
  ) {
    if (!container) return;
    const samples = container.children.filter((c) => c.name.startsWith(prefix));
    if (!samples.length) return;
    this.template = samples[0]!;
    this.template.setActive(false);
    for (const s of samples.slice(1)) destroy(s);
  }

  get valid(): boolean {
    return this.template !== null;
  }

  fill(count: number, paint: (row: UNode, i: number) => void): void {
    const tpl = this.template;
    if (!tpl || !this.container) return;
    const data = nodeData(tpl) ?? nodeDataAt('');
    while (this.rows.length < count && data) {
      const row = instantiate(tpl, data, this.container);
      row.el.dataset.name = `${tpl.name}_${this.rows.length}`;
      this.rows.push(row);
    }
    this.rows.forEach((r, i) => {
      const on = i < count;
      r.setActive(on);
      if (on) paint(r, i);
    });
    runLayout(this.container);
  }
}

