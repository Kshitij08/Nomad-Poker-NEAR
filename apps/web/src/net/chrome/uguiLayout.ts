/**
 * The bits of uGUI's auto-layout the table chrome needs (the HUD's UNode does plain RectTransform layout only):
 * Vertical/HorizontalLayoutGroup with LayoutElement sizes and child-force-expand, and GridLayoutGroup with a fixed
 * column count. Applied once after building a subtree from unity-hud.json, then UNode.layout() positions everything.
 * Simplified from Unity's LayoutUtility (no text preferred sizes — rows that size to text are drawn as DOM).
 */
import type { NodeData, UNode } from '../../hud/unityUi';

interface LayoutGroupData {
  kind: 'VerticalLayoutGroup' | 'HorizontalLayoutGroup' | 'GridLayoutGroup';
  enabled: boolean;
  padding: { left: number; right: number; top: number; bottom: number };
  spacing: number | [number, number];
  childAlignment: string;
  controlW: boolean;
  controlH: boolean;
  expandW: boolean;
  expandH: boolean;
  cellSize?: [number, number];
  constraint?: string;
  constraintCount?: string;
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

const comps = (d: NodeData) => (d.components ?? {}) as unknown as { layoutGroup?: LayoutGroupData; layoutElement?: LayoutElementData };

/** Pairs every built UNode with the NodeData it came from (buildNode skips rect-less nodes and `skip` matches). */
export function pairNodes(n: UNode, d: NodeData, out = new Map<UNode, NodeData>(), skip?: (d: NodeData) => boolean): Map<UNode, NodeData> {
  out.set(n, d);
  const kids = (d.children ?? []).filter((c) => c.rect && !skip?.(c));
  n.children.forEach((child, i) => {
    const cd = kids[i];
    if (cd && cd.name === child.name) pairNodes(child, cd, out, skip);
  });
  return out;
}

/** Runs every enabled layout group under `root` (parents first, so nested groups see their final size). */
export function applyLayoutGroups(root: UNode, pairs: Map<UNode, NodeData>): void {
  root.layout();
  const visit = (n: UNode) => {
    const d = pairs.get(n);
    const g = d ? comps(d).layoutGroup : undefined;
    if (g?.enabled) {
      if (g.kind === 'GridLayoutGroup') grid(n, g);
      else linear(n, g, pairs, g.kind === 'VerticalLayoutGroup');
      n.layout();
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
}

function pref(el: LayoutElementData | undefined, axis: 'w' | 'h', fallback: number): { min: number; pref: number; flex: number } {
  const min = el ? (axis === 'w' ? el.minWidth : el.minHeight) : -1;
  const p = el ? (axis === 'w' ? el.preferredWidth : el.preferredHeight) : -1;
  const flex = el ? (axis === 'w' ? el.flexibleWidth : el.flexibleHeight) : -1;
  const m = Math.max(0, min);
  return { min: m, pref: Math.max(m, p >= 0 ? p : fallback), flex: Math.max(0, flex) };
}

function linear(n: UNode, g: LayoutGroupData, pairs: Map<UNode, NodeData>, vertical: boolean): void {
  const pad = g.padding;
  const spacing = typeof g.spacing === 'number' ? g.spacing : g.spacing[vertical ? 1 : 0];
  const kids = n.children.filter((c) => c.activeSelf && !comps(pairs.get(c) ?? ({} as NodeData)).layoutElement?.ignoreLayout);
  const innerW = n.w - pad.left - pad.right;
  const innerH = n.h - pad.top - pad.bottom;
  const main = vertical ? innerH : innerW;
  const cross = vertical ? innerW : innerH;
  const controlMain = vertical ? g.controlH : g.controlW;
  const controlCross = vertical ? g.controlW : g.controlH;
  const expandMain = vertical ? g.expandH : g.expandW;
  const expandCross = vertical ? g.expandW : g.expandH;
  const sizes = kids.map((c) => {
    const el = comps(pairs.get(c) ?? ({} as NodeData)).layoutElement;
    const own = vertical ? c.sizeDelta[1] : c.sizeDelta[0];
    const ownCross = vertical ? c.sizeDelta[0] : c.sizeDelta[1];
    const m = pref(el, vertical ? 'h' : 'w', controlMain ? 0 : own);
    const x = pref(el, vertical ? 'w' : 'h', controlCross ? 0 : ownCross);
    return { m, x, flexMain: m.flex > 0 ? m.flex : expandMain ? 1 : 0 };
  });
  const totalPref = sizes.reduce((s, z) => s + z.m.pref, 0) + spacing * Math.max(0, kids.length - 1);
  const totalFlex = sizes.reduce((s, z) => s + z.flexMain, 0);
  const extra = Math.max(0, main - totalPref);
  let cursor = vertical ? pad.top : pad.left;
  kids.forEach((c, i) => {
    const z = sizes[i]!;
    const len = controlMain || totalFlex > 0 ? z.m.pref + (totalFlex > 0 ? (extra * z.flexMain) / totalFlex : 0) : z.m.pref;
    const across = controlCross ? (expandCross ? cross : Math.min(cross, z.x.pref || cross)) : (vertical ? c.sizeDelta[0] : c.sizeDelta[1]);
    c.anchorMin = [0, 1];
    c.anchorMax = [0, 1];
    c.pivot = [0, 1];
    if (vertical) {
      c.anchoredPosition = [pad.left, -cursor];
      c.sizeDelta = [across, len];
    } else {
      c.anchoredPosition = [cursor, -pad.top];
      c.sizeDelta = [len, across];
    }
    cursor += len + spacing;
  });
}

function grid(n: UNode, g: LayoutGroupData): void {
  const [cw, ch] = g.cellSize ?? [100, 100];
  const [sx, sy] = Array.isArray(g.spacing) ? g.spacing : [g.spacing, g.spacing];
  const cols = g.constraint === '1' ? Math.max(1, Number(g.constraintCount) || 1) : Math.max(1, Math.floor((n.w - g.padding.left - g.padding.right + sx) / (cw + sx)));
  const kids = n.children.filter((c) => c.activeSelf);
  const rows = Math.ceil(kids.length / cols);
  const usedW = cols * cw + (cols - 1) * sx;
  const centred = g.childAlignment.includes('Center');
  const x0 = g.padding.left + (centred ? Math.max(0, (n.w - g.padding.left - g.padding.right - usedW) / 2) : 0);
  kids.forEach((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    c.anchorMin = [0, 1];
    c.anchorMax = [0, 1];
    c.pivot = [0, 1];
    c.anchoredPosition = [x0 + col * (cw + sx), -(g.padding.top + row * (ch + sy))];
    c.sizeDelta = [cw, ch];
  });
  // ContentSizeFitter (vertical: PreferredSize).
  n.sizeDelta = [n.sizeDelta[0], g.padding.top + g.padding.bottom + rows * ch + Math.max(0, rows - 1) * sy];
}
