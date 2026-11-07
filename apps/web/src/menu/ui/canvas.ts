/**
 * Screen-space canvases for the menu: a root UNode sized by Unity's CanvasScaler and mapped to the viewport with one
 * CSS scale, plus helpers to make nodes at runtime (NomadDialogs.NewImage / NewText, RectTransform offsets) the way
 * the C# builds its dialogs and covers.
 */
import { UNode, whenFontsReady, type RGBA } from '../../hud/unityUi';
import { MENU_DATA, nodeDataAt, type MenuComponents, type MenuNodeData } from '../data';
import { buildTree, runLayout, type TreeEnv } from './tree';
import { PokerSound } from '../../core';

export type Vec2 = [number, number];

/**
 * CanvasScaler ScaleWithScreenSize at 1920×1080. NomadCanvasFit switches every such canvas to Expand: scale by
 * height on wide screens, by width on tall ones, so the whole reference layout stays on screen.
 */
export function expandScale(w: number, h: number, ref: Vec2 = [1920, 1080]): number {
  return Math.min(w / ref[0], h / ref[1]);
}

/** A full-viewport canvas root inside `host` (an element covering the viewport). */
export class ScreenCanvas {
  readonly root: UNode;
  scale = 1;
  private readonly onResize = () => this.layout();
  /** Also follows the host's own size (container changes, orientation, emulated viewports that skip 'resize'). */
  private readonly observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.layout()) : null;

  constructor(
    readonly host: HTMLElement,
    root: UNode,
    private readonly ref: Vec2 = [1920, 1080],
  ) {
    this.root = root;
    root.el.classList.add('nm-canvas');
    // Screen roots stretch over the canvas (their authored anchors are 0..1 with zero offsets).
    root.anchorMin = [0, 0];
    root.anchorMax = [1, 1];
    host.append(root.el);
    window.addEventListener('resize', this.onResize);
    this.observer?.observe(host);
    this.layout();
    whenFontsReady([root]);
  }

  layout(): void {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    const s = (this.scale = expandScale(w, h, this.ref));
    this.root.sizeDelta = [w / s, h / s];
    this.root.renderScale = s;
    this.root.el.style.transform = `scale(${s})`;
    this.root.layout();
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.observer?.disconnect();
    this.root.el.remove();
  }
}

// ---------------------------------------------------------------- runtime nodes

let synthId = 0;

/** NomadDialogs' font: the Login header title's TMP font (NotoSans-Bold SDF). */
const DIALOG_FONT = (() => {
  const t = nodeDataAt('Login/Panel/Header/Title')?.components?.text as (MenuComponents['text'] & { font?: string }) | undefined;
  return t?.font ?? Object.keys(MENU_DATA.fonts)[0] ?? '';
})();

const colorData = (c: RGBA) => ({ hex: '', rgba: [c.r, c.g, c.b, c.a] as [number, number, number, number] });

export interface SynthOptions {
  rect?: Partial<NonNullable<MenuNodeData['rect']>>;
  components?: MenuComponents;
  children?: MenuNodeData[];
  active?: boolean;
}

/** Authored-style node data for a node made at runtime (new GameObject + RectTransform). */
export function synth(name: string, o: SynthOptions = {}): MenuNodeData {
  const path = `__rt${synthId++}/${name}`;
  return {
    name,
    path,
    active: o.active ?? true,
    rect: { anchorMin: [0.5, 0.5], anchorMax: [0.5, 0.5], anchoredPosition: [0, 0], sizeDelta: [100, 100], pivot: [0.5, 0.5], euler: [0, 0, 0], scale: [1, 1, 1], ...o.rect },
    components: o.components,
    children: o.children,
  } as MenuNodeData;
}

export function imageComp(color: RGBA, sprite: string | null = null, type = 'Simple', ppu = 1, raycast = true): NonNullable<MenuComponents['image']> {
  return { enabled: true, sprite, color: colorData(color), type, raycastTarget: raycast, preserveAspect: false, pixelsPerUnitMultiplier: ppu } as NonNullable<MenuComponents['image']>;
}

export function textComp(text: string, size: number, bold: boolean, color: RGBA = { r: 1, g: 1, b: 1, a: 1 }, alignH = 'center'): NonNullable<MenuComponents['text']> {
  return {
    enabled: true, text, font: DIALOG_FONT, material: null, fontSize: size, autoSize: false, fontSizeMin: size, fontSizeMax: size,
    fontStyle: bold ? ['bold'] : [], color: colorData(color), alignH, alignV: 'middle', wrapping: true, overflow: 'Overflow',
    margin: [0, 0, 0, 0], richText: true, raycastTarget: false,
  } as unknown as NonNullable<MenuComponents['text']>;
}

const NO_SOUND_ENV: TreeEnv = { playSound: () => undefined };
let defaultEnv: TreeEnv = NO_SOUND_ENV;
/** The env (click sounds, persistent calls) runtime-built nodes use; the host sets it once. */
export function setRuntimeEnv(env: TreeEnv): void {
  defaultEnv = env;
}
export function runtimeEnv(): TreeEnv {
  return defaultEnv;
}
export const ButtonSound = PokerSound.ButtonGeneric;

/** Builds runtime node data under `parent` (or detached when parent is null). */
export function make(parent: UNode | null, d: MenuNodeData, index?: number): UNode {
  const n = buildTree(d, defaultEnv, true);
  if (parent) {
    parent.add(n, index);
    if (parent.activeInHierarchy && parent.w > 0) n.layout();
  }
  return n;
}

/** NomadDialogs.NewImage: an Image of this colour (raycast target on, like a new uGUI Image). */
export function newImage(parent: UNode | null, name: string, color: RGBA, size: Vec2 = [100, 100]): UNode {
  return make(parent, synth(name, { rect: { sizeDelta: size }, components: { image: imageComp(color) } }));
}

/** NomadDialogs.NewText: TMP label, centred, wrapping, white, the dialogs' font. */
export function newText(parent: UNode | null, name: string, text: string, size: number, bold: boolean, pos: Vec2, box: Vec2): UNode {
  return make(parent, synth(name, { rect: { anchoredPosition: pos, sizeDelta: box }, components: { text: textComp(text, size, bold) } }));
}

/** RectTransform.offsetMin / offsetMax for the node's current anchors and pivot. */
export function setOffsets(n: UNode, min: Vec2, max: Vec2): void {
  const sd: Vec2 = [max[0] - min[0], max[1] - min[1]];
  n.sizeDelta = sd;
  n.anchoredPosition = [min[0] + sd[0] * n.pivot[0], min[1] + sd[1] * n.pivot[1]];
}

/** anchorMin 0, anchorMax 1, zero offsets. */
export function stretch(n: UNode, inset = 0): void {
  n.anchorMin = [0, 0];
  n.anchorMax = [1, 1];
  setOffsets(n, [inset, inset], [-inset, -inset]);
}

/** Destroy(go): removes a node from its parent. */
export function destroy(n: UNode): void {
  const p = n.parent;
  if (p) {
    const i = p.children.indexOf(n);
    if (i >= 0) p.children.splice(i, 1);
  }
  n.parent = null;
  n.el.remove();
}

/** Instantiate(template, parent): a fresh build of the template's authored data (runtime edits are not copied). */
export function instantiate(template: UNode, data: MenuNodeData, parent: UNode, index?: number): UNode {
  const n = make(parent, data, index);
  if (!template.activeSelf) n.setActive(false);
  else if (!n.activeSelf) n.setActive(true);
  return n;
}

/** Re-runs the layout groups from `n` upwards (a list's rows changed). */
export function relayoutUp(n: UNode | null): void {
  if (!n) return;
  runLayout(n);
}
