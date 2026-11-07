/**
 * A DOM version of Per/Unity/PerUi.cs, the runtime uGUI builder the private-table screens use (lobby, host,
 * tournaments, Agent). Same calls, same colours and sizes, same layout rules:
 *
 *  - Canvas: ScreenSpaceOverlay, CanvasScaler ScaleWithScreenSize 1920×1080 — which NomadCanvasFit switches to
 *    Expand, so scale = min(w/1920, h/1080) and the canvas is (w/scale)×(h/scale) units. Children are laid out in
 *    canvas units (1 CSS px) and the root is scaled by one CSS transform.
 *  - Box: an Image stretched between two anchors (offsets 0) → an absolutely positioned % box.
 *  - Column: VerticalLayoutGroup (spacing, padding, control child size both ways, force-expand width only) +
 *    LayoutElement flexibleHeight 1 → a flex column; texts take their preferred (wrapped) height, Lines their fixed
 *    height, a nested Column the spare height.
 *  - Line: Image + HorizontalLayoutGroup (spacing 12, padding 16/16/6/6, MiddleLeft, control size, force-expand
 *    height) + LayoutElement (min = preferred = height) → a flex row of fixed height; texts grow by their
 *    flexibleWidth from their preferred (one-line) width and shrink first, buttons keep their width.
 *  - Text: TextMeshProUGUI with the TMP default font (LiberationSans SDF), white, word wrap, rich text.
 *  - Button: Image (colour) + Button (ColorTint transition, default ColorBlock) + LayoutElement (width × 52).
 */
import { tmpToHtml } from './richText';

export type Rgba = readonly [number, number, number, number];

/** PerUi's colours (and Color.clear / Color.white). */
export const PerColor = {
  Panel: [0.07, 0.09, 0.12, 0.96] as Rgba,
  Row: [1, 1, 1, 0.06] as Rgba,
  Accent: [0.2, 0.62, 0.45, 1] as Rgba,
  Muted: [0.3, 0.33, 0.38, 1] as Rgba,
  Warn: [0.8, 0.42, 0.25, 1] as Rgba,
  Clear: [0, 0, 0, 0] as Rgba,
  White: [1, 1, 1, 1] as Rgba,
  Dim: [0, 0, 0, 0.6] as Rgba,
};

export const css = (c: Rgba, tint: Rgba = [1, 1, 1, 1]): string =>
  `rgba(${Math.round(c[0] * tint[0] * 255)},${Math.round(c[1] * tint[1] * 255)},${Math.round(c[2] * tint[2] * 255)},${+(c[3] * tint[3]).toFixed(4)})`;

/** TMP LiberationSans SDF: line height 98.8916 at point size 86. */
const LINE_RATIO = 98.8916 / 86;
const REF: [number, number] = [1920, 1080];

type Kind = 'free' | 'column' | 'line' | 'button';
const kindOf = (el: HTMLElement): Kind => (el.dataset.perKind as Kind | undefined) ?? 'free';

let styled = false;
function injectStyle(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = `
.per-host{position:absolute;inset:0;overflow:hidden;pointer-events:auto}
.per-canvas{position:absolute;left:0;top:0;transform-origin:0 0;font-family:'UnityLiberationSans','Liberation Sans',Arial,sans-serif;color:#fff;-webkit-font-smoothing:antialiased}
.per-canvas *{box-sizing:border-box}
.per-free{position:absolute}
.per-col{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start}
.per-line{display:flex;flex-direction:row;align-items:stretch;justify-content:flex-start;flex:0 0 auto}
.per-text{display:flex;flex-direction:column;justify-content:center;white-space:pre-wrap;overflow-wrap:normal;word-break:normal;line-height:${LINE_RATIO};min-width:0;min-height:0}
.per-text.top{justify-content:flex-start}
.per-text>span{display:block}
.per-btn{position:relative;flex:0 0 auto;align-self:center;height:100%;min-height:52px;cursor:pointer;transition:background-color .1s linear;user-select:none}
.per-btn.off{cursor:default}
.per-btn>.per-text{position:absolute;inset:0;pointer-events:none}
`;
  document.head.append(s);
}

/** PerUi.Canvas: a full-viewport canvas root (sorting by router stack order). */
export class PerCanvas {
  readonly host: HTMLElement;
  readonly root: HTMLElement;
  private readonly onResize = () => this.layout();

  constructor(parent: HTMLElement, name: string) {
    injectStyle();
    this.host = document.createElement('div');
    this.host.className = 'per-host';
    this.root = document.createElement('div');
    this.root.className = 'per-canvas';
    this.root.dataset.name = name;
    this.host.append(this.root);
    parent.append(this.host);
    window.addEventListener('resize', this.onResize);
    this.layout();
  }

  layout(): void {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    const s = Math.min(w / REF[0], h / REF[1]);
    this.root.style.width = `${w / s}px`;
    this.root.style.height = `${h / s}px`;
    this.root.style.transform = `scale(${s})`;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.host.remove();
  }
}

/** Places a new rect under `parent`: anchored % box when the parent has no layout group, else a layout child. */
function place(parent: HTMLElement, el: HTMLElement, min: [number, number], max: [number, number]): void {
  if (kindOf(parent) === 'free' || kindOf(parent) === 'button') {
    el.classList.add('per-free');
    el.style.left = `${min[0] * 100}%`;
    el.style.right = `${(1 - max[0]) * 100}%`;
    el.style.bottom = `${min[1] * 100}%`;
    el.style.top = `${(1 - max[1]) * 100}%`;
  }
  parent.append(el);
}

/** PerUi.Box. */
export function box(parent: HTMLElement, name: string, color: Rgba, min: [number, number], max: [number, number]): HTMLElement {
  injectStyle();
  const el = document.createElement('div');
  el.dataset.name = name;
  el.style.backgroundColor = css(color);
  place(parent, el, min, max);
  return el;
}

/** PerUi.Column (the LayoutElement's flexibleHeight 1 makes a nested column take the spare height). */
export function column(parent: HTMLElement, name: string, min: [number, number], max: [number, number], spacing = 10, padding = 24): HTMLElement {
  const el = box(parent, name, PerColor.Clear, min, max);
  el.dataset.perKind = 'column';
  el.classList.add('per-col');
  el.style.gap = `${spacing}px`;
  el.style.padding = `${padding}px`;
  if (kindOf(parent) === 'column') el.style.flex = '1 1 0px';
  return el;
}

/** PerUi.Line. */
export function line(parent: HTMLElement, height: number, color: Rgba): HTMLElement {
  injectStyle();
  const el = document.createElement('div');
  el.dataset.name = 'Row';
  el.dataset.perKind = 'line';
  el.className = 'per-line';
  el.style.backgroundColor = css(color);
  el.style.height = `${height}px`;
  el.style.minHeight = `${height}px`;
  el.style.gap = '12px';
  el.style.padding = '6px 16px';
  parent.append(el);
  return el;
}

export type TextAlign = 'Left' | 'Center' | 'TopLeft';

/** A TMP label: `text` is TMP rich text. */
export class PerText {
  readonly el = document.createElement('div');
  private readonly span = document.createElement('span');
  private value = '';

  constructor(text: string, size: number, align: TextAlign) {
    this.el.className = 'per-text' + (align === 'TopLeft' ? ' top' : '');
    this.el.style.fontSize = `${size}px`;
    this.el.style.textAlign = align === 'Center' ? 'center' : 'left';
    this.el.append(this.span);
    this.text = text;
  }

  get text(): string {
    return this.value;
  }

  set text(v: string) {
    this.value = v ?? '';
    this.span.innerHTML = tmpToHtml(this.value);
  }

  set color(c: Rgba) {
    this.el.style.color = css(c);
  }
}

/** PerUi.Text (LayoutElement flexibleWidth = flex). */
export function text(parent: HTMLElement, value: string, size: number, align: TextAlign = 'Left', flex = 1): PerText {
  injectStyle();
  const t = new PerText(value, size, align);
  const k = kindOf(parent);
  if (k === 'line') t.el.style.flex = `${flex} 1 auto`;
  else if (k === 'column') t.el.style.flex = '0 1 auto';
  parent.append(t.el);
  return t;
}

// ---------------------------------------------------------------- buttons

/** Selectable's default ColorBlock (normal, highlighted, pressed, selected, disabled), fade 0.1 s. */
const TINT = {
  normal: [1, 1, 1, 1] as Rgba,
  highlighted: [0.9608, 0.9608, 0.9608, 1] as Rgba,
  pressed: [0.7843, 0.7843, 0.7843, 1] as Rgba,
  selected: [0.9608, 0.9608, 0.9608, 1] as Rgba,
  disabled: [0.7843, 0.7843, 0.7843, 0.502] as Rgba,
};

/** EventSystem.currentSelectedGameObject: the last button clicked stays "selected" until a click elsewhere. */
let selected: PerButton | null = null;
let selectionHooked = false;
function hookSelection(): void {
  if (selectionHooked || typeof document === 'undefined') return;
  selectionHooked = true;
  document.addEventListener('pointerdown', (e) => {
    const s = selected;
    if (s && !s.el.contains(e.target as Node)) {
      selected = null;
      s.paint();
    }
  }, true);
}

export class PerButton {
  readonly el = document.createElement('div');
  readonly label: PerText;
  private base: Rgba;
  private on = true;
  private hover = false;
  private down = false;

  constructor(label: string, onClick: () => void, color: Rgba, width: number) {
    hookSelection();
    this.base = color;
    this.el.className = 'per-btn';
    this.el.dataset.name = 'Button:' + label;
    this.el.style.width = `${width}px`;
    this.el.style.minWidth = `${width}px`;
    this.label = new PerText(label, 24, 'Center');
    this.el.append(this.label.el);
    this.el.addEventListener('pointerenter', () => {
      this.hover = true;
      this.paint();
    });
    this.el.addEventListener('pointerleave', () => {
      this.hover = false;
      this.down = false;
      this.paint();
    });
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.down = true;
      this.paint();
    });
    this.el.addEventListener('pointerup', () => {
      this.down = false;
      this.paint();
    });
    this.el.addEventListener('click', () => {
      if (!this.on) return;
      const prev = selected;
      selected = this;
      prev?.paint();
      this.paint();
      onClick();
    });
    this.paint();
  }

  /** Image.color (the lobby paints its picked buy-in / stake buttons this way). */
  set color(c: Rgba) {
    this.base = c;
    this.paint();
  }

  get interactable(): boolean {
    return this.on;
  }

  set interactable(v: boolean) {
    this.on = v;
    this.el.classList.toggle('off', !v);
    if (!v && selected === this) selected = null;
    this.paint();
  }

  paint(): void {
    const t = !this.on ? TINT.disabled : this.down && this.hover ? TINT.pressed : this.hover ? TINT.highlighted : selected === this ? TINT.selected : TINT.normal;
    this.el.style.backgroundColor = css(this.base, t);
  }
}

/** PerUi.Button. */
export function button(parent: HTMLElement, label: string, onClick: () => void, color: Rgba = PerColor.Accent, width = 200): PerButton {
  injectStyle();
  const b = new PerButton(label, onClick, color, width);
  parent.append(b.el);
  return b;
}

/** PerUi.Clear. */
export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

/** PerLobbyPanel.Short etc.: "AbCd…WxYz" for keys longer than 10. */
export const short = (k: string): string => (k.length > 10 ? k.slice(0, 4) + '…' + k.slice(-4) : k);

/** Debug.Log with the panel's tag, as the C# Status helpers do (the console is where a tester looks). */
export function logStatus(tag: string, s: string): void {
  if (s) console.log(`[${tag}] ${s}`);
}

/** Exception.Message for whatever was thrown. */
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** PerPrompt_Ask (PerPrompt.jslib): window.prompt; null when cancelled. */
export function ask(message: string, defaultText: string): string | null {
  try {
    return window.prompt(message, defaultText);
  } catch {
    return null;
  }
}

/** UiClipboard.Copy: the async clipboard, falling back to a hidden textarea (must run inside the click). */
export function copyText(s: string): void {
  try {
    void navigator.clipboard?.writeText(s).catch(() => legacyCopy(s));
    if (!navigator.clipboard) legacyCopy(s);
  } catch {
    legacyCopy(s);
  }
}
function legacyCopy(s: string): void {
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  } catch {
    /* nothing more to try */
  }
}
