/**
 * DOM stand-in for Game/Retention/RetentionUi.cs, the runtime uGUI kit TournamentsHud and TournamentTableOverlay
 * build themselves with (they have no prefab, so there is nothing for tools/extract-unity-hud.mjs to extract): the
 * same colours, label sizes, button look and layout groups, inside a 1920×1080 "Scale With Screen Size, match 0.5"
 * canvas. Layout groups become flex boxes with the same padding/spacing; sizes are canvas units.
 */
import { tmpRichToHtml } from '../../hud/unityUi';
import './tournaments.css';
import { overlayScale } from '../../layout/portraitRects';

type C = [number, number, number, number];
const css = ([r, g, b, a]: C): string => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;

export const Colors = {
  Overlay: css([0.02, 0.03, 0.05, 0.72]),
  Panel: css([0.09, 0.11, 0.16, 0.96]),
  Gold: css([0.95, 0.78, 0.32, 1]),
  Muted: css([1, 1, 1, 0.55]),
  Reel: css([0.06, 0.07, 0.1, 1]),
  White: '#ffffff',
  /** TournamentsHud / TournamentTableOverlay palette. */
  TourGold: [0.66, 0.48, 0.14, 1] as C,
  Grey: [0.28, 0.30, 0.36, 1] as C,
  Green: [0.20, 0.52, 0.30, 1] as C,
  Danger: [0.58, 0.25, 0.25, 1] as C,
  BannerBg: css([0.06, 0.07, 0.1, 0.88]),
};
export type ButtonColor = C;

/** A full-screen overlay canvas (CanvasScaler 1920×1080, match 0.5). Returns the root and a disposer. */
export function overlayCanvas(parent: HTMLElement, sortingOrder: number): { root: HTMLElement; dispose: () => void } {
  const host = document.createElement('div');
  host.className = 'trn-canvas';
  host.style.zIndex = String(sortingOrder);
  const root = document.createElement('div');
  root.className = 'trn-root';
  host.append(root);
  parent.append(host);
  const layout = () => {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    const s = overlayScale(w, h); // portrait: 720-wide reference (layout/portraitRects.ts)
    root.style.setProperty('--canvas-scale', String(s));
    root.style.width = `${w / s}px`;
    root.style.height = `${h / s}px`;
    root.style.transform = `scale(${s})`;
  };
  const ro = new ResizeObserver(layout);
  ro.observe(host);
  layout();
  return { root, dispose: () => { ro.disconnect(); host.remove(); } };
}

export function el(tag: string, cls: string, parent?: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.append(e);
  return e;
}

export interface LabelOptions {
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center';
  height?: number;
}

/** RetentionUi.Label: TMP text, word-wrapped, ellipsis overflow, raycast off. Text is TMP rich text. */
export function label(parent: HTMLElement, text: string, size: number, color: string, o: LabelOptions = {}): HTMLElement & { setText(t: string): void } {
  const e = el('div', 'trn-label', parent) as HTMLElement & { setText(t: string): void };
  e.style.fontSize = `${size}px`;
  e.style.color = color;
  if (o.bold) e.style.fontWeight = 'bold';
  if (o.italic) e.style.fontStyle = 'italic';
  e.style.justifyContent = o.align === 'left' ? 'flex-start' : 'center';
  e.style.textAlign = o.align === 'left' ? 'left' : 'center';
  if (o.height) {
    e.style.height = `${o.height}px`;
    e.style.flex = '0 0 auto';
  }
  let current: string | null = null;
  e.setText = (t: string) => {
    if (t === current) return;
    current = t;
    e.innerHTML = `<span>${tmpRichToHtml(t)}</span>`;
  };
  e.setText(text);
  return e;
}

/** RetentionUi.Button: a flat Image in `color`, a 20pt bold white label, highlight +18% white / pressed −20%. */
export function button(parent: HTMLElement, caption: string, color: ButtonColor, height = 52, width = 0, onClick?: () => void): HTMLButtonElement & { setCaption(t: string): void; setColor(c: ButtonColor): void } {
  const b = el('button', 'trn-button', parent) as HTMLButtonElement & { setCaption(t: string): void; setColor(c: ButtonColor): void };
  b.type = 'button';
  b.style.height = `${height}px`;
  if (width > 0) {
    b.style.width = `${width}px`;
    b.style.flex = '0 0 auto';
  } else {
    b.style.flex = '1 1 0';
  }
  const lab = label(b, caption, 20, Colors.White, { bold: true });
  b.setCaption = (t) => lab.setText(t);
  b.setColor = (c) => {
    const mix = (k: number, to: number) => css([c[0] + (to - c[0]) * k, c[1] + (to - c[1]) * k, c[2] + (to - c[2]) * k, c[3]]);
    b.style.setProperty('--trn-btn', css(c));
    b.style.setProperty('--trn-btn-hi', mix(0.18, 1));
    b.style.setProperty('--trn-btn-press', mix(0.2, 0));
  };
  b.setColor(color);
  if (onClick) b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

/** HorizontalLayoutGroup / VerticalLayoutGroup with padding (left, right, top, bottom) and spacing. */
export function group(parent: HTMLElement, dir: 'row' | 'column', spacing: number, padding: [number, number, number, number] = [0, 0, 0, 0], align: 'start' | 'center' = 'center'): HTMLElement {
  const g = el('div', 'trn-group', parent);
  g.style.flexDirection = dir;
  g.style.gap = `${spacing}px`;
  g.style.padding = `${padding[2]}px ${padding[1]}px ${padding[3]}px ${padding[0]}px`;
  g.style.alignItems = dir === 'row' ? 'center' : 'stretch';
  g.style.justifyContent = align === 'start' || dir === 'column' ? 'flex-start' : 'center';
  return g;
}

/** A RectTransform anchored at (ax, ay) with the same pivot, at `pos` (Unity y up), sized w×h. */
export function anchored(e: HTMLElement, ax: number, ay: number, pos: [number, number], w: number, h: number): void {
  e.style.position = 'absolute';
  e.style.width = `${w}px`;
  e.style.height = `${h}px`;
  e.style.left = `calc(${ax * 100}% + ${pos[0] - ax * w}px)`;
  e.style.top = `calc(${(1 - ay) * 100}% + ${-pos[1] - (1 - ay) * h}px)`;
}

/** RetentionUi.VerticalScroll: a fixed-height scroll list; returns its content. */
export function verticalScroll(parent: HTMLElement, height: number, spacing = 8): HTMLElement {
  const scroll = el('div', 'trn-scroll', parent);
  scroll.style.height = `${height}px`;
  const content = group(scroll, 'column', spacing);
  return content;
}

/** RetentionUi.InputRow: a caption over a dark input field. */
export function inputRow(parent: HTMLElement, caption: string, value: string, height = 52, numeric = false): HTMLInputElement {
  const row = group(parent, 'column', 4);
  label(row, caption, 16, Colors.White, { align: 'left', height: 22 });
  const input = el('input', 'trn-input', row) as HTMLInputElement;
  input.style.height = `${height}px`;
  input.value = value;
  if (numeric) input.inputMode = 'numeric';
  return input;
}
