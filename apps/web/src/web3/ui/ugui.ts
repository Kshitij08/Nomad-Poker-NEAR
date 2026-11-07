/**
 * The pieces of uGUI the extracted web3 dialogs need on top of src/hud/unityUi.ts (which does plain RectTransform
 * layout, Image and TMP): a screen-space canvas root (CanvasScaler ScaleWithScreenSize, switched to Expand by
 * NomadCanvasFit), Horizontal/VerticalLayoutGroup + ContentSizeFitter as Unity computes them
 * (HorizontalOrVerticalLayoutGroup.SetChildrenAlongAxis), and Selectable transitions (ColorTint, or an Animator
 * driven by the Button's trigger names).
 */
import { ticker, type Tween, Ease } from '../../anim/tween';
import { whenFontsReady, type NodeData, type RGBA, type UNode } from '../../hud/unityUi';
import { portraitMenuLayout } from '../../layout/portraitMenu';

export type Vec2 = [number, number];

/** CanvasScaler ScaleWithScreenSize 1920×1080 in Expand mode (NomadCanvasFit): min(w/1920, h/1080). */
export const expandScale = (w: number, h: number, ref: Vec2 = [1920, 1080]): number => Math.min(w / ref[0], h / ref[1]);

let styled = false;
/** The u-node base styles, scoped to the web3 canvases (each module scopes its own; the HUD's are under #hud). */
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = `
.w3-ucanvas,.w3-ucanvas .u-node{position:absolute;box-sizing:border-box;pointer-events:none}
.w3-ucanvas .u-gfx{position:absolute;inset:0;box-sizing:border-box;background-repeat:no-repeat;pointer-events:none;mask-size:100% 100%;-webkit-mask-size:100% 100%}
.w3-ucanvas .u-text{position:absolute;display:flex;flex-direction:column;overflow:visible;pointer-events:none;font-kerning:normal}
.w3-ucanvas .u-text>span{display:block}
.w3-ucanvas .u-slice{position:absolute;inset:0;width:100%;height:100%;display:block}
.w3-ucanvas .w3-hit{pointer-events:auto}
`;
  document.head.append(s);
}

/** A screen-space canvas: `root` (a built UNode) fills `host`, laid out in canvas units, scaled by one transform. */
export class UCanvas {
  scale = 1;
  private readonly onResize = () => this.layout();
  /** Runs after every RectTransform pass (layout groups need the new parent sizes). */
  afterLayout: (() => void) | null = null;

  constructor(
    readonly host: HTMLElement,
    readonly root: UNode,
  ) {
    root.anchorMin = [0, 0];
    root.anchorMax = [1, 1];
    root.scale = [1, 1];
    root.el.style.position = 'absolute';
    root.el.style.transformOrigin = '0 0';
    root.el.classList.add('w3-ucanvas');
    injectStyle();
    host.append(root.el);
    window.addEventListener('resize', this.onResize);
    this.layout();
    whenFontsReady([root]);
  }

  layout(): void {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    const s = (this.scale = expandScale(w, h));
    this.root.sizeDelta = [w / s, h / s];
    this.root.renderScale = s;
    portraitMenuLayout(this.root, 'panels'); // portrait: centred panels fill the 1080 column (layout/portraitMenu.ts)
    this.root.layout();
    this.root.el.style.left = '0px';
    this.root.el.style.top = '0px';
    this.root.el.style.transform = `scale(${s})`;
    this.afterLayout?.();
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.root.el.remove();
  }
}

// ---------------------------------------------------------------- layout groups

interface LayoutGroupData {
  kind: string;
  enabled: boolean;
  padding: { left: number; right: number; top: number; bottom: number };
  spacing: number;
  childAlignment: string;
  controlW: boolean;
  controlH: boolean;
  expandW: boolean;
  expandH: boolean;
}
interface LayoutElementData {
  ignoreLayout: boolean;
  minWidth: number;
  minHeight: number;
  preferredWidth: number;
  preferredHeight: number;
  flexibleWidth: number;
  flexibleHeight: number;
}
interface Extra {
  layoutGroup?: LayoutGroupData;
  layoutElement?: LayoutElementData;
  contentSizeFitter?: { horizontal: string; vertical: string };
}
const extra = (d: NodeData | undefined): Extra => (d?.components ?? {}) as unknown as Extra;

/** Pairs every built UNode with its data (buildNode skips rect-less children). */
export function pairNodes(n: UNode, d: NodeData, out = new Map<UNode, NodeData>()): Map<UNode, NodeData> {
  out.set(n, d);
  const kids = (d.children ?? []).filter((c) => c.rect);
  n.children.forEach((child, i) => {
    const cd = kids[i];
    if (cd && cd.name === child.name) pairNodes(child, cd, out);
  });
  return out;
}

/** TextAnchor → alignment on an axis (0 left/top … 1 right/bottom). */
function alignOn(anchor: string, axis: 0 | 1): number {
  if (axis === 0) return anchor.endsWith('Left') ? 0 : anchor.endsWith('Right') ? 1 : 0.5;
  return anchor.startsWith('Upper') ? 0 : anchor.startsWith('Lower') ? 1 : 0.5;
}

/** ILayoutElement sizes of a child along an axis: its LayoutElement, else 0 (the dialogs here have no TMP/Image-sized children under a controlling group). */
function childSizes(c: UNode, d: NodeData | undefined, axis: 0 | 1, control: boolean, expand: boolean): { min: number; pref: number; flex: number } {
  let min: number, pref: number, flex: number;
  if (!control) {
    min = pref = c.sizeDelta[axis];
    flex = 0;
  } else {
    const le = extra(d).layoutElement;
    const pick = (v: number | undefined) => (v !== undefined && v >= 0 ? v : -1);
    min = Math.max(0, pick(axis === 0 ? le?.minWidth : le?.minHeight));
    pref = Math.max(min, pick(axis === 0 ? le?.preferredWidth : le?.preferredHeight));
    flex = Math.max(0, pick(axis === 0 ? le?.flexibleWidth : le?.flexibleHeight));
  }
  if (expand) flex = Math.max(flex, 1);
  return { min, pref, flex };
}

/** SetChildAlongAxis: anchors to the top-left corner, position (and size) along one axis. */
function setAlong(c: UNode, axis: 0 | 1, pos: number, size?: number): void {
  c.anchorMin = [0, 1];
  c.anchorMax = [0, 1];
  const s = size ?? c.sizeDelta[axis];
  if (size !== undefined) c.sizeDelta[axis] = size;
  if (axis === 0) c.anchoredPosition[0] = pos + s * c.pivot[0];
  else c.anchoredPosition[1] = -pos - s * (1 - c.pivot[1]);
}

/** The group's preferred size along an axis (for ContentSizeFitter PreferredSize). */
function preferred(n: UNode, g: LayoutGroupData, pairs: Map<UNode, NodeData>, axis: 0 | 1): number {
  const vertical = g.kind === 'VerticalLayoutGroup';
  const along = (axis === 1) === vertical;
  const control = axis === 0 ? g.controlW : g.controlH;
  const expand = axis === 0 ? g.expandW : g.expandH;
  const kids = n.children.filter((c) => c.activeSelf && !extra(pairs.get(c)).layoutElement?.ignoreLayout);
  const pad = axis === 0 ? g.padding.left + g.padding.right : g.padding.top + g.padding.bottom;
  let total = 0;
  for (const c of kids) {
    const p = childSizes(c, pairs.get(c), axis, control, expand).pref;
    total = along ? total + p : Math.max(total, p);
  }
  if (along) total += g.spacing * Math.max(0, kids.length - 1);
  return total + pad;
}

function layoutAxis(n: UNode, g: LayoutGroupData, pairs: Map<UNode, NodeData>, axis: 0 | 1): void {
  const vertical = g.kind === 'VerticalLayoutGroup';
  const along = (axis === 1) === vertical;
  const control = axis === 0 ? g.controlW : g.controlH;
  const expand = axis === 0 ? g.expandW : g.expandH;
  const size = axis === 0 ? n.w : n.h;
  const padStart = axis === 0 ? g.padding.left : g.padding.top;
  const padSum = axis === 0 ? g.padding.left + g.padding.right : g.padding.top + g.padding.bottom;
  const alignment = alignOn(g.childAlignment, axis);
  let kids = n.children.filter((c) => c.activeSelf && !extra(pairs.get(c)).layoutElement?.ignoreLayout);
  if (g.kind && (g as { reverse?: boolean }).reverse) kids = kids.reverse();
  const sizes = kids.map((c) => childSizes(c, pairs.get(c), axis, control, expand));
  const startOffset = (required: number) => padStart + (size - (required + padSum)) * alignment;
  if (!along) {
    const inner = size - padSum;
    kids.forEach((c, i) => {
      const z = sizes[i]!;
      const required = Math.min(Math.max(inner, z.min), z.flex > 0 ? size : z.pref);
      if (control) setAlong(c, axis, startOffset(required), required);
      else setAlong(c, axis, startOffset(required) + (required - c.sizeDelta[axis]) * alignment);
    });
    return;
  }
  const totalMin = sizes.reduce((s, z) => s + z.min, 0) + g.spacing * Math.max(0, kids.length - 1) + padSum;
  const totalPref = sizes.reduce((s, z) => s + z.pref, 0) + g.spacing * Math.max(0, kids.length - 1) + padSum;
  const totalFlex = sizes.reduce((s, z) => s + z.flex, 0);
  let pos = padStart;
  let flexMul = 0;
  const surplus = size - totalPref;
  if (surplus > 0) {
    if (totalFlex === 0) pos = startOffset(totalPref - padSum);
    else flexMul = surplus / totalFlex;
  }
  const lerp = totalMin !== totalPref ? Math.min(1, Math.max(0, (size - totalMin) / (totalPref - totalMin))) : 0;
  kids.forEach((c, i) => {
    const z = sizes[i]!;
    const childSize = z.min + (z.pref - z.min) * lerp + z.flex * flexMul;
    if (control) setAlong(c, axis, pos, childSize);
    else setAlong(c, axis, pos + (childSize - c.sizeDelta[axis]) * alignment);
    pos += childSize + g.spacing;
  });
}

/**
 * Runs the layout groups and content size fitters under `root`, parents first (so a nested group sees its final
 * size), re-laying out each group's subtree. Call after `root.layout()`.
 */
export function applyLayoutGroups(root: UNode, pairs: Map<UNode, NodeData>): void {
  const visit = (n: UNode) => {
    if (!n.activeSelf) return;
    const ex = extra(pairs.get(n));
    const g = ex.layoutGroup;
    if (g?.enabled) {
      const fit = ex.contentSizeFitter;
      if (fit && n.parent) {
        // ContentSizeFitter.SetLayoutVertical/Horizontal: size with the current anchors.
        for (const axis of [0, 1] as const) {
          if ((axis === 0 ? fit.horizontal : fit.vertical) !== 'PreferredSize') continue;
          const want = preferred(n, g, pairs, axis);
          const parentSize = axis === 0 ? n.parent.w : n.parent.h;
          n.sizeDelta[axis] = want - (n.anchorMax[axis] - n.anchorMin[axis]) * parentSize;
        }
        n.layout();
      }
      layoutAxis(n, g, pairs, 0);
      layoutAxis(n, g, pairs, 1);
      n.layout();
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
}

// ---------------------------------------------------------------- selectables

export type SelState = 'Normal' | 'Highlighted' | 'Pressed' | 'Selected' | 'Disabled';

/** Applies a state to the button's graphics (`instant`: no fade, e.g. the first paint). */
export type Transition = (state: SelState, instant: boolean) => void;

const mulRgb = (c: RGBA, k: RGBA): RGBA => ({ r: c.r * k.r, g: c.g * k.g, b: c.b * k.b, a: c.a * k.a });

/** Selectable ColorTint: Image colour × the state's ColorBlock colour (× multiplier), faded over fadeDuration. */
export function colorTint(target: UNode, colors: { normal: RGBA; highlighted: RGBA; pressed: RGBA; selected: RGBA; disabled: RGBA; fade: number; multiplier?: number }): Transition {
  let tween: Tween | null = null;
  return (state, instant) => {
    const k = { Normal: colors.normal, Highlighted: colors.highlighted, Pressed: colors.pressed, Selected: colors.selected, Disabled: colors.disabled }[state];
    const m = colors.multiplier ?? 1;
    const to = { r: Math.min(1, k.r * m), g: Math.min(1, k.g * m), b: Math.min(1, k.b * m), a: Math.min(1, k.a * m) };
    tween?.kill();
    const from = { ...target.imageTint };
    if (instant || colors.fade <= 0) {
      target.imageTint = to;
      target.render();
      return;
    }
    tween = ticker.to(colors.fade, (p) => {
      target.imageTint = { r: from.r + (to.r - from.r) * p, g: from.g + (to.g - from.g) * p, b: from.b + (to.b - from.b) * p, a: from.a + (to.a - from.a) * p };
      target.render();
    }, Ease.Linear);
  };
}

/** UI_Button.controller (table HUD buttons): each state's clip sets the plate's RGB; Pressed's clip is empty. */
export function uiButtonAnimator(target: UNode, rgb: Record<SelState, number | null>, fade: Record<SelState, number>): Transition {
  let tween: Tween | null = null;
  return (state, instant) => {
    const base = target.image?.color ?? { r: 1, g: 1, b: 1, a: 1 };
    const v = rgb[state];
    const to = v === null ? base : { r: v, g: v, b: v, a: base.a };
    const from = target.imageColorOverride ?? base;
    tween?.kill();
    const set = (c: RGBA) => {
      target.imageColorOverride = c;
      target.render();
    };
    if (instant) return set(to);
    tween = ticker.to(fade[state], (p) => set({ r: from.r + (to.r - from.r) * p, g: from.g + (to.g - from.g) * p, b: from.b + (to.b - from.b) * p, a: from.a + (to.a - from.a) * p }), Ease.Linear);
  };
}

/** An Animator state that scales the button (the SDK's Button-Action: Pressed punches 1 → 0.9 → 1.2/1.5 → 1 in 0.25 s). */
export function scalePunch(target: UNode, keys: { t: number; x: number; y: number }[], onFrame: () => void): Transition {
  let tween: Tween | null = null;
  const len = keys.at(-1)?.t ?? 0;
  return (state, instant) => {
    if (state !== 'Pressed' || instant || len <= 0) return;
    tween?.kill();
    tween = ticker.to(len, (p) => {
      const t = p * len;
      let i = 0;
      while (i < keys.length - 2 && keys[i + 1]!.t < t) i++;
      const a = keys[i]!, b = keys[i + 1] ?? a;
      const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 1;
      target.scale = [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f];
      onFrame();
    }, Ease.Linear);
  };
}

/** A Button: pointer states → transition; onClick when released over it (EventSystem keeps it "Selected" after). */
export class UButton {
  private on = true;
  private hover = false;
  private down = false;
  private selected = false;
  private state: SelState | null = null;
  onClick: (() => void) | null = null;
  private readonly offDoc: () => void;

  constructor(
    readonly node: UNode,
    private readonly transition: Transition,
  ) {
    const el = node.el;
    el.style.cursor = 'pointer';
    el.style.pointerEvents = 'auto';
    el.addEventListener('pointerenter', () => ((this.hover = true), this.refresh()));
    el.addEventListener('pointerleave', () => ((this.hover = false), (this.down = false), this.refresh()));
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.on) return;
      this.down = true;
      this.refresh();
    });
    el.addEventListener('pointerup', () => ((this.down = false), this.refresh()));
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.on || !this.node.activeInHierarchy) return;
      this.selected = true;
      this.refresh();
      this.onClick?.();
    });
    const docDown = (e: PointerEvent) => {
      if (this.selected && !el.contains(e.target as Node)) {
        this.selected = false;
        this.refresh();
      }
    };
    document.addEventListener('pointerdown', docDown, true);
    this.offDoc = () => document.removeEventListener('pointerdown', docDown, true);
    this.refresh(true);
  }

  set interactable(v: boolean) {
    this.on = v;
    this.node.el.style.cursor = v ? 'pointer' : 'default';
    this.refresh();
  }

  /** EventSystem.SetSelectedGameObject(null). */
  deselect(): void {
    this.selected = false;
    this.refresh();
  }

  private refresh(instant = false): void {
    const s: SelState = !this.on ? 'Disabled' : this.down ? 'Pressed' : this.hover ? 'Highlighted' : this.selected ? 'Selected' : 'Normal';
    if (s === this.state && !instant) return;
    this.state = s;
    this.transition(s, instant);
  }

  dispose(): void {
    this.offDoc();
  }
}

export const rgbaOf = (c: { rgba: [number, number, number, number] } | null | undefined, f: RGBA = { r: 1, g: 1, b: 1, a: 1 }): RGBA =>
  c ? { r: c.rgba[0], g: c.rgba[1], b: c.rgba[2], a: c.rgba[3] } : f;
export { mulRgb };
