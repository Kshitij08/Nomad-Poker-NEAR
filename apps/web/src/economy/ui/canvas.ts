/**
 * The uGUI bits this module's screens need on top of hud/unityUi.ts: the economy-ui.json canvases (extracted by
 * tools/extract-economy-ui.mjs), a ScreenSpaceOverlay canvas with CanvasScaler (1920×1080, match 0.5), Button
 * ColorTint + clicks, a TMP input field, and builders for the panels FriendsHud / PlayFabLoginUI build in code
 * (RetentionUi.Label / Button / Create) so they render on the same canvas units.
 */
import economyData from '../../data/economy-ui.json';
import { HUD_DATA, buildNode, type NodeData, type RGBA, type SpriteData, type UNode as UNodeT } from '../../hud/unityUi';
import { UNode } from '../../hud/unityUi';
import { AvatarCatalog } from '../../core/social/avatarCatalog';
import type { AppContext } from '../../app/app';
import { PokerSound } from '../../core/orchestration/pokerSound';
import { portraitMenuLayout, portraitScaleFor } from '../../layout/portraitMenu';

interface ScalerData {
  mode: number;
  referenceResolution: [number, number];
  match: number;
}
interface CanvasEntry {
  name: string;
  scaler: ScalerData;
  sortingOrder?: number;
  root: NodeData;
}
type EconomyNodeData = NodeData & {
  components?: NodeData['components'] & {
    aspectRatioFitter?: { mode: string; ratio: number };
    rectMask2D?: { enabled: boolean };
  };
  children?: EconomyNodeData[];
};

const DATA = economyData as unknown as {
  canvases: Record<string, CanvasEntry>;
  resourceSprites: Record<string, string>;
  sprites: Record<string, SpriteData>;
  fonts: Record<string, unknown>;
  materials: Record<string, unknown>;
};

// Sprite / font keys are Unity guid[:fileID] — globally unique — so they merge into the shared HUD tables.
for (const [k, v] of Object.entries(DATA.sprites)) if (!HUD_DATA.sprites[k]) HUD_DATA.sprites[k] = v;
for (const [k, v] of Object.entries(DATA.fonts)) if (!HUD_DATA.fonts[k]) (HUD_DATA.fonts as Record<string, unknown>)[k] = v;
for (const [k, v] of Object.entries(DATA.materials)) if (!HUD_DATA.materials[k]) (HUD_DATA.materials as Record<string, unknown>)[k] = v;

export const DEFAULT_SCALER: ScalerData = { mode: 1, referenceResolution: [1920, 1080], match: 0.5 };

export const unityColor = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a });
export const WHITE = unityColor(1, 1, 1);
/** Game/Retention/RetentionUi.cs palette. */
export const RetentionUiColors = {
  Overlay: unityColor(0.02, 0.03, 0.05, 0.72),
  Panel: unityColor(0.09, 0.11, 0.16, 0.96),
  Gold: unityColor(0.95, 0.78, 0.32),
  Accent: unityColor(0.22, 0.55, 0.95),
  Muted: unityColor(1, 1, 1, 0.55),
  Reel: unityColor(0.06, 0.07, 0.1),
  SpinLabelDark: unityColor(0.18, 0.12, 0.04),
};
export const lerpColor = (a: RGBA, b: RGBA, t: number): RGBA => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t });

/** Builds an extracted economy canvas (an independent instance each call, like Instantiate). */
export function buildEconomyCanvas(key: string): { root: UNodeT; data: CanvasEntry; dataOf: (n: UNodeT) => EconomyNodeData | undefined } {
  const data = DATA.canvases[key];
  if (!data) throw new Error(`[economy] no canvas '${key}' in economy-ui.json`);
  const map = new WeakMap<UNodeT, EconomyNodeData>();
  const root = buildNode(data.root, {
    onNode: (n, d) => {
      map.set(n, d as EconomyNodeData);
      if ((d as EconomyNodeData).components?.rectMask2D?.enabled) n.el.style.overflow = 'hidden';
    },
  });
  return { root, data, dataOf: (n) => map.get(n) };
}

export function resourceSprite(path: string): SpriteData | null {
  const key = DATA.resourceSprites[path];
  return key ? (HUD_DATA.sprites[key] ?? null) : null;
}

/** AvatarLibrary.For(avatar, name): the Pro_Pic sprite (HUD extractor's AvatarLibrary table). */
export function avatarSprite(avatar: number, name: string | null): SpriteData | null {
  const value = AvatarCatalog.resolve(avatar, name);
  const entry = (HUD_DATA as unknown as { avatars?: { entries: { value: number; sprite: string }[] } }).avatars?.entries.find((e) => e.value === value);
  return entry ? (HUD_DATA.sprites[entry.sprite] ?? null) : null;
}

// ---------------------------------------------------------------- overlay canvas

export function scaleFactor(s: ScalerData, w: number, h: number): number {
  const [rw, rh] = s.referenceResolution;
  if (s.mode !== 1) return 1;
  const portrait = portraitScaleFor(s.referenceResolution, w, h); // layout/portraitMenu.ts
  if (portrait !== null) return portrait;
  return Math.pow(2, (1 - s.match) * Math.log2(w / rw) + s.match * Math.log2(h / rh));
}

/** A ScreenSpaceOverlay canvas: root sized to screen / scaleFactor and scaled back up by one CSS transform. */
export class OverlayCanvas {
  readonly host = document.createElement('div');
  private readonly ro: ResizeObserver;
  private readonly before: (() => void)[] = [];
  scale = 1;

  constructor(parent: HTMLElement, readonly root: UNodeT, readonly scaler: ScalerData = DEFAULT_SCALER, sortingOrder = 0) {
    this.host.className = 'econ-canvas';
    this.host.style.zIndex = String(sortingOrder);
    this.host.append(root.el);
    parent.append(this.host);
    root.el.style.transformOrigin = '0 0';
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.host);
    this.layout();
  }

  /** Runs between the size pass and the final layout (code-driven layout groups, AspectRatioFitters). */
  onBeforeLayout(fn: () => void): void {
    this.before.push(fn);
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
    r.sizeDelta = [w / s, h / s];
    r.renderScale = s;
    portraitMenuLayout(r, 'panels'); // portrait: centred panels fill the 1080 column (layout/portraitMenu.ts)
    r.layout();
    for (const fn of this.before) fn();
    r.layout();
    r.el.style.transform = `scale(${s})`;
  }

  dispose(): void {
    this.ro.disconnect();
    this.host.remove();
  }
}

/** UnityEngine.UI.AspectRatioFitter (EnvelopeParent / FitInParent). */
export function applyAspectFitter(n: UNodeT, mode: string, ratio: number): void {
  const p = n.parent;
  if (!p || !(ratio > 0) || (mode !== 'EnvelopeParent' && mode !== 'FitInParent')) return;
  let w = p.w;
  let h = p.w / ratio;
  if (mode === 'EnvelopeParent' ? h < p.h : h > p.h) {
    h = p.h;
    w = p.h * ratio;
  }
  n.anchorMin = [0.5, 0.5];
  n.anchorMax = [0.5, 0.5];
  n.anchoredPosition = [0, 0];
  n.sizeDelta = [w, h];
}

// ---------------------------------------------------------------- buttons

export interface ButtonColors {
  normal: RGBA;
  highlighted: RGBA;
  pressed: RGBA;
  disabled: RGBA;
}
/** uGUI's default ColorBlock. */
export const DefaultColors: ButtonColors = {
  normal: WHITE,
  highlighted: unityColor(0.9608, 0.9608, 0.9608),
  pressed: unityColor(0.7843, 0.7843, 0.7843),
  disabled: unityColor(0.7843, 0.7843, 0.7843, 0.502),
};

export interface UiButton {
  readonly node: UNodeT;
  interactable: boolean;
  setInteractable(v: boolean): void;
  dispose(): void;
}

/** uGUI Button: ColorTint on the target graphic, click (+ PokerAudio.AssignButton sound). */
export function wireButton(ctx: AppContext | null, node: UNodeT | null, onClick: () => void, colors: ButtonColors = DefaultColors, sound: PokerSound | null = PokerSound.ButtonGeneric): UiButton | null {
  if (!node) return null;
  let hover = false;
  let down = false;
  const el = node.el;
  el.classList.add('econ-hit');
  const paint = () => {
    if (node.image) {
      node.imageTint = !b.interactable ? colors.disabled : down ? colors.pressed : hover ? colors.highlighted : colors.normal;
      node.render();
    }
    el.classList.toggle('econ-disabled', !b.interactable);
  };
  const enter = () => ((hover = true), paint());
  const leave = () => ((hover = false), (down = false), paint());
  const press = () => ((down = true), paint());
  const release = () => ((down = false), paint());
  const click = (e: Event) => {
    e.stopPropagation();
    if (!b.interactable) return;
    if (sound !== null) ctx?.audio.play(sound);
    onClick();
  };
  el.addEventListener('pointerenter', enter);
  el.addEventListener('pointerleave', leave);
  el.addEventListener('pointerdown', press);
  el.addEventListener('pointerup', release);
  el.addEventListener('click', click);
  const b: UiButton = {
    node,
    interactable: true,
    setInteractable(v) {
      b.interactable = v;
      paint();
    },
    dispose() {
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerdown', press);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('click', click);
    },
  };
  paint();
  return b;
}

// ---------------------------------------------------------------- input fields

/** A TMP_InputField: a real <input> laid over the field's text area, styled like its Text child; Placeholder hidden while typing. */
export function attachInput(field: UNodeT, opts: { textPath?: string; placeholderPath?: string; type?: string; maxLength?: number; onSubmit?: () => void } = {}): HTMLInputElement {
  const area = field.find(opts.textPath ?? 'Text Area/Text') ?? field;
  const ph = field.find(opts.placeholderPath ?? 'Text Area/Placeholder');
  const input = document.createElement('input');
  input.className = 'econ-input';
  input.type = opts.type ?? 'text';
  if (opts.maxLength) input.maxLength = opts.maxLength;
  input.spellcheck = false;
  input.autocomplete = 'off';
  const t = area.text;
  if (t) {
    input.style.fontFamily = t.family;
    input.style.fontSize = `${t.fontSize}px`;
    input.style.color = `rgba(${Math.round(t.color.r * 255)},${Math.round(t.color.g * 255)},${Math.round(t.color.b * 255)},${t.color.a})`;
    input.style.textAlign = t.alignH === 'center' ? 'center' : t.alignH === 'right' ? 'right' : 'left';
    area.setText('');
  }
  const sync = () => ph?.setActive(input.value.length === 0);
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') opts.onSubmit?.();
    e.stopPropagation();
  });
  area.el.append(input);
  sync();
  return input;
}

// ---------------------------------------------------------------- runtime-built nodes (RetentionUi.Create / Label / Button)

const LIBERATION_LINE = (77.853516 + 18.22461) / 86;

export interface NodeSpec {
  anchorMin?: [number, number];
  anchorMax?: [number, number];
  pivot?: [number, number];
  pos?: [number, number];
  size?: [number, number];
}

export function makeNode(name: string, spec: NodeSpec = {}): UNodeT {
  const n = new UNode(name);
  n.anchorMin = spec.anchorMin ?? [0.5, 0.5];
  n.anchorMax = spec.anchorMax ?? [0.5, 0.5];
  n.pivot = spec.pivot ?? [0.5, 0.5];
  n.anchoredPosition = spec.pos ?? [0, 0];
  n.sizeDelta = spec.size ?? [100, 100];
  return n;
}

/** Top-left placement inside a parent of known size (what a layout group computes): x, y from the top-left. */
export function place(n: UNodeT, x: number, y: number, w: number, h: number): UNodeT {
  n.anchorMin = [0, 1];
  n.anchorMax = [0, 1];
  n.pivot = [0, 1];
  n.anchoredPosition = [x, -y];
  n.sizeDelta = [w, h];
  return n;
}

export function stretch(n: UNodeT, l = 0, b = 0, r = 0, t = 0): UNodeT {
  n.anchorMin = [0, 0];
  n.anchorMax = [1, 1];
  n.pivot = [0.5, 0.5];
  n.anchoredPosition = [(l - r) / 2, (b - t) / 2];
  n.sizeDelta = [-(l + r), -(b + t)];
  return n;
}

export function setImage(n: UNodeT, color: RGBA, sprite: SpriteData | null = null, type = 'Simple', preserveAspect = false): UNodeT {
  n.image = { sprite, type, ppuM: 1, color, preserveAspect, fillMethod: '', fillAmount: 1, fillOrigin: 0, fillClockwise: true };
  return n;
}

/** RetentionUi.Label: TMP, word wrap, Ellipsis overflow; LiberationSans SDF (TMP's default font asset). */
export function setLabel(n: UNodeT, text: string, size: number, color: RGBA, opts: { bold?: boolean; italic?: boolean; alignH?: string; alignV?: string; rich?: boolean; wrap?: boolean } = {}): UNodeT {
  n.text = {
    text, family: "'UnityLiberationSans'", lineRatio: LIBERATION_LINE, fontSize: size, autoSize: false, min: size, max: size,
    bold: !!opts.bold, upper: false, color, alignH: opts.alignH ?? 'center', alignV: opts.alignV ?? 'middle', wrap: opts.wrap ?? true,
    margin: [0, 0, 0, 0], underlay: null, rich: opts.rich ?? false, ellipsis: true,
  };
  if (opts.italic) n.el.style.fontStyle = 'italic';
  return n;
}

/** RetentionUi.Button colours: highlighted = Lerp(color, white, .18), pressed = Lerp(color, black, .2) (as tints). */
export function retentionButtonColors(color: RGBA): ButtonColors {
  return {
    normal: WHITE,
    highlighted: lerpColor(color, WHITE, 0.18),
    pressed: lerpColor(color, unityColor(0, 0, 0), 0.2),
    disabled: unityColor(0.35, 0.35, 0.38, 0.7),
  };
}

/** RetentionUi.Button: a coloured quad with a bold 20 px white caption (stretched). */
export function makeButton(ctx: AppContext | null, name: string, caption: string, color: RGBA, onClick: () => void, opts: { fontSize?: number; labelColor?: RGBA; sound?: PokerSound | null } = {}): { node: UNodeT; label: UNodeT; button: UiButton } {
  const node = setImage(makeNode(name), color);
  const label = setLabel(stretch(makeNode('Label')), caption, opts.fontSize ?? 20, opts.labelColor ?? WHITE, { bold: true });
  node.add(label);
  const button = wireButton(ctx, node, onClick, retentionButtonColors(color), opts.sound === undefined ? PokerSound.ButtonGeneric : opts.sound)!;
  return { node, label, button };
}

/** Player names go into rich-text labels: swap angle brackets for look-alikes (FriendsHud.Clean). */
export const clean = (text: string | null | undefined): string => (text ? text.replace(/</g, '‹').replace(/>/g, '›') : '');
