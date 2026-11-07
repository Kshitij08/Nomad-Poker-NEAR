/**
 * A small uGUI → DOM layer: RectTransform layout, Image (Simple / Sliced / Filled Radial360) and TextMeshPro labels,
 * driven by the node trees `web/tools/extract-unity-hud.mjs` wrote to `data/unity-hud.json`.
 *
 * Every Unity node becomes an absolutely positioned <div> nested exactly like the hierarchy, sized in canvas units
 * (1 CSS px = 1 canvas unit). A canvas root is then mapped to the screen by one CSS transform (world-space canvases:
 * the projected affine of the canvas plane; the overlay canvas: CanvasScaler's scale factor), so the inner layout is
 * Unity's own numbers, untouched.
 */
import hudData from '../data/unity-hud.json';
import { applyThemeSlots, classifyThemeDefault, getActiveHudTheme, trackThemedNode, type DefaultThemeKeys, type NodeThemeSlots } from './hudTheme';

// ---------------------------------------------------------------- data types (the parts of unity-hud.json we read)

export type Vec2 = [number, number];
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}
interface ColorData {
  hex: string;
  rgba: [number, number, number, number];
}
export interface SpriteData {
  name: string;
  file?: string;
  ppu: number;
  rect: [number, number, number, number];
  border: [number, number, number, number];
  exportSize?: [number, number];
  borderExported?: [number, number, number, number];
}
interface ImageData {
  enabled?: boolean;
  sprite: string | null;
  color: ColorData;
  type: string;
  preserveAspect?: boolean;
  fillMethod?: string;
  fillAmount?: number;
  fillOrigin?: number;
  fillClockwise?: boolean;
  pixelsPerUnitMultiplier?: number;
}
interface TextData {
  enabled?: boolean;
  text: string;
  font: string;
  material?: string;
  fontSize: number;
  autoSize: boolean;
  fontSizeMin: number;
  fontSizeMax: number;
  fontStyle: string[];
  color: ColorData;
  alignH: string;
  alignV: string;
  wrapping: boolean;
  margin: [number, number, number, number];
}
export interface NodeData {
  name: string;
  path: string;
  active: boolean;
  rect?: {
    anchorMin: Vec2;
    anchorMax: Vec2;
    anchoredPosition: Vec2;
    sizeDelta: Vec2;
    pivot: Vec2;
    euler: [number, number, number];
    scale: [number, number, number];
  };
  components?: {
    image?: ImageData;
    text?: TextData;
    mask?: { enabled: boolean; showMaskGraphic: boolean };
    canvasGroup?: { alpha: number };
  };
  themeDefault?: {
    rules?: string[];
    image?: { sprite?: string; type?: string; color?: ColorData; pixelsPerUnitMultiplier?: number };
    text?: { color?: ColorData };
  };
  children?: NodeData[];
}
export interface CanvasData {
  name: string;
  role: string;
  seatSlot?: number | null;
  world?: { position: [number, number, number]; scale: [number, number, number] };
  canvasSizes?: Record<string, unknown>;
  scaler: { referenceResolution: Vec2; matchWidthOrHeight: number };
  root: NodeData;
}
export interface FontData {
  name: string;
  faceInfo: { pointSize: number; lineHeight: number; ascentLine: number; descentLine: number };
}
export interface MaterialData {
  underlay?: { enabled: boolean; color: ColorData; dilate: number };
}

const data = hudData as unknown as {
  canvases: CanvasData[];
  sprites: Record<string, SpriteData>;
  fonts: Record<string, FontData>;
  materials: Record<string, MaterialData>;
  tableView: { seatViews: { slot: number; canvas: string; mirrored: boolean; fields: Record<string, unknown> }[] };
  theme: { default: string; packs: { theme: string; pot: string; menuButton: string; buttonLabelColor: ColorData; accentColor: ColorData }[] };
};
export const HUD_DATA = data;

// THEME HOOK: the default pack's keys/colours, so buildNode can record which baked values are pack-dependent.
const DEFAULT_THEME_KEYS: DefaultThemeKeys = (() => {
  const p = data.theme.packs.find((k) => k.theme === data.theme.default) ?? data.theme.packs[0]!;
  const c = (x: ColorData) => ({ r: x.rgba[0], g: x.rgba[1], b: x.rgba[2], a: x.rgba[3] });
  return { pot: p.pot, menuButton: p.menuButton, label: c(p.buttonLabelColor), accent: c(p.accentColor) };
})();

export const ASSET_BASE = import.meta.env.BASE_URL ?? '/';
export const assetUrl = (file: string): string => ASSET_BASE + file;

export function rgba(c: ColorData | undefined, fallback: RGBA = { r: 1, g: 1, b: 1, a: 1 }): RGBA {
  if (!c) return { ...fallback };
  const [r, g, b, a] = c.rgba;
  return { r, g, b, a };
}
export function hexColor(hex: string): RGBA {
  const h = hex.replace('#', '');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length >= 8 ? n(6) : 1 };
}
export const cssColor = (c: RGBA): string =>
  `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${+c.a.toFixed(4)})`;
const mul = (a: RGBA, b: RGBA): RGBA => ({ r: a.r * b.r, g: a.g * b.g, b: a.b * b.b, a: a.a * b.a });

/** SeatView.Greyscale: luminance (.299/.587/.114) × foldedBrightness, alpha kept (foldedGrayscale is 1 in the scene). */
export function foldGrey(c: RGBA, brightness: number): RGBA {
  const l = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) * brightness;
  return { r: l, g: l, b: l, a: c.a };
}

// ---------------------------------------------------------------- sprites and tinting

/** Unity multiplies the sprite by Image.color. Grey tints are a CSS brightness filter; others get a tinted copy. */
const imageCache = new Map<string, HTMLImageElement>();
const tintCache = new Map<string, string>();
const waiting = new Map<string, Set<() => void>>();

function loadImage(file: string, onReady: () => void): HTMLImageElement | null {
  let img = imageCache.get(file);
  if (img?.complete && img.naturalWidth) return img;
  if (!img) {
    img = new Image();
    img.src = assetUrl(file);
    imageCache.set(file, img);
    img.onload = () => {
      const fns = waiting.get(file);
      waiting.delete(file);
      fns?.forEach((fn) => fn());
    };
  }
  let set = waiting.get(file);
  if (!set) waiting.set(file, (set = new Set()));
  set.add(onReady);
  return null;
}

function tintedUrl(file: string, c: RGBA, onReady: () => void): string | null {
  const key = `${file}|${c.r.toFixed(3)},${c.g.toFixed(3)},${c.b.toFixed(3)}`;
  const hit = tintCache.get(key);
  if (hit) return hit;
  const img = loadImage(file, onReady);
  if (!img) return null;
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height);
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i] * c.r;
    d[i + 1] = d[i + 1] * c.g;
    d[i + 2] = d[i + 2] * c.b;
  }
  ctx.putImageData(px, 0, 0);
  const url = cv.toDataURL('image/png');
  tintCache.set(key, url);
  return url;
}

/** Sprites that are a plain white disc: drawn as CSS colour + border-radius (exact for a circle, any tint). */
const isWhiteCircle = (s: SpriteData | null) => !!s && s.name === 'Circle';

// ---------------------------------------------------------------- TMP text fitting

const FONT_FAMILY: Record<string, string> = {
  'NotoSans-Bold SDF': "'UnityNotoSansBold'",
  'NotoSans-Bold SDF_Stroke': "'UnityNotoSansBold'",
  'LiberationSans SDF': "'UnityLiberationSans'",
};

/** Maps a TMP font asset name to a CSS font-family (for UI extracted by other tools, e.g. the menu scene). */
export function registerTmpFont(tmpAssetName: string, cssFamily: string): void {
  FONT_FAMILY[tmpAssetName] = cssFamily;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Greedy word wrap (TMP breaks at spaces); returns line count, or Infinity when a single word does not fit. */
function wrapLines(text: string, maxW: number, font: string, wrap: boolean): number {
  let count = 0;
  for (const para of text.split('\n')) {
    if (!wrap) {
      if (measure(para, font) > maxW + 0.01) return Infinity;
      count++;
      continue;
    }
    const words = para.split(' ');
    let line = '';
    let lines = 1;
    for (const w of words) {
      if (measure(w, font) > maxW + 0.01) return Infinity;
      const next = line ? line + ' ' + w : w;
      if (measure(next, font) > maxW + 0.01) {
        lines++;
        line = w;
      } else line = next;
    }
    count += lines;
  }
  return count;
}

// ---------------------------------------------------------------- nodes

export interface ImageState {
  sprite: SpriteData | null;
  type: string;
  ppuM: number;
  /** Image.color (authored, then the SOLANA theme). */
  color: RGBA;
  preserveAspect: boolean;
  fillMethod: string;
  fillAmount: number;
  fillOrigin: number;
  fillClockwise: boolean;
}

export interface TextState {
  text: string;
  family: string;
  lineRatio: number;
  fontSize: number;
  autoSize: boolean;
  min: number;
  max: number;
  bold: boolean;
  upper: boolean;
  color: RGBA;
  alignH: string;
  alignV: string;
  wrap: boolean;
  margin: [number, number, number, number];
  underlay: RGBA | null;
  /** TMP rich text (<b>, <i>, <color=#..>, <size=N%>, <br>): rendered as HTML (escaped, known tags only). Menu dialogs. */
  rich?: boolean;
  /** TMP overflow Ellipsis: text that still does not fit at its smallest size ends with "…". */
  ellipsis?: boolean;
}

/** Strips TMP rich-text tags (for measuring). */
export function stripTmpTags(s: string): string {
  return s.replace(/<\/?(b|i|u|s|color|size|alpha|br|mark|sup|sub|font-weight|cspace|nobr|noparse|lowercase|uppercase|smallcaps)(=[^>]*)?>/gi, (m) => (/^<br/i.test(m) ? '\n' : ''));
}

/** TMP rich text → safe HTML: everything escaped, then the supported tags turned back into spans. */
export function tmpRichToHtml(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return esc
    .replace(/&lt;br\s*\/?&gt;/gi, '\n')
    .replace(/&lt;b&gt;/gi, '<b>').replace(/&lt;\/b&gt;/gi, '</b>')
    .replace(/&lt;i&gt;/gi, '<i>').replace(/&lt;\/i&gt;/gi, '</i>')
    .replace(/&lt;u&gt;/gi, '<u>').replace(/&lt;\/u&gt;/gi, '</u>')
    .replace(/&lt;color=(?:&quot;)?(#[0-9a-f]{3,8}|[a-z]+)(?:&quot;)?&gt;/gi, (_m, c: string) => `<span style="color:${c}">`)
    .replace(/&lt;size=(\d+(?:\.\d+)?)(%|px)?&gt;/gi, (_m, v: string, u: string | undefined) => `<span style="font-size:${u === '%' ? `${v}%` : `${v}px`}">`)
    .replace(/&lt;\/(color|size)&gt;/gi, '</span>');
}

let uid = 0;

/** One RectTransform (+ optional Image / TMP text) as a DOM element. */
export class UNode {
  readonly el = document.createElement('div');
  readonly children: UNode[] = [];
  parent: UNode | null = null;
  readonly id = uid++;

  anchorMin: Vec2 = [0.5, 0.5];
  anchorMax: Vec2 = [0.5, 0.5];
  anchoredPosition: Vec2 = [0, 0];
  sizeDelta: Vec2 = [100, 100];
  pivot: Vec2 = [0.5, 0.5];
  scale: Vec2 = [1, 1];
  /** Z rotation in degrees (Unity: counter-clockwise, y up). */
  rotation = 0;
  /** CanvasGroup alpha (multiplies everything under this node). */
  groupAlpha = 1;

  image: ImageState | null = null;
  text: TextState | null = null;
  /** Extra colour multiplier on the image (Selectable ColorTint / CanvasRenderer colour). */
  imageTint: RGBA = { r: 1, g: 1, b: 1, a: 1 };
  /** Overrides image.color entirely (Animator writing Image.m_Color). */
  imageColorOverride: RGBA | null = null;
  /** SeatView fold greyscale: non-null = brightness applied to every colour under the fold root. */
  foldBrightness: number | null = null;
  maskWithGraphic = false;
  /** THEME HOOK: which theme-pack values this node's baked default-theme override used (see hudTheme.ts). */
  themeSlots: NodeThemeSlots | null = null;
  /** Canvas roots only: screen px per canvas unit (sliced sprites are rasterised at this resolution). */
  renderScale = 1;

  private gfx: HTMLDivElement | null = null;
  private textBox: HTMLDivElement | null = null;
  private textSpan: HTMLSpanElement | null = null;
  private lastFit = '';
  private fittedSize = 0;
  private activeSelfFlag = true;
  w = 0;
  h = 0;

  readonly onEnable: (() => void)[] = [];
  readonly onDisable: (() => void)[] = [];

  constructor(readonly name: string) {
    this.el.className = 'u-node';
    this.el.dataset.name = name;
  }

  get activeSelf(): boolean {
    return this.activeSelfFlag;
  }

  get activeInHierarchy(): boolean {
    return this.activeSelfFlag && (this.parent ? this.parent.activeInHierarchy : true);
  }

  /** GameObject.SetActive: shows/hides, and fires OnEnable/OnDisable (Animators restart on enable). */
  setActive(v: boolean): void {
    if (v === this.activeSelfFlag) return;
    const parentActive = this.parent ? this.parent.activeInHierarchy : true;
    this.activeSelfFlag = v;
    this.el.style.display = v ? '' : 'none';
    if (!parentActive) return;
    if (v) {
      this.layout();
      this.fire(true);
    } else this.fire(false);
  }

  private fire(enable: boolean): void {
    if (!this.activeSelfFlag) return;
    for (const fn of enable ? this.onEnable : this.onDisable) fn();
    for (const c of this.children) c.fire(enable);
  }

  add(child: UNode, index = this.children.length): UNode {
    child.parent = this;
    this.children.splice(index, 0, child);
    const after = this.children[index + 1];
    if (after) this.el.insertBefore(child.el, after.el);
    else this.el.append(child.el);
    return child;
  }

  /** Transform.SetAsLastSibling. */
  setAsLastSibling(): void {
    const p = this.parent;
    if (!p) return;
    p.children.splice(p.children.indexOf(this), 1);
    p.children.push(this);
    p.el.append(this.el);
  }

  find(path: string): UNode | null {
    if (!path) return this;
    // Unity names may contain '/' ("Check/fold", "button_1/4"): match whole child names as path prefixes.
    for (const c of this.children) {
      if (path === c.name) return c;
      if (path.startsWith(c.name + '/')) {
        const hit = c.find(path.slice(c.name.length + 1));
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Every node in this subtree (self first). */
  *walk(): Generator<UNode> {
    yield this;
    for (const c of this.children) yield* c.walk();
  }

  // ---------------------------------------------------------- layout

  /** Lays this node out inside its parent's rect (a root keeps its own sizeDelta), then its children. */
  layout(): void {
    let left: number;
    let top: number;
    if (this.parent) {
      const pw = this.parent.w;
      const ph = this.parent.h;
      const w = (this.anchorMax[0] - this.anchorMin[0]) * pw + this.sizeDelta[0];
      const h = (this.anchorMax[1] - this.anchorMin[1]) * ph + this.sizeDelta[1];
      const px = (this.anchorMin[0] + (this.anchorMax[0] - this.anchorMin[0]) * this.pivot[0]) * pw + this.anchoredPosition[0];
      const py = (this.anchorMin[1] + (this.anchorMax[1] - this.anchorMin[1]) * this.pivot[1]) * ph + this.anchoredPosition[1];
      this.w = w;
      this.h = h;
      left = px - this.pivot[0] * w;
      top = ph - (py - this.pivot[1] * h + h);
    } else {
      this.w = this.sizeDelta[0];
      this.h = this.sizeDelta[1];
      left = 0;
      top = 0;
    }
    const s = this.el.style;
    s.left = `${left}px`;
    s.top = `${top}px`;
    s.width = `${this.w}px`;
    s.height = `${this.h}px`;
    if (this.parent) {
      const ox = this.pivot[0] * this.w;
      const oy = (1 - this.pivot[1]) * this.h;
      s.transformOrigin = `${ox}px ${oy}px`;
      const parts: string[] = [];
      if (this.rotation) parts.push(`rotate(${-this.rotation}deg)`);
      if (this.scale[0] !== 1 || this.scale[1] !== 1) parts.push(`scale(${this.scale[0]},${this.scale[1]})`);
      s.transform = parts.join(' ');
    }
    s.opacity = this.groupAlpha === 1 ? '' : String(this.groupAlpha);
    this.render();
    for (const c of this.children) if (c.activeSelf) c.layout();
  }

  // ---------------------------------------------------------- graphics

  /** The fold brightness inherited from the nearest ancestor that sets one (null = not folded). */
  private fold(): number | null {
    // A negative value marks a subtree SeatView exempts from the tint (the Hand strength panel).
    for (let n: UNode | null = this; n; n = n.parent) if (n.foldBrightness !== null) return n.foldBrightness < 0 ? null : n.foldBrightness;
    return null;
  }

  render(): void {
    if (this.image) this.renderImage();
    if (this.text) this.renderText();
  }

  private renderImage(): void {
    const img = this.image!;
    if (!this.gfx) {
      this.gfx = document.createElement('div');
      this.gfx.className = 'u-gfx';
      this.el.prepend(this.gfx);
    }
    const g = this.gfx.style;
    const fold = this.fold();
    let base = this.imageColorOverride ?? img.color;
    if (fold !== null) base = foldGrey(base, fold);
    const c = mul(base, this.imageTint);
    const w = this.w;
    const h = this.h;
    const sp = img.sprite;
    g.opacity = c.a >= 0.999 ? '' : String(c.a);

    // Filled Radial360: a conic mask over the disc (fillOrigin 2 = Top; clockwise flag as authored).
    if (img.type === 'Filled' && img.fillMethod === 'Radial360') {
      const deg = Math.max(0, Math.min(1, img.fillAmount)) * 360;
      const origin = [180, 90, 0, 270][img.fillOrigin] ?? 0; // Bottom, Right, Top, Left → CSS conic start
      const mask = img.fillClockwise
        ? `conic-gradient(from ${origin}deg, #000 0deg ${deg}deg, transparent ${deg}deg 360deg)`
        : `conic-gradient(from ${origin}deg, transparent 0deg ${360 - deg}deg, #000 ${360 - deg}deg 360deg)`;
      g.webkitMaskImage = mask;
      g.maskImage = mask;
    }

    if (!sp || isWhiteCircle(sp) || !sp.file) {
      // No sprite (plain quad) / white disc / Unity built-in rounded "Background": colour + radius.
      g.backgroundImage = '';
      g.filter = '';
      if (this.sliceCanvas) {
        this.sliceCanvas.remove();
        this.sliceCanvas = null;
        this.sliceKey = '';
      }
      g.backgroundColor = cssColor({ ...c, a: 1 });
      if (!sp) g.borderRadius = '0';
      else if (!sp.file) {
        const b = 10 / img.ppuM; // UISprite: 32×32, 10 px borders
        g.borderRadius = `${Math.min(b, w / 2)}px / ${Math.min(b, h / 2)}px`;
      } else if (img.type === 'Sliced') {
        const [L, B, R, T] = sp.border.map((v) => v / img.ppuM);
        const fx = Math.min(1, w / (L + R || 1));
        const fy = Math.min(1, h / (B + T || 1));
        g.borderRadius = `${L * fx}px / ${T * fy}px`;
      } else g.borderRadius = '50%';
      if (this.maskWithGraphic) {
        // Mask over a white disc / rounded plate: clip the children to the same rounded shape.
        this.el.style.overflow = 'hidden';
        this.el.style.borderRadius = g.borderRadius;
      }
      return;
    }

    // THEME HOOK: a sprite swapped in at runtime (theme packs) must not keep the plain-quad fill / radius.
    g.backgroundColor = '';
    g.borderRadius = '';
    const grey = Math.abs(c.r - c.g) < 0.002 && Math.abs(c.g - c.b) < 0.002;
    g.filter = grey && c.r < 0.999 ? `brightness(${c.r})` : '';
    if (img.type === 'Sliced') {
      // CSS border-image seams under a scaled transform, so the 9-slice is drawn into a canvas at screen resolution.
      g.backgroundImage = '';
      this.drawSliced(sp, img.ppuM, grey ? null : c);
    } else {
      if (this.sliceCanvas) {
        this.sliceCanvas.remove();
        this.sliceCanvas = null;
        this.sliceKey = '';
      }
      const url = grey ? assetUrl(sp.file) : tintedUrl(sp.file, c, () => this.render());
      if (!url) return;
      g.backgroundImage = `url("${url}")`;
      g.backgroundSize = img.preserveAspect ? 'contain' : '100% 100%';
    }
    if (this.maskWithGraphic) {
      // Mask (showMaskGraphic): children are clipped to this sprite's alpha.
      const m = `url("${assetUrl(sp.file)}")`;
      this.el.style.webkitMaskImage = m;
      this.el.style.maskImage = m;
      this.el.style.webkitMaskSize = '100% 100%';
      this.el.style.maskSize = '100% 100%';
    }
  }

  private sliceCanvas: HTMLCanvasElement | null = null;
  private sliceKey = '';

  /** Screen pixels per canvas unit for this node's canvas (set on the canvas root by its owner), × devicePixelRatio. */
  private pixelScale(): number {
    let n: UNode = this;
    while (n.parent) n = n.parent;
    return Math.max(0.05, n.renderScale) * (window.devicePixelRatio || 1);
  }

  /**
   * Image.Type Sliced: corners at border size (source px / pixelsPerUnitMultiplier canvas units, each axis shrunk on
   * its own when the rect is smaller than its two borders, as Unity does), edges and centre stretched.
   */
  private drawSliced(sp: SpriteData, ppuM: number, tint: RGBA | null): void {
    const q = Math.round(this.pixelScale() * 100) / 100;
    const W = Math.max(1, Math.round(this.w * q));
    const H = Math.max(1, Math.round(this.h * q));
    const key = `${sp.file}|${W}x${H}|${ppuM}|${tint ? `${tint.r.toFixed(3)},${tint.g.toFixed(3)},${tint.b.toFixed(3)}` : ''}`;
    if (key === this.sliceKey) return;
    const im = loadImage(sp.file!, () => this.render());
    if (!im) return;
    this.sliceKey = key;
    if (!this.sliceCanvas) {
      this.sliceCanvas = document.createElement('canvas');
      this.sliceCanvas.className = 'u-slice';
      this.gfx!.append(this.sliceCanvas);
    }
    const cv = this.sliceCanvas;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'high';
    const [L, B, R, T] = sp.border.map((v) => (v / ppuM) * q);
    const fx = Math.min(1, W / (L + R || 1));
    const fy = Math.min(1, H / (B + T || 1));
    const dl = Math.round(L * fx), dr = Math.round(R * fx), dt = Math.round(T * fy), db = Math.round(B * fy);
    const [eL, eB, eR, eT] = sp.borderExported ?? sp.border;
    const iw = im.naturalWidth, ih = im.naturalHeight;
    const sx = [0, eL, iw - eR, iw], sy = [0, eT, ih - eB, ih];
    const dx = [0, dl, W - dr, W], dy = [0, dt, H - db, H];
    for (let r = 0; r < 3; r++)
      for (let k = 0; k < 3; k++) {
        const sw = sx[k + 1] - sx[k], sh = sy[r + 1] - sy[r], dw = dx[k + 1] - dx[k], dh = dy[r + 1] - dy[r];
        if (sw > 0 && sh > 0 && dw > 0 && dh > 0) ctx.drawImage(im, sx[k], sy[r], sw, sh, dx[k], dy[r], dw, dh);
      }
    if (tint) {
      const px = ctx.getImageData(0, 0, W, H);
      const d = px.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] *= tint.r;
        d[i + 1] *= tint.g;
        d[i + 2] *= tint.b;
      }
      ctx.putImageData(px, 0, 0);
    }
  }

  private renderText(): void {
    const t = this.text!;
    if (!this.textBox) {
      this.textBox = document.createElement('div');
      this.textBox.className = 'u-text';
      this.textSpan = document.createElement('span');
      this.textBox.append(this.textSpan);
      this.el.append(this.textBox);
    }
    const [ml, mt, mr, mb] = t.margin;
    const availW = Math.max(0, this.w - ml - mr);
    const availH = Math.max(0, this.h - mt - mb);
    const shown = t.upper ? t.text.toUpperCase() : t.text;
    const key = `${shown}|${availW.toFixed(2)}|${availH.toFixed(2)}`;
    if (key !== this.lastFit) {
      this.lastFit = key;
      this.fittedSize = t.autoSize ? this.fit((t.rich ? stripTmpTags(shown) : shown).replace(/\n+$/, ''), availW, availH) : t.fontSize;
      const b = this.textBox.style;
      b.left = `${ml}px`;
      b.top = `${mt}px`;
      b.right = `${mr}px`;
      b.bottom = `${mb}px`;
      b.justifyContent = t.alignV === 'top' ? 'flex-start' : t.alignV === 'bottom' ? 'flex-end' : 'center';
      b.textAlign = t.alignH === 'left' ? 'left' : t.alignH === 'right' ? 'right' : 'center';
      b.whiteSpace = t.wrap ? 'pre-line' : 'pre';
      b.fontFamily = t.family;
      b.fontWeight = t.bold ? '700' : '400';
      b.lineHeight = String(t.lineRatio);
      b.fontSize = `${this.fittedSize}px`;
      if (t.rich) this.textSpan!.innerHTML = tmpRichToHtml(shown.replace(/\n+$/, ''));
      else this.textSpan!.textContent = shown.replace(/\n+$/, '');
      if (t.ellipsis) {
        const sp = this.textSpan!.style;
        sp.overflow = 'hidden';
        sp.textOverflow = 'ellipsis';
        sp.maxWidth = '100%';
        const lines = Math.max(1, Math.floor((availH + 0.5) / (t.lineRatio * this.fittedSize)));
        if (t.wrap && lines > 1) {
          sp.display = '-webkit-box';
          sp.webkitBoxOrient = 'vertical';
          sp.webkitLineClamp = String(lines);
        } else sp.whiteSpace = t.wrap ? 'nowrap' : 'pre';
      }
    }
    const fold = this.fold();
    const c = fold !== null ? foldGrey(t.color, fold) : t.color;
    this.textBox.style.color = cssColor(c);
    if (t.underlay) {
      // NotoSans-Bold SDF_Stroke: underlay ON, dilate 1, offset 0 → a thin black rim behind the face.
      const u = fold !== null ? foldGrey(t.underlay, fold) : t.underlay;
      this.textBox.style.webkitTextStroke = `0.11em ${cssColor(u)}`;
      this.textBox.style.paintOrder = 'stroke fill';
    }
  }

  /** TMP auto-size: the largest size in [min, max] whose wrapped lines fit the rect (0.05 precision). */
  private fit(text: string, w: number, h: number): number {
    const t = this.text!;
    const fits = (s: number) => {
      const font = `${t.bold ? '700' : '400'} ${s}px ${t.family}`;
      const lines = wrapLines(text, w, font, t.wrap);
      return lines !== Infinity && lines * t.lineRatio * s <= h + 0.01;
    };
    if (fits(t.max)) return t.max;
    let lo = t.min;
    let hi = t.max;
    if (!fits(lo)) return lo;
    while (hi - lo > 0.05) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Forces a re-fit (fonts finished loading). */
  invalidateText(): void {
    this.lastFit = '';
    for (const c of this.children) c.invalidateText();
  }

  setText(text: string): void {
    if (!this.text || this.text.text === text) return;
    this.text.text = text;
    this.renderText();
  }

  setTextColor(c: RGBA): void {
    if (!this.text) return;
    this.text.color = c;
    this.renderText();
  }
}

// ---------------------------------------------------------------- building from unity-hud.json

export interface BuildOptions {
  /** Node names (not paths) to leave out entirely. */
  skip?: (n: NodeData) => boolean;
  /** Sprite / font / material tables for trees from other extractors (default: unity-hud.json's). */
  sprites?: Record<string, SpriteData>;
  fonts?: Record<string, FontData>;
  materials?: Record<string, MaterialData>;
  /** Called for every node built (after its children), with the data it came from (menu: attaches widgets). */
  onNode?: (n: UNode, d: NodeData) => void;
}

/** Builds the DOM tree for a node (authored values + the default SOLANA theme overrides). */
export function buildNode(d: NodeData, opts: BuildOptions = {}): UNode {
  const n = new UNode(d.name);
  const r = d.rect;
  if (r) {
    n.anchorMin = [...r.anchorMin];
    n.anchorMax = [...r.anchorMax];
    n.anchoredPosition = [...r.anchoredPosition];
    n.sizeDelta = [...r.sizeDelta];
    n.pivot = [...r.pivot];
    n.scale = [r.scale[0], r.scale[1]];
    n.rotation = r.euler[2] ?? 0;
  }
  const comp = d.components ?? {};
  if (comp.canvasGroup) n.groupAlpha = comp.canvasGroup.alpha;
  const im = comp.image;
  if (im && im.enabled !== false) {
    const th = d.themeDefault?.image;
    const spriteKey = th?.sprite ?? im.sprite;
    const sprite = spriteKey ? ((opts.sprites ?? data.sprites)[spriteKey] ?? null) : null;
    n.image = {
      sprite: sprite ?? (spriteKey ? { name: 'Background', ppu: 100, rect: [0, 0, 32, 32], border: [10, 10, 10, 10] } : null),
      type: th?.type ?? im.type,
      ppuM: th?.pixelsPerUnitMultiplier ?? im.pixelsPerUnitMultiplier ?? 1,
      color: rgba(th?.color ?? im.color),
      preserveAspect: !!im.preserveAspect,
      fillMethod: im.fillMethod ?? '',
      fillAmount: im.fillAmount ?? 1,
      fillOrigin: im.fillOrigin ?? 0,
      fillClockwise: im.fillClockwise ?? true,
    };
  }
  if (comp.mask?.enabled) n.maskWithGraphic = true;
  const tx = comp.text;
  if (tx && tx.enabled !== false) {
    const font = (opts.fonts ?? data.fonts)[tx.font];
    const fi = font?.faceInfo;
    const mat = tx.material ? (opts.materials ?? data.materials)[tx.material] : undefined;
    n.text = {
      text: tx.text,
      family: FONT_FAMILY[font?.name ?? ''] ?? "'UnityNotoSansBold'",
      lineRatio: fi ? (fi.ascentLine - fi.descentLine) / fi.pointSize : 1.362,
      fontSize: tx.fontSize,
      autoSize: tx.autoSize,
      min: tx.fontSizeMin,
      max: tx.fontSizeMax,
      bold: tx.fontStyle.includes('bold'),
      upper: tx.fontStyle.includes('uppercase'),
      color: rgba(d.themeDefault?.text?.color ?? tx.color),
      alignH: tx.alignH,
      alignV: tx.alignV,
      wrap: tx.wrapping,
      margin: tx.margin,
      underlay: mat?.underlay?.enabled ? rgba(mat.underlay.color) : null,
    };
  }
  // THEME HOOK: remember the pack-dependent overrides; a theme picked before this tree was built applies now.
  n.themeSlots = classifyThemeDefault(d.themeDefault, DEFAULT_THEME_KEYS);
  const activeTheme = getActiveHudTheme();
  if (n.themeSlots) {
    trackThemedNode(n);
    if (activeTheme) applyThemeSlots(n, activeTheme);
  }
  for (const c of d.children ?? []) {
    if (!c.rect) continue; // particle VFX transforms (not RectTransforms)
    if (opts.skip?.(c)) continue;
    n.add(buildNode(c, opts));
  }
  if (!d.active) {
    // Inactive at load: hidden, without firing OnDisable.
    (n as unknown as { activeSelfFlag: boolean }).activeSelfFlag = false;
    n.el.style.display = 'none';
  }
  opts.onNode?.(n, d);
  return n;
}

/** Waits for the TMP fonts, then re-fits every label under `roots` (auto-size measures with the real glyphs). */
export function whenFontsReady(roots: UNode[]): void {
  const fams = ["16px 'UnityNotoSansBold'", "16px 'UnityLiberationSans'"];
  void Promise.all(fams.map((f) => document.fonts.load(f))).then(() => {
    for (const r of roots) {
      r.invalidateText();
      r.layout();
    }
  });
}
