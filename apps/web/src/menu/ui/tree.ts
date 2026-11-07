/**
 * Builds Nomad screens (menu-ui.json) into the uGUI → DOM layer (hud/unityUi.ts) and gives each node the behaviour
 * of its Unity components: Button (ColorTint / SpriteSwap, persistent onClick calls such as SetActive, runtime
 * listeners), Toggle, Slider, TMP_InputField (a real <input>), ScrollRect (wheel + drag), RectMask2D,
 * AspectRatioFitter, Vertical/Horizontal layout groups + ContentSizeFitter, and the Nomad scripts NomadSelectable,
 * NomadRowFilter, TitleOrnament and PokerButtonSfx.
 *
 * Raycasts: like uGUI, a node takes pointer input when its Image / TMP has raycastTarget on or it is a Selectable;
 * everything else lets clicks through (the art's generator turns raycasts off on decorative images and labels).
 */
import { buildNode, assetUrl, cssColor, rgba, tmpFaceColor, type UNode, type NodeData, type SpriteData } from '../../hud/unityUi';
import { PokerSound } from '../../core';
import { MENU_DATA, scriptOf, type MenuNodeData, type PersistentCall, type RefData, type SelectableData } from '../data';

export type Listener<T = void> = (v: T) => void;

/** Global hooks the tree reports to (the host plays click sounds and handles persistent calls it knows). */
export interface TreeEnv {
  playSound(sound: PokerSound): void;
  /** A persistent call the tree does not run itself (anything but GameObject.SetActive); return true if handled. */
  persistentCall?(call: PersistentCall, from: UNode): boolean;
}

// ---------------------------------------------------------------- per-node registry

const dataOf = new WeakMap<UNode, MenuNodeData>();
const widgets = new WeakMap<UNode, Widgets>();

export interface Widgets {
  button?: MButton;
  toggle?: MToggle;
  slider?: MSlider;
  input?: MInput;
  scroll?: MScroll;
  selectable?: MSelectable;
  rowFilter?: MRowFilter;
  ornament?: MOrnament;
  /** EnsureClickable: a raycast target was added. */
  raycast?: boolean;
}

export const nodeData = (n: UNode): MenuNodeData | undefined => dataOf.get(n);
export function widgetsOf(n: UNode): Widgets {
  let w = widgets.get(n);
  if (!w) widgets.set(n, (w = {}));
  return w;
}

/** Path lookup while wiring a build: the clone's own nodes first (a cloned row's refs point inside the clone). */
class Scope {
  readonly byPath = new Map<string, UNode>();
  readonly pending: (() => void)[] = [];
  constructor(readonly parent: Scope | null) {}
  get(ref: RefData | null | undefined): UNode | null {
    if (!ref?.path) return null;
    return this.byPath.get(ref.path) ?? this.parent?.get(ref) ?? null;
  }
}

/** The global scope: every original (non-cloned) screen node by authored path. */
export const globalScope = new Scope(null);

export function nodeAt(path: string): UNode | null {
  return globalScope.byPath.get(path) ?? null;
}

// ---------------------------------------------------------------- build

/** Builds an authored subtree. `clone`: a copy (Instantiate) that must not replace the originals in path lookups. */
export function buildTree(d: MenuNodeData, env: TreeEnv, clone = false): UNode {
  const scope = clone ? new Scope(globalScope) : globalScope;
  const root = buildNode(d as unknown as NodeData, {
    sprites: MENU_DATA.sprites,
    fonts: MENU_DATA.fonts,
    materials: MENU_DATA.materials,
    onNode: (n, nd) => {
      const md = nd as unknown as MenuNodeData;
      dataOf.set(n, md);
      if (!scope.byPath.has(md.path)) scope.byPath.set(md.path, n);
      scope.pending.push(() => attach(n, md, scope, env));
    },
  });
  for (const fn of scope.pending.splice(0)) fn();
  return root;
}

function attach(n: UNode, d: MenuNodeData, scope: Scope, env: TreeEnv): void {
  const c = d.components ?? {};
  n.el.classList.add('nm-node');
  if ((c.image?.enabled !== false && c.image?.raycastTarget) || (c.text?.enabled !== false && c.text?.raycastTarget)) n.el.classList.add('nm-hit');
  if (c.rectMask2D?.enabled || (c.mask?.enabled && !c.image?.sprite)) n.el.style.overflow = 'hidden';
  if (c.canvasGroup?.enabled && !c.canvasGroup.blocksRaycasts) n.el.classList.add('nm-nohit');
  if (c.mask?.enabled && !c.mask.showMaskGraphic) n.el.classList.add('nm-hide-gfx');
  const w = widgetsOf(n);
  if (c.button) w.button = new MButton(n, c.button, scope.get(c.button.targetGraphic) ?? (n.image ? n : null), scope, env);
  if (c.toggle) w.toggle = new MToggle(n, c.toggle, scope.get(c.toggle.targetGraphic) ?? (n.image ? n : null), scope.get(c.toggle.graphic), env);
  if (c.slider) w.slider = new MSlider(n, c.slider, scope);
  if (c.inputField) w.input = new MInput(n, c.inputField, scope);
  if (c.scrollRect?.enabled) w.scroll = new MScroll(n, c.scrollRect, scope);
  const sel = scriptOf(d, 'NomadSelectable');
  if (sel) w.selectable = new MSelectable(n, sel.fields, scope);
  const orn = scriptOf(d, 'TitleOrnament');
  if (orn?.enabled) w.ornament = new MOrnament(n, orn.fields);
  const sfx = scriptOf(d, 'PokerButtonSfx');
  if (sfx && w.button) w.button.sound = Number(sfx.fields.sound) as PokerSound;
  const filter = scriptOf(d, 'NomadRowFilter');
  if (filter?.enabled) scope.pending.push(() => (w.rowFilter = new MRowFilter(n, filter.fields, scope)));
}

/** Little-endian int32 arrays as Unity serialises them ("0000000001000000ffffffff" = [0, 1, -1]). */
export function int32Hex(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number);
  const s = String(v ?? '');
  const out: number[] = [];
  for (let i = 0; i + 8 <= s.length; i += 8) {
    const b = [0, 2, 4, 6].map((k) => parseInt(s.slice(i + k, i + k + 2), 16));
    out.push((b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >> 0);
  }
  return out;
}

const refs = (v: unknown): RefData[] => (Array.isArray(v) ? (v as RefData[]) : []);

// ---------------------------------------------------------------- Selectable base

type SelState = 'normal' | 'highlighted' | 'pressed' | 'disabled';

class MSelectableBase {
  interactable: boolean;
  /** Unity's targetGraphic (NomadSelectable may repoint it). */
  target: UNode | null;
  private hover = false;
  private down = false;
  private readonly baseSprite: SpriteData | null;

  constructor(
    readonly node: UNode,
    readonly data: SelectableData,
    target: UNode | null,
  ) {
    this.interactable = data.interactable;
    this.target = target;
    this.baseSprite = target?.image?.sprite ?? null;
    const el = node.el;
    el.classList.add('nm-interactive');
    el.addEventListener('pointerenter', () => ((this.hover = true), this.refresh()));
    el.addEventListener('pointerleave', () => ((this.hover = false), (this.down = false), this.refresh()));
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.down = true;
      this.refresh();
    });
    window.addEventListener('pointerup', () => {
      if (!this.down) return;
      this.down = false;
      this.refresh();
    });
    this.refresh();
  }

  get state(): SelState {
    return !this.interactable ? 'disabled' : this.down ? 'pressed' : this.hover ? 'highlighted' : 'normal';
  }

  setInteractable(on: boolean): void {
    if (on === this.interactable) return;
    this.interactable = on;
    this.refresh();
  }

  /** Selectable.DoStateTransition. */
  refresh(): void {
    const t = this.target;
    if (!t) return;
    const s = this.state;
    if (this.data.transition === 'ColorTint') {
      const c = rgba(this.data.colors[s]);
      const m = this.data.colors.colorMultiplier || 1;
      t.imageTint = { r: Math.min(1, c.r * m), g: Math.min(1, c.g * m), b: Math.min(1, c.b * m), a: Math.min(1, c.a * m) };
      if (t.image) t.render();
      if (t.text) t.el.style.opacity = c.a < 0.999 ? String(c.a) : '';
    } else if (this.data.transition === 'SpriteSwap' && t.image) {
      const key = s === 'normal' ? null : this.data.spriteState[s];
      const sp = key ? (MENU_DATA.sprites[key] ?? null) : null;
      t.image.sprite = sp ?? this.baseSprite;
      t.render();
    }
  }
}

// ---------------------------------------------------------------- Button

export class MButton extends MSelectableBase {
  /** Runtime listeners (onClick.AddListener), after the persistent ones like UnityEvent. */
  readonly listeners: Listener[] = [];
  /** onClick.SetPersistentListenerState(i, Off). */
  readonly persistentOff: boolean[];
  sound: PokerSound = PokerSound.ButtonGeneric;

  constructor(node: UNode, readonly button: SelectableData & { onClick: PersistentCall[] }, target: UNode | null, private readonly scope: Scope, private readonly env: TreeEnv) {
    super(node, button, target);
    this.persistentOff = button.onClick.map((c) => c.callState === 0);
    node.el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.click();
    });
  }

  /** Turns the scene's own onClick calls off (NomadUiHost.Bind replaceNavigation / TableMenuChips.Wire). */
  disablePersistent(): void {
    this.persistentOff.fill(true);
  }

  /** `onClick = new ButtonClickedEvent()`: drops persistent and runtime listeners. */
  reset(): void {
    this.disablePersistent();
    this.listeners.length = 0;
  }

  addListener(fn: Listener): void {
    this.listeners.push(fn);
  }

  click(): void {
    if (!this.interactable || !this.node.activeInHierarchy) return;
    this.env.playSound(this.sound);
    this.button.onClick.forEach((call, i) => {
      if (this.persistentOff[i]) return;
      runPersistent(call, this.node, this.scope, this.env);
    });
    for (const fn of [...this.listeners]) fn();
  }
}

function runPersistent(call: PersistentCall, from: UNode, scope: Scope, env: TreeEnv): void {
  if (call.method === 'SetActive' && call.target?.path && !call.target.component) {
    scope.get(call.target)?.setActive(call.arg === true);
    return;
  }
  if (!env.persistentCall?.(call, from)) console.debug('[menu] persistent call with no target in the web port:', call.method, call.target);
}

/** Button added at runtime (AddComponent<Button>): Unity's defaults, ColorTint over the node's own Image. */
const DEFAULT_BUTTON: SelectableData & { onClick: PersistentCall[] } = {
  interactable: true,
  transition: 'ColorTint',
  onClick: [],
  spriteState: { highlighted: null, pressed: null, disabled: null },
  targetGraphic: null,
  colors: {
    normal: { hex: '#ffffff', rgba: [1, 1, 1, 1] },
    highlighted: { hex: '#f5f5f5', rgba: [0.9608, 0.9608, 0.9608, 1] },
    pressed: { hex: '#c8c8c8', rgba: [0.7843, 0.7843, 0.7843, 1] },
    selected: { hex: '#f5f5f5', rgba: [0.9608, 0.9608, 0.9608, 1] },
    disabled: { hex: '#c8c8c880', rgba: [0.7843, 0.7843, 0.7843, 0.502] },
    colorMultiplier: 1,
    fadeDuration: 0.1,
  },
};

/** GetComponent<Button>() ?? AddComponent<Button>(). */
export function addButton(n: UNode, env: TreeEnv): MButton {
  const w = widgetsOf(n);
  w.button ??= new MButton(n, DEFAULT_BUTTON, n.image ? n : null, globalScope, env);
  return w.button;
}

// ---------------------------------------------------------------- Toggle

export class MToggle extends MSelectableBase {
  isOn: boolean;
  readonly listeners: Listener<boolean>[] = [];

  constructor(node: UNode, data: SelectableData & { isOn: boolean }, target: UNode | null, private readonly graphic: UNode | null, private readonly env: TreeEnv) {
    super(node, data, target);
    this.isOn = data.isOn;
    this.paint();
    node.el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.interactable) return;
      this.env.playSound(PokerSound.ButtonGeneric);
      this.set(!this.isOn);
    });
  }

  setIsOnWithoutNotify(on: boolean): void {
    this.isOn = on;
    this.paint();
  }

  set(on: boolean): void {
    if (on === this.isOn) return;
    this.isOn = on;
    this.paint();
    for (const fn of [...this.listeners]) fn(on);
  }

  /** Toggle.PlayEffect: the checkmark graphic's alpha. */
  private paint(): void {
    if (this.graphic) this.graphic.el.style.visibility = this.isOn ? '' : 'hidden';
  }
}

// ---------------------------------------------------------------- Slider

export class MSlider {
  value: number;
  min: number;
  max: number;
  wholeNumbers: boolean;
  readonly listeners: Listener<number>[] = [];
  private readonly fill: UNode | null;
  private readonly handle: UNode | null;
  interactable: boolean;

  constructor(readonly node: UNode, data: NonNullable<MenuNodeData['components']>['slider'] & object, scope: Scope) {
    this.value = data.value;
    this.min = data.min;
    this.max = data.max;
    this.wholeNumbers = data.wholeNumbers;
    this.interactable = data.interactable;
    this.fill = scope.get(data.fillRect);
    this.handle = scope.get(data.handleRect);
    node.el.classList.add('nm-interactive');
    let dragging = false;
    const fromEvent = (e: PointerEvent) => {
      const area = this.handle?.parent ?? this.fill?.parent ?? node;
      const r = area.el.getBoundingClientRect();
      const t = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
      this.set(this.min + Math.max(0, Math.min(1, t)) * (this.max - this.min));
    };
    node.el.addEventListener('pointerdown', (e) => {
      if (!this.interactable || e.button !== 0) return;
      dragging = true;
      node.el.setPointerCapture(e.pointerId);
      fromEvent(e);
      e.stopPropagation();
    });
    node.el.addEventListener('pointermove', (e) => dragging && fromEvent(e));
    node.el.addEventListener('pointerup', () => (dragging = false));
    node.el.addEventListener('pointercancel', () => (dragging = false));
    this.paint();
  }

  get normalized(): number {
    return this.max > this.min ? (this.value - this.min) / (this.max - this.min) : 0;
  }

  setValueWithoutNotify(v: number): void {
    this.value = this.clamp(v);
    this.paint();
  }

  set(v: number): void {
    const c = this.clamp(v);
    if (c === this.value) return;
    this.value = c;
    this.paint();
    for (const fn of [...this.listeners]) fn(c);
  }

  private clamp(v: number): number {
    let c = Math.max(Math.min(this.min, this.max), Math.min(Math.max(this.min, this.max), v));
    if (this.wholeNumbers) c = Math.round(c);
    return c;
  }

  /** Slider.UpdateVisuals (LeftToRight): anchors start at (0,0)-(1,1), the x axis follows the value. */
  private paint(): void {
    const t = this.normalized;
    if (this.fill) {
      this.fill.anchorMin = [0, 0];
      this.fill.anchorMax = [t, 1];
      if (this.fill.parent?.activeInHierarchy) this.fill.layout();
    }
    if (this.handle) {
      this.handle.anchorMin = [t, 0];
      this.handle.anchorMax = [t, 1];
      if (this.handle.parent?.activeInHierarchy) this.handle.layout();
    }
  }
}

// ---------------------------------------------------------------- TMP_InputField

export class MInput {
  readonly input: HTMLInputElement;
  readonly onValueChanged: Listener<string>[] = [];
  readonly onSubmit: Listener<string>[] = [];
  private readonly textNode: UNode | null;
  private readonly placeholderNode: UNode | null;

  constructor(readonly node: UNode, data: NonNullable<MenuNodeData['components']>['inputField'] & object, scope: Scope) {
    this.textNode = scope.get(data.textComponent);
    this.placeholderNode = scope.get(data.placeholder);
    const box = scope.get(data.textViewport) ?? this.textNode?.parent ?? node;
    const input = (this.input = document.createElement('input'));
    input.className = 'nm-input';
    input.type = data.contentType === 'Password' ? 'password' : data.contentType === 'EmailAddress' ? 'email' : data.contentType === 'IntegerNumber' ? 'number' : 'text';
    if (data.characterLimit > 0) input.maxLength = data.characterLimit;
    input.readOnly = data.readOnly;
    input.value = data.text ?? '';
    const t = this.textNode?.text;
    if (t) {
      input.style.fontFamily = t.family;
      input.style.fontSize = `${t.fontSize}px`;
      input.style.color = cssColor(tmpFaceColor(t.color)); // TMP face colour in a Linear project (see unityUi)
      input.style.textAlign = t.alignH === 'center' ? 'center' : t.alignH === 'right' ? 'right' : 'left';
    }
    const ph = this.placeholderNode?.text;
    if (ph) input.placeholder = ph.text;
    if (this.textNode) this.textNode.el.style.visibility = 'hidden';
    if (this.placeholderNode) this.placeholderNode.el.style.visibility = 'hidden';
    if (ph) input.style.setProperty('--nm-ph', cssColor(ph.color));
    box.el.append(input);
    box.el.classList.add('nm-interactive');
    node.el.classList.add('nm-interactive');
    node.el.addEventListener('click', () => input.focus());
    input.addEventListener('input', () => this.onValueChanged.forEach((fn) => fn(input.value)));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.onSubmit.forEach((fn) => fn(input.value));
    });
  }

  get text(): string {
    return this.input.value;
  }
  set text(v: string) {
    this.input.value = v;
  }
  set placeholder(v: string) {
    this.input.placeholder = v;
  }
}

// ---------------------------------------------------------------- ScrollRect

export class MScroll {
  readonly content: UNode | null;
  readonly viewport: UNode;
  private readonly vertical: boolean;
  private readonly horizontal: boolean;

  constructor(readonly node: UNode, data: NonNullable<MenuNodeData['components']>['scrollRect'] & object, scope: Scope) {
    this.content = scope.get(data.content);
    this.viewport = scope.get(data.viewport) ?? node;
    this.vertical = data.vertical;
    this.horizontal = data.horizontal;
    this.viewport.el.style.overflow = 'hidden';
    node.el.classList.add('nm-hit');
    const sens = data.scrollSensitivity || 1;
    node.el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // uGUI: one wheel notch is scrollSensitivity units; a browser notch is ~100 px of deltaY.
        this.scrollBy((e.deltaX / 100) * sens * 20, (e.deltaY / 100) * sens * 20);
      },
      { passive: false },
    );
    let last: { x: number; y: number } | null = null;
    node.el.addEventListener('pointerdown', (e) => {
      last = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointermove', (e) => {
      if (!last || !(e.buttons & 1)) return;
      const s = this.screenScale();
      this.scrollBy(-(e.clientX - last.x) / s, -(e.clientY - last.y) / s);
      last = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', () => (last = null));
  }

  private screenScale(): number {
    const r = this.viewport.el.getBoundingClientRect();
    return this.viewport.w > 0 ? r.width / this.viewport.w : 1;
  }

  /** How far the content's top edge sits above the viewport's top (0 = scrolled to the top); content anchored top. */
  private topOffset(c: UNode): number {
    return c.anchoredPosition[1] + (1 - c.pivot[1]) * c.h - (1 - c.anchorMax[1]) * this.viewport.h;
  }
  private setTop(c: UNode, top: number): number {
    return top - (1 - c.pivot[1]) * c.h + (1 - c.anchorMax[1]) * this.viewport.h;
  }

  /** Clamped movement: content back inside the viewport (ScrollRect on enable / after its content changed). */
  clamp(): void {
    this.scrollBy(0, 0, true);
  }

  /** Positive dy scrolls down (content moves up). Clamped. */
  scrollBy(dx: number, dy: number, force = false): void {
    const c = this.content;
    if (!c) return;
    const [x, y] = c.anchoredPosition;
    let nx = x;
    let ny = y;
    if (this.vertical) {
      const top = Math.max(0, Math.min(Math.max(0, c.h - this.viewport.h), this.topOffset(c) + dy));
      ny = this.setTop(c, top);
    }
    if (this.horizontal) nx = Math.min(0, Math.max(-Math.max(0, c.w - this.viewport.w), x - dx));
    if (Math.abs(nx - x) < 1e-4 && Math.abs(ny - y) < 1e-4 && !force) return;
    c.anchoredPosition = [nx, ny];
    c.layout();
  }

  /** verticalNormalizedPosition = 1 (top). */
  toTop(): void {
    const c = this.content;
    if (!c) return;
    c.anchoredPosition = [c.anchoredPosition[0], this.setTop(c, 0)];
    c.layout();
  }
}
// ---------------------------------------------------------------- NomadSelectable / NomadRowFilter

export class MSelectable {
  isSelected = false;
  private readonly selectedOnly: UNode[];
  private readonly normalOnly: UNode[];
  private readonly selectedGraphic: UNode | null;
  private readonly normalGraphic: UNode | null;
  private readonly label: UNode | null;

  constructor(readonly node: UNode, private readonly f: Record<string, unknown>, scope: Scope) {
    this.selectedOnly = refs(f.selectedOnly).map((r) => scope.get(r)).filter((x): x is UNode => !!x);
    this.normalOnly = refs(f.normalOnly).map((r) => scope.get(r)).filter((x): x is UNode => !!x);
    this.selectedGraphic = scope.get(f.selectedGraphic as RefData);
    this.normalGraphic = scope.get(f.normalGraphic as RefData);
    this.label = scope.get(f.label as RefData);
  }

  setSelected(on: boolean): void {
    this.isSelected = on;
    for (const n of this.selectedOnly) n.setActive(on);
    for (const n of this.normalOnly) n.setActive(!on);
    const b = widgets.get(this.node)?.button;
    const g = on ? this.selectedGraphic : this.normalGraphic;
    if (b && g) {
      b.target = g;
      b.refresh();
    }
    if (this.label) this.label.setTextColor(rgba((on ? this.f.selectedLabelColor : this.f.normalLabelColor) as { hex: string; rgba: [number, number, number, number] }));
  }
}

export class MRowFilter {
  private current = 0;
  private readonly filters: UNode[];
  private readonly filterCategory: number[];
  private readonly rowCategory: number[];
  readonly rows: UNode[];

  constructor(readonly node: UNode, f: Record<string, unknown>, scope: Scope) {
    this.filters = refs(f.filters).map((r) => scope.get(r)).filter((x): x is UNode => !!x);
    this.rows = refs(f.rows).map((r) => scope.get(r)).filter((x): x is UNode => !!x);
    this.filterCategory = int32Hex(f.filterCategory);
    this.rowCategory = int32Hex(f.rowCategory);
    const scroll = scope.get(f.scroll as RefData);
    this.filters.forEach((fl, i) => widgets.get(fl)?.button?.addListener(() => this.select(i)));
    node.onEnable.push(() => this.select(this.current));
    this.scrollNode = scroll;
  }
  private readonly scrollNode: UNode | null;

  select(index: number): void {
    this.current = index;
    const cat = this.filterCategory[index] ?? 0;
    this.rows.forEach((r, i) => r.setActive(cat === 0 || this.rowCategory[i] === cat));
    this.filters.forEach((fl, i) => widgets.get(fl)?.selectable?.setSelected(i === index));
    const s = this.scrollNode ? widgets.get(this.scrollNode)?.scroll : undefined;
    if (s?.content) {
      runLayout(s.content);
      s.toTop();
    }
  }
}

// ---------------------------------------------------------------- TitleOrnament

let measureCtx: CanvasRenderingContext2D | null = null;

export class MOrnament {
  private readonly left: HTMLDivElement;
  private readonly right: HTMLDivElement;

  constructor(readonly node: UNode, private readonly f: Record<string, unknown>) {
    const sp = MENU_DATA.sprites[(f.ornament as RefData | null)?.sprite ?? ''];
    const mk = () => {
      const d = document.createElement('div');
      d.className = 'nm-ornament';
      if (sp?.file) d.style.backgroundImage = `url("${assetUrl(sp.file)}")`;
      node.el.append(d);
      return d;
    };
    this.left = mk();
    this.right = mk();
    if (!sp?.file) this.left.style.display = this.right.style.display = 'none';
  }

  /** TitleOrnament.Refresh: both ornaments hug the visible text. Call after the label laid out. */
  refresh(): void {
    const t = this.node.text;
    const box = this.node.el.querySelector<HTMLElement>('.u-text');
    if (!t || !box) return;
    const fs = parseFloat(box.style.fontSize) || t.fontSize;
    measureCtx ??= document.createElement('canvas').getContext('2d')!;
    measureCtx.font = `${t.bold ? '700' : '400'} ${fs}px ${t.family}`;
    const text = t.upper ? t.text.toUpperCase() : t.text;
    const show = !!text.trim();
    this.left.style.display = this.right.style.display = show ? '' : 'none';
    if (!show) return;
    const [ml, , mr] = t.margin;
    const avail = this.node.w - ml - mr;
    const tw = Math.min(avail, measureCtx.measureText(text).width);
    const x0 = ml + (t.alignH === 'left' ? 0 : t.alignH === 'right' ? avail - tw : (avail - tw) / 2);
    const s = fs * Number(this.f.sizeScale ?? 1.3);
    const gap = fs * Number(this.f.gapScale ?? 0.14);
    const cy = this.node.h / 2 - Number(this.f.verticalOffset ?? 0);
    const place = (d: HTMLDivElement, cx: number) => {
      d.style.width = d.style.height = `${s}px`;
      d.style.left = `${cx - s / 2}px`;
      d.style.top = `${cy - s / 2}px`;
    };
    place(this.left, x0 - gap - s / 2);
    place(this.right, x0 + tw + gap + s / 2);
  }
}

// ---------------------------------------------------------------- layout groups, aspect fitters

/** HorizontalOrVerticalLayoutGroup + ContentSizeFitter (PreferredSize) over the node's active children. */
export function runLayout(n: UNode): void {
  const d = dataOf.get(n);
  const g = d?.components?.layoutGroup;
  if (g?.enabled && g.kind !== 'GridLayoutGroup') {
    const vertical = g.kind === 'VerticalLayoutGroup';
    const kids = n.children.filter((k) => k.activeSelf && !dataOf.get(k)?.components?.layoutElement?.ignoreLayout);
    const sp = typeof g.spacing === 'number' ? g.spacing : g.spacing[vertical ? 1 : 0];
    const pad = g.padding;
    const pref = (k: UNode, axis: 0 | 1) => {
      const le = dataOf.get(k)?.components?.layoutElement;
      const p = axis === 0 ? le?.preferredWidth : le?.preferredHeight;
      return p !== undefined && p >= 0 ? p : axis === 0 ? k.w || k.sizeDelta[0] : k.h || k.sizeDelta[1];
    };
    const innerW = n.w - pad.left - pad.right;
    const innerH = n.h - pad.top - pad.bottom;
    let pos = vertical ? pad.top : pad.left;
    const ordered = g.reverse ? [...kids].reverse() : kids;
    for (const k of ordered) {
      const w = vertical ? (g.controlW && g.expandW ? innerW : g.controlW ? pref(k, 0) : k.w || k.sizeDelta[0]) : g.controlW ? pref(k, 0) : k.w || k.sizeDelta[0];
      const h = vertical ? (g.controlH ? pref(k, 1) : k.h || k.sizeDelta[1]) : g.controlH && g.expandH ? innerH : g.controlH ? pref(k, 1) : k.h || k.sizeDelta[1];
      k.anchorMin = [0, 1];
      k.anchorMax = [0, 1];
      k.sizeDelta = [w, h];
      const align = g.childAlignment;
      if (vertical) {
        const free = innerW - w;
        const x = pad.left + (/Center/.test(align) ? free / 2 : /Right/.test(align) ? free : 0);
        k.anchoredPosition = [x + k.pivot[0] * w, -(pos + (1 - k.pivot[1]) * h)];
        pos += h + sp;
      } else {
        const free = innerH - h;
        const y = pad.top + (/^Middle/.test(align) ? free / 2 : /^Lower/.test(align) ? free : 0);
        k.anchoredPosition = [pos + k.pivot[0] * w, -(y + (1 - k.pivot[1]) * h)];
        pos += w + sp;
      }
    }
    const fit = d?.components?.contentSizeFitter;
    const total = pos - (kids.length ? sp : 0) + (vertical ? pad.bottom : pad.right);
    if (fit && vertical && fit.vertical === 'PreferredSize') n.sizeDelta = [n.sizeDelta[0], total - (n.anchorMax[1] - n.anchorMin[1]) * (n.parent?.h ?? 0)];
    if (fit && !vertical && fit.horizontal === 'PreferredSize') n.sizeDelta = [total - (n.anchorMax[0] - n.anchorMin[0]) * (n.parent?.w ?? 0), n.sizeDelta[1]];
  }
  if (n.parent?.activeInHierarchy !== false) n.layout();
}

/** Rebuilds every layout group / content size fitter under `root` (children first), then clamps scroll views. */
export function rebuildLayouts(root: UNode): void {
  const post = (n: UNode) => {
    for (const c of n.children) if (c.activeSelf) post(c);
    const comp = dataOf.get(n)?.components;
    if (comp?.layoutGroup?.enabled && comp.layoutGroup.kind !== 'GridLayoutGroup') runLayout(n);
  };
  if (!root.activeInHierarchy) return;
  post(root);
  for (const n of root.walk()) if (n.activeInHierarchy) widgets.get(n)?.scroll?.clamp();
}

/** AspectRatioFitter for every node under `root` (run after a layout pass, when parent sizes are known). */
export function applyAspectFitters(root: UNode): void {
  for (const n of root.walk()) {
    const a = dataOf.get(n)?.components?.aspectRatioFitter;
    if (!a?.enabled || a.aspectMode === 'None' || !n.parent || !n.activeInHierarchy) continue;
    const pw = n.parent.w;
    const ph = n.parent.h;
    const r = a.aspectRatio || 1;
    let w = n.w;
    let h = n.h;
    if (a.aspectMode === 'WidthControlsHeight') h = w / r;
    else if (a.aspectMode === 'HeightControlsWidth') w = h * r;
    else {
      const envelope = a.aspectMode === 'EnvelopeParent';
      const byWidth = envelope ? pw / ph > r : pw / ph < r;
      w = byWidth ? pw : ph * r;
      h = byWidth ? pw / r : ph;
    }
    if (a.aspectMode === 'FitInParent' || a.aspectMode === 'EnvelopeParent') {
      n.anchorMin = [0.5, 0.5];
      n.anchorMax = [0.5, 0.5];
      n.anchoredPosition = [0, 0];
    }
    n.sizeDelta = [w - (n.anchorMax[0] - n.anchorMin[0]) * pw, h - (n.anchorMax[1] - n.anchorMin[1]) * ph];
    n.layout();
  }
}

/** Every TitleOrnament under `root`, after layout. */
export function refreshOrnaments(root: UNode): void {
  for (const n of root.walk()) if (n.activeInHierarchy) widgets.get(n)?.ornament?.refresh();
}
