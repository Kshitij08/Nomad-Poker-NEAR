/**
 * Plays the HUD AnimationClips from data/ui-anims.json on UNode trees, the way a single-layer Animator with
 * writeDefaults does: each frame every curve the clip owns is sampled (Unity Hermite keys, clamped before the first
 * and after the last key) and written; anything the clip does not animate is left as authored. Runs on the shared
 * `ticker`, so ?speed and ?paused / __poker.step() apply.
 */
import { clips as clipTable } from '../data/ui-anims.json';
import { evaluateCurve, type Keyframe } from '../anim/animCurve';
import { Ease, ticker, type Tween } from '../anim/tween';
import type { UNode } from './unityUi';

interface CurveData {
  path: string;
  component: string;
  attribute: string;
  keys: Keyframe[];
}
export interface UiClip {
  name: string;
  length: number;
  loop: boolean;
  curves: CurveData[];
}

const CLIPS = clipTable as unknown as Record<string, UiClip>;

export function uiClip(name: string): UiClip {
  const key = Object.keys(CLIPS).find((k) => k.endsWith('/' + name + '.anim'));
  if (!key) throw new Error(`UI clip ${name} not in ui-anims.json`);
  return CLIPS[key];
}

type Setter = (node: UNode, v: number) => void;

const SETTERS: Record<string, Setter> = {
  'm_AnchoredPosition.x': (n, v) => (n.anchoredPosition[0] = v),
  'm_AnchoredPosition.y': (n, v) => (n.anchoredPosition[1] = v),
  'm_SizeDelta.x': (n, v) => (n.sizeDelta[0] = v),
  'm_SizeDelta.y': (n, v) => (n.sizeDelta[1] = v),
  'm_Pivot.x': (n, v) => (n.pivot[0] = v),
  'm_Pivot.y': (n, v) => (n.pivot[1] = v),
  'm_LocalScale.x': (n, v) => (n.scale[0] = v),
  'm_LocalScale.y': (n, v) => (n.scale[1] = v),
  'localScale.x': (n, v) => (n.scale[0] = v),
  'localScale.y': (n, v) => (n.scale[1] = v),
  'm_Alpha': (n, v) => (n.groupAlpha = v),
  'm_FillAmount': (n, v) => n.image && (n.image.fillAmount = v),
};

interface Bound {
  node: UNode;
  apply: (t: number) => void;
}

function bind(root: UNode, clip: UiClip): Bound[] {
  const out: Bound[] = [];
  const quats = new Map<UNode, Partial<Record<'x' | 'y' | 'z' | 'w', Keyframe[]>>>();
  const colors = new Map<UNode, Partial<Record<'r' | 'g' | 'b' | 'a', Keyframe[]>>>();
  for (const c of clip.curves) {
    const node = root.find(c.path);
    if (!node) continue;
    const [prop, comp] = c.attribute.split('.');
    if (prop === 'm_LocalRotation') {
      const q = quats.get(node) ?? {};
      q[comp as 'z'] = c.keys;
      quats.set(node, q);
    } else if (prop === 'm_Color' && c.component === 'Image') {
      const q = colors.get(node) ?? {};
      q[comp as 'r'] = c.keys;
      colors.set(node, q);
    } else {
      // m_LocalPosition on a RectTransform is ignored: the Animator applies RectTransform properties
      // (anchoredPosition) after Transform ones, so anchoredPosition decides where the rect ends up.
      const set = SETTERS[c.attribute];
      if (set) out.push({ node, apply: (t) => set(node, evaluateCurve(c.keys, t)) });
    }
  }
  for (const [node, q] of quats) {
    out.push({
      node,
      apply: (t) => {
        const z = q.z ? evaluateCurve(q.z, t) : 0;
        const w = q.w ? evaluateCurve(q.w, t) : 1;
        node.rotation = (2 * Math.atan2(z, w) * 180) / Math.PI;
      },
    });
  }
  for (const [node, q] of colors) {
    out.push({
      node,
      apply: (t) => {
        const base = node.image?.color ?? { r: 1, g: 1, b: 1, a: 1 };
        node.imageColorOverride = {
          r: q.r ? evaluateCurve(q.r, t) : base.r,
          g: q.g ? evaluateCurve(q.g, t) : base.g,
          b: q.b ? evaluateCurve(q.b, t) : base.b,
          a: q.a ? evaluateCurve(q.a, t) : base.a,
        };
      },
    });
  }
  return out;
}

/** A clip bound to a node tree. `play()` restarts it from 0 (Animator default state on enable). */
export class ClipBinding {
  private readonly bound: Bound[];
  private tween: Tween | null = null;
  private time = 0;

  constructor(
    root: UNode,
    readonly clip: UiClip,
    /** Node to re-layout after sampling (defaults to the clip root). */
    private readonly layoutRoot: UNode = root,
  ) {
    this.bound = bind(root, clip);
  }

  play(): void {
    this.stop();
    this.sample(0);
    const len = this.clip.length;
    if (len <= 0) return;
    if (this.clip.loop) {
      const span = 1e6;
      this.tween = ticker.to(span, (p) => this.sample((p * span) % len), Ease.Linear);
    } else {
      this.tween = ticker.to(len, (p) => this.sample(p * len), Ease.Linear);
    }
  }

  stop(): void {
    this.tween?.kill();
    this.tween = null;
  }

  /** Jumps to the end pose (used when something is shown while a clip would be mid-way, e.g. on rebuild). */
  finish(): void {
    this.stop();
    this.sample(this.clip.length);
  }

  get playing(): boolean {
    return !!this.tween && !this.tween.done;
  }

  get currentTime(): number {
    return this.time;
  }

  private sample(t: number): void {
    this.time = t;
    for (const b of this.bound) b.apply(t);
    if (this.layoutRoot.activeInHierarchy) this.layoutRoot.layout();
  }
}

/** Wires an Animator: the clip restarts every time `node` becomes active in the hierarchy, stops when disabled. */
export function animatorOnEnable(node: UNode, clip: UiClip, layoutRoot: UNode = node, clipRoot: UNode = node): ClipBinding {
  const b = new ClipBinding(clipRoot, clip, layoutRoot);
  node.onEnable.push(() => b.play());
  node.onDisable.push(() => b.stop());
  return b;
}
