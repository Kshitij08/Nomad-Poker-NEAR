/**
 * Renders the retention canvases extracted to data/retention-ui.json (tools/extract-unity-retention.mjs) with the
 * shared uGUI → DOM layer (hud/unityUi.ts). Adds what those canvases need on top of it: their own sprites/fonts
 * (merged into the HUD tables at import), CanvasScaler mapping for a full-screen overlay, AspectRatioFitter
 * (Backdrop / BG envelopes), RectMask2D clipping, Button ColorTint + click sounds, and small helpers the panels use.
 */
import retentionData from '../../data/retention-ui.json';
import { HUD_DATA, assetUrl, buildNode, rgba, type NodeData, type RGBA, type SpriteData, type UNode } from '../../hud/unityUi';
import { PokerSound } from '../../core/orchestration/pokerSound';
import type { AppContext } from '../../app/app';
import './retention.css';
import { portraitMenuLayout, portraitScaleFor } from '../../layout/portraitMenu';

interface ColorData {
  hex: string;
  rgba: [number, number, number, number];
}
export interface ScalerData {
  mode: number;
  referenceResolution: [number, number];
  match: number;
}
export interface RetNodeData extends NodeData {
  components?: NodeData['components'] & {
    button?: { interactable: boolean; transition: string; colors: Record<string, ColorData | number | null>; targetGraphic: string | null };
    rectMask2D?: { enabled: boolean };
    aspectRatioFitter?: { mode: string; ratio: number };
    layoutGroup?: {
      kind: string; padding: [number, number, number, number]; spacing: number | [number, number]; childAlignment: string;
      controlW: boolean; controlH: boolean; expandW: boolean; expandH: boolean; cellSize?: [number, number];
    };
    layoutElement?: { ignoreLayout: boolean; minWidth: number; minHeight: number; preferredWidth: number; preferredHeight: number; flexibleWidth: number; flexibleHeight: number };
    scripts?: { script: string; enabled?: boolean; fields?: Record<string, unknown> }[];
    text?: NonNullable<NodeData['components']>['text'] & { font: string; richText?: boolean };
  };
  children?: RetNodeData[];
}
export interface CanvasEntry {
  name: string;
  source: string;
  scaler: ScalerData;
  sortingOrder?: number;
  root: RetNodeData;
  hudFields?: Record<string, unknown>;
}
interface FontEntry {
  name?: string;
  family?: string;
  file?: string;
  faceInfo?: { pointSize: number; ascentLine: number; descentLine: number };
}

const DATA = retentionData as unknown as {
  canvases: Record<string, CanvasEntry> & { chips: { scaler: ScalerData; chips: Record<string, RetNodeData> } };
  resourceSprites: Record<string, string>;
  sprites: Record<string, SpriteData & { texture?: [number, number] }>;
  fonts: Record<string, FontEntry>;
  materials: Record<string, unknown>;
};
export const RETENTION_DATA = DATA;

// ---- merge sprite / font / material tables into the shared HUD ones (keys are Unity guid[:fileID], globally unique)
for (const [k, v] of Object.entries(DATA.sprites)) if (!HUD_DATA.sprites[k]) HUD_DATA.sprites[k] = v;
for (const [k, v] of Object.entries(DATA.fonts)) if (!HUD_DATA.fonts[k] && v.faceInfo) (HUD_DATA.fonts as Record<string, unknown>)[k] = v;
for (const [k, v] of Object.entries(DATA.materials)) if (!HUD_DATA.materials[k]) (HUD_DATA.materials as Record<string, unknown>)[k] = v;

let fontsRegistered = false;
function registerFonts(): void {
  if (fontsRegistered || typeof document === 'undefined') return;
  fontsRegistered = true;
  for (const f of Object.values(DATA.fonts)) {
    if (!f.file || !f.family) continue;
    try {
      const face = new FontFace(f.family, `url("${assetUrl(f.file)}")`, { weight: '400' });
      document.fonts.add(face);
      void face.load();
    } catch {
      /* unsupported: falls back to the HUD font */
    }
  }
}

/** Sprite NomadRetentionRuntime.Apply would load from Resources (e.g. 'Retention/Art/Missions/claim'). */
export function resourceSprite(resourcesPath: string): SpriteData | null {
  const key = DATA.resourceSprites[resourcesPath];
  return key ? (HUD_DATA.sprites[key] ?? null) : null;
}
export const spriteByKey = (key: string | null | undefined): SpriteData | null => (key ? (HUD_DATA.sprites[key] ?? null) : null);

/** NomadRetentionRuntime.Apply: sprite, Sliced (or Simple + preserveAspect), white. False when the sprite is unknown. */
export function applySprite(node: UNode | null, resourcesPath: string, sliced = true): boolean {
  if (!node?.image) return false;
  const sp = resourceSprite(resourcesPath);
  if (!sp) return false;
  node.image.sprite = sp;
  node.image.type = sliced ? 'Sliced' : 'Simple';
  node.image.color = { r: 1, g: 1, b: 1, a: 1 };
  node.image.preserveAspect = !sliced;
  node.render();
  return true;
}

export const unityColor = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a });
/** RetentionUi palette (Game/Retention/RetentionUi.cs). */
export const RetentionColors = {
  Overlay: unityColor(0.02, 0.03, 0.05, 0.72),
  Panel: unityColor(0.09, 0.11, 0.16, 0.96),
  Gold: unityColor(0.95, 0.78, 0.32),
  GoldDark: unityColor(0.45, 0.32, 0.08),
  Accent: unityColor(0.22, 0.55, 0.95),
  Muted: unityColor(1, 1, 1, 0.55),
  Win: unityColor(0.45, 0.9, 0.5),
  Reel: unityColor(0.06, 0.07, 0.1),
  SpinLabelDark: unityColor(0.18, 0.12, 0.04),
  DayCurrent: unityColor(0.28, 0.22, 0.08),
  DayDone: unityColor(0.1, 0.22, 0.14),
  TierLocked: unityColor(0.12, 0.12, 0.14),
  White: unityColor(1, 1, 1),
  Clear: unityColor(0, 0, 0, 0),
};

// ---------------------------------------------------------------- canvas build

export interface BuiltCanvas {
  readonly root: UNode;
  readonly data: CanvasEntry;
  /** Node path (relative to the canvas root, Unity Transform.Find style) → its extracted data. */
  dataOf(node: UNode): RetNodeData | undefined;
  find(path: string): UNode | null;
  /** Script fields serialized on the node at `path` ('' = root). */
  script(name: string, path?: string): Record<string, unknown> | undefined;
}

const nodeData = new WeakMap<UNode, RetNodeData>();

/** Mirrors buildNode's walk (children without a rect are skipped) to remember each node's data and patch fonts. */
function annotate(n: UNode, d: RetNodeData): void {
  nodeData.set(n, d);
  const tx = d.components?.text;
  if (n.text && tx?.font) {
    const f = DATA.fonts[tx.font];
    if (f?.family) n.text.family = `'${f.family}'`;
  }
  if (d.components?.rectMask2D?.enabled) n.el.style.overflow = 'hidden';
  if ((d.components?.image as { enabled?: boolean } | undefined)?.enabled === false) n.el.classList.add('rt-img-off');
  if ((d.components?.text as { enabled?: boolean } | undefined)?.enabled === false) n.el.classList.add('rt-txt-off');
  const kids = (d.children ?? []).filter((c) => !!c.rect);
  kids.forEach((c, i) => {
    const child = n.children[i];
    if (child && child.name === c.name) annotate(child, c);
  });
}

export function dataOf(node: UNode): RetNodeData | undefined {
  return nodeData.get(node);
}

/** Builds a fresh DOM tree for one extracted node (each call is an independent instance, like Instantiate). */
export function instantiate(d: RetNodeData): UNode {
  registerFonts();
  const n = buildNode(withDisabledGraphics(d));
  annotate(n, d);
  return n;
}

/**
 * buildNode drops disabled Image / TMP components, but the retention scripts switch them on at runtime
 * (NomadSlotSpin's next symbols, WeeklyRewardCard's icon label): build them, then hide them via a class.
 */
function withDisabledGraphics(d: RetNodeData): RetNodeData {
  const c = d.components;
  const img = c?.image as { enabled?: boolean } | undefined;
  const txt = c?.text as { enabled?: boolean } | undefined;
  const out: RetNodeData = { ...d };
  if (c && (img?.enabled === false || txt?.enabled === false)) {
    const comps = { ...c };
    if (c.image && img?.enabled === false) comps.image = { ...c.image, enabled: true };
    if (c.text && txt?.enabled === false) comps.text = { ...c.text, enabled: true };
    out.components = comps;
  }
  if (d.children) out.children = d.children.map(withDisabledGraphics);
  return out;
}

export function buildCanvas(key: string): BuiltCanvas {
  const data = DATA.canvases[key] as CanvasEntry | undefined;
  if (!data?.root) throw new Error(`[retention] no canvas '${key}' in retention-ui.json`);
  const root = instantiate(data.root);
  return {
    root,
    data,
    dataOf,
    find: (p) => root.find(p),
    script(name, p = '') {
      const n = p ? root.find(p) : root;
      return n ? dataOf(n)?.components?.scripts?.find((s) => s.script === name)?.fields : undefined;
    },
  };
}

export function chipData(key: 'coins' | 'level' | 'missions' | 'friends'): RetNodeData | undefined {
  return DATA.canvases.chips?.chips?.[key];
}
export const chipsScaler = (): ScalerData => DATA.canvases.chips?.scaler ?? { mode: 1, referenceResolution: [1920, 1080], match: 0.5 };

// ---------------------------------------------------------------- overlay mounting (CanvasScaler)

/** CanvasScaler ScaleWithScreenSize + MatchWidthOrHeight. */
export function scaleFactor(scaler: ScalerData, w: number, h: number): number {
  const [rw, rh] = scaler.referenceResolution;
  if (scaler.mode !== 1) return 1;
  const portrait = portraitScaleFor(scaler.referenceResolution, w, h); // layout/portraitMenu.ts
  if (portrait !== null) return portrait;
  return Math.pow(2, (1 - scaler.match) * Math.log2(w / rw) + scaler.match * Math.log2(h / rh));
}

/**
 * A full-screen overlay canvas: the root RectTransform is sized to screen / scaleFactor and scaled back up with one
 * CSS transform. Re-lays out on resize; AspectRatioFitters run before each layout.
 */
export class OverlayCanvas {
  readonly host = document.createElement('div');
  private readonly ro: ResizeObserver;
  scale = 1;
  private readonly fitters: { node: UNode; mode: string; ratio: number }[] = [];
  private readonly beforeLayout: (() => void)[] = [];

  constructor(parent: HTMLElement, readonly root: UNode, readonly scaler: ScalerData) {
    this.host.className = 'rt-canvas';
    this.host.append(root.el);
    parent.append(this.host);
    root.el.style.transformOrigin = '0 0';
    for (const n of root.walk()) {
      const arf = dataOf(n)?.components?.aspectRatioFitter;
      if (arf && arf.mode !== 'None') this.fitters.push({ node: n, mode: arf.mode, ratio: arf.ratio });
    }
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.host);
    this.layout();
  }

  /** Runs before every layout pass (e.g. code-driven layout groups). */
  onBeforeLayout(fn: () => void): void {
    this.beforeLayout.push(fn);
  }

  layout(): void {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    const s = scaleFactor(this.scaler, w, h);
    this.scale = s;
    const r = this.root;
    r.anchorMin = [0, 0];
    r.anchorMax = [1, 1];
    r.pivot = [0.5, 0.5];
    r.scale = [1, 1];
    r.sizeDelta = [w / s, h / s];
    r.renderScale = s;
    portraitMenuLayout(r, 'panels'); // portrait: centred panels fill the 1080 column (layout/portraitMenu.ts)
    r.layout(); // sizes first, so fitters can read parent rects
    for (const f of this.fitters) applyAspectFitter(f.node, f.mode, f.ratio);
    for (const fn of this.beforeLayout) fn();
    r.layout();
    r.el.style.transform = `scale(${s})`;
  }

  dispose(): void {
    this.ro.disconnect();
    this.host.remove();
  }
}

/** UnityEngine.UI.AspectRatioFitter for the modes the retention art uses. */
export function applyAspectFitter(n: UNode, mode: string, ratio: number): void {
  const p = n.parent;
  if (!p || !(ratio > 0)) return;
  const pw = p.w;
  const ph = p.h;
  if (mode === 'EnvelopeParent' || mode === 'FitInParent') {
    const envelope = mode === 'EnvelopeParent';
    let w = pw;
    let h = pw / ratio;
    if (envelope ? h < ph : h > ph) {
      h = ph;
      w = ph * ratio;
    }
    n.anchorMin = [0.5, 0.5];
    n.anchorMax = [0.5, 0.5];
    n.anchoredPosition = [0, 0];
    n.sizeDelta = [w, h];
  } else if (mode === 'WidthControlsHeight') {
    n.sizeDelta = [n.sizeDelta[0], n.w / ratio - (n.anchorMax[1] - n.anchorMin[1]) * ph];
  } else if (mode === 'HeightControlsWidth') {
    n.sizeDelta = [n.h * ratio - (n.anchorMax[0] - n.anchorMin[0]) * pw, n.sizeDelta[1]];
  }
}

// ---------------------------------------------------------------- buttons

export interface ButtonHandle {
  readonly node: UNode;
  interactable: boolean;
  setInteractable(v: boolean): void;
  dispose(): void;
}

const buttonOf = new WeakMap<UNode, ButtonHandle>();

/**
 * Makes `node` clickable (uGUI Button). ColorTint transitions use the extracted colours on the target graphic;
 * `sound` mirrors PokerButtonSfx / PokerAudio.AssignButton (silent when not interactable).
 */
export function wireButton(ctx: AppContext | null, node: UNode | null, onClick: (() => void) | null, opts: { sound?: PokerSound | null } = {}): ButtonHandle | null {
  if (!node) return null;
  buttonOf.get(node)?.dispose();
  const d = dataOf(node)?.components?.button;
  const target = d?.targetGraphic ? (findFromCanvasRoot(node, d.targetGraphic) ?? node) : node;
  const colors = d?.transition === 'ColorTint' ? d.colors : null;
  const tint = (key: string): RGBA => {
    const c = colors?.[key] as ColorData | undefined;
    const m = (colors?.colorMultiplier as number | undefined) ?? 1;
    if (!c) return { r: 1, g: 1, b: 1, a: 1 };
    const v = rgba(c);
    return { r: Math.min(1, v.r * m), g: Math.min(1, v.g * m), b: Math.min(1, v.b * m), a: Math.min(1, v.a * m) };
  };
  const sound = opts.sound === undefined ? (dataOf(node)?.components?.scripts?.some((s) => s.script === 'PokerButtonSfx') ? PokerSound.ButtonGeneric : null) : opts.sound;
  let hover = false;
  let down = false;
  const el = node.el;
  el.classList.add('rt-hit');
  const handle: ButtonHandle = {
    node,
    interactable: d?.interactable ?? true,
    setInteractable(v: boolean) {
      handle.interactable = v;
      paint();
    },
    dispose() {
      el.classList.remove('rt-hit');
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerdown', press);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('click', click);
      buttonOf.delete(node);
    },
  };
  const paint = () => {
    if (colors && target.image) {
      target.imageTint = !handle.interactable ? tint('disabled') : down ? tint('pressed') : hover ? tint('highlighted') : tint('normal');
      target.render();
    }
    el.classList.toggle('rt-disabled', !handle.interactable);
  };
  const enter = () => ((hover = true), paint());
  const leave = () => ((hover = false), (down = false), paint());
  const press = () => ((down = true), paint());
  const release = () => ((down = false), paint());
  const click = (e: Event) => {
    e.stopPropagation();
    if (!handle.interactable || !node.activeInHierarchy) return;
    if (sound != null) ctx?.audio.play(sound);
    onClick?.();
  };
  el.addEventListener('pointerenter', enter);
  el.addEventListener('pointerleave', leave);
  el.addEventListener('pointerdown', press);
  el.addEventListener('pointerup', release);
  el.addEventListener('click', click);
  paint();
  buttonOf.set(node, handle);
  return handle;
}

function findFromCanvasRoot(node: UNode, path: string): UNode | null {
  let r: UNode = node;
  while (r.parent) r = r.parent;
  // Paths are relative to the exported root's parent, so they start with the root's own name.
  return path === r.name ? r : path.startsWith(r.name + '/') ? r.find(path.slice(r.name.length + 1)) : r.find(path);
}

// ---------------------------------------------------------------- small helpers

export function setText(root: UNode | null, path: string, text: string): void {
  const n = path ? root?.find(path) : root;
  n?.setText(text);
}

/** TMP rich text subset the retention rows use (<size=%>, <color=#>, <b>): text fitting uses the plain text. */
export function setRichText(node: UNode | null, rich: string): void {
  if (!node?.text) return;
  const plain = rich.replace(/<[^>]+>/g, '');
  node.setText(plain);
  const span = node.el.querySelector('.u-text > span');
  if (!span) return;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let html = '';
  let i = 0;
  const re = /<(\/?)(size|color|b)(?:=([^>]+))?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rich))) {
    html += esc(rich.slice(i, m.index));
    i = m.index + m[0].length;
    if (m[1]) html += '</span>';
    else if (m[2] === 'size') html += `<span style="font-size:${m[3]!.endsWith('%') ? m[3] : m[3] + 'px'}">`;
    else if (m[2] === 'color') html += `<span style="color:${m[3]}">`;
    else html += '<span style="font-weight:700">';
  }
  html += esc(rich.slice(i));
  span.innerHTML = html.replace(/\n/g, '<br>');
}

export function setAlpha(node: UNode | null, a: number): void {
  if (!node) return;
  node.groupAlpha = a;
  node.el.style.opacity = a >= 0.999 ? '' : String(Math.max(0, a));
}

/** Writes the scale on the element (cheap per-frame path; layout() would re-render the subtree). */
export function setScale(node: UNode | null, s: number, sy = s): void {
  if (!node) return;
  node.scale = [s, sy];
  applyTransform(node);
}

export function setAnchored(node: UNode | null, x: number, y: number): void {
  if (!node) return;
  node.anchoredPosition = [x, y];
  if (!node.parent) return;
  const pw = node.parent.w;
  const ph = node.parent.h;
  const w = node.w;
  const h = node.h;
  const px = (node.anchorMin[0] + (node.anchorMax[0] - node.anchorMin[0]) * node.pivot[0]) * pw + x;
  const py = (node.anchorMin[1] + (node.anchorMax[1] - node.anchorMin[1]) * node.pivot[1]) * ph + y;
  node.el.style.left = `${px - node.pivot[0] * w}px`;
  node.el.style.top = `${ph - (py - node.pivot[1] * h + h)}px`;
}

export function applyTransform(node: UNode): void {
  const parts: string[] = [];
  if (node.rotation) parts.push(`rotate(${-node.rotation}deg)`);
  if (node.scale[0] !== 1 || node.scale[1] !== 1) parts.push(`scale(${node.scale[0]},${node.scale[1]})`);
  node.el.style.transform = parts.join(' ');
}

export function setImageAlpha(node: UNode | null, a: number): void {
  if (!node?.image) return;
  node.image.color = { ...node.image.color, a };
  const gfx = node.el.querySelector(':scope > .u-gfx') as HTMLElement | null;
  if (gfx) gfx.style.opacity = a >= 0.999 ? '' : String(Math.max(0, a));
  else node.render();
}

export function setImageColor(node: UNode | null, c: RGBA): void {
  if (!node?.image) return;
  node.image.color = c;
  node.render();
}

export function setImageSprite(node: UNode | null, sprite: SpriteData | null): void {
  if (!node?.image) return;
  node.image.sprite = sprite;
  node.render();
  // An unchanged-size Simple image keeps its old background until re-rendered with the new url.
}

/** Image.enabled. */
export function setImageEnabled(node: UNode | null, on: boolean): void {
  node?.el.classList.toggle('rt-img-off', !on);
}

/** TMP_Text.enabled. */
export function setTextEnabled(node: UNode | null, on: boolean): void {
  node?.el.classList.toggle('rt-txt-off', !on);
}

export function setTextAlpha(node: UNode | null, a: number): void {
  const t = node?.el.querySelector(':scope > .u-text') as HTMLElement | null;
  if (t) t.style.opacity = a >= 0.999 ? '' : String(Math.max(0, a));
}

/** A serialized object reference ({ path: 'Root/A/B' }) resolved against the built canvas root. */
export function refNode(root: UNode, fields: Record<string, unknown> | undefined, key: string): UNode | null {
  const ref = fields?.[key] as { path?: string } | undefined;
  if (!ref?.path) return null;
  if (ref.path === root.name) return root;
  return ref.path.startsWith(root.name + '/') ? root.find(ref.path.slice(root.name.length + 1)) : root.find(ref.path);
}

/**
 * RetentionUi.SetXpBarProgress: drives an XP fill by its right anchor (never Filled): Gold while there is progress,
 * hidden at zero.
 */
export function setXpBarProgress(fill: UNode | null, progress01: number): void {
  if (!fill?.image) return;
  const p = Math.min(1, Math.max(0, progress01));
  const has = p > 0.001;
  fill.image.sprite = null;
  fill.image.type = 'Simple';
  fill.image.color = has ? RetentionColors.Gold : RetentionColors.Clear;
  fill.scale = [1, 1];
  fill.pivot = [0, 0.5];
  fill.anchorMin = [0, 0];
  fill.anchorMax = [has ? p : 0.0001, 1];
  fill.anchoredPosition = [0, 0];
  fill.sizeDelta = [0, 0];
  setImageEnabled(fill, has);
  if (fill.parent) fill.layout();
}

/**
 * Horizontal/VerticalLayoutGroup for children that do not control size (childControlWidth/Height off): places
 * the active, non-ignored children in a row/column with spacing + alignment, as uGUI does.
 */
export function layoutLine(parent: UNode, vertical: boolean, spacing: number, align: string, padding: [number, number, number, number] = [0, 0, 0, 0]): void {
  const kids = parent.children.filter((c) => c.activeSelf && !dataOf(c)?.components?.layoutElement?.ignoreLayout);
  const [pl, pr, pt, pb] = padding;
  const size = (c: UNode) => (vertical ? c.sizeDelta[1] * c.scale[1] : c.sizeDelta[0] * c.scale[0]);
  const total = kids.reduce((a, c) => a + size(c), 0) + spacing * Math.max(0, kids.length - 1);
  const W = parent.w || parent.sizeDelta[0];
  const H = parent.h || parent.sizeDelta[1];
  const main = vertical ? H - pt - pb : W - pl - pr;
  const a = align.toLowerCase();
  const frac = vertical ? (a.startsWith('upper') ? 0 : a.startsWith('lower') ? 1 : 0.5) : a.endsWith('left') ? 0 : a.endsWith('right') ? 1 : 0.5;
  let cursor = (vertical ? pt : pl) + (main - total) * frac;
  for (const c of kids) {
    const s = size(c);
    c.anchorMin = [0, 1];
    c.anchorMax = [0, 1];
    if (vertical) {
      const crossFrac = a.endsWith('left') ? 0 : a.endsWith('right') ? 1 : 0.5;
      const cw = c.sizeDelta[0] * c.scale[0];
      const x = pl + (W - pl - pr - cw) * crossFrac + cw * c.pivot[0];
      c.anchoredPosition = [x, -(cursor + s * (1 - c.pivot[1]))];
    } else {
      const crossFrac = a.startsWith('upper') ? 0 : a.startsWith('lower') ? 1 : 0.5;
      const ch = c.sizeDelta[1] * c.scale[1];
      const y = pt + (H - pt - pb - ch) * crossFrac + ch * (1 - c.pivot[1]);
      c.anchoredPosition = [cursor + s * c.pivot[0], -y];
    }
    cursor += s + spacing;
  }
}
