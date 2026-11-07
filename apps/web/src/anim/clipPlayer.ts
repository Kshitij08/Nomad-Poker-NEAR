import { Euler, MathUtils, Object3D, Quaternion } from 'three';
import { evaluateCurve, type Keyframe } from './animCurve';
import type { Linkable } from './tween';

/** One float curve of a Unity AnimationClip, split per component (m_EditorCurves style). */
export interface ClipCurve {
  /** Transform path relative to the Animator root, '' for the root itself ('A/B/C'). */
  path: string;
  /** e.g. 'm_LocalPosition.x', 'localEulerAnglesRaw.y', 'm_LocalRotation.w', 'm_LocalScale.z', 'm_IsActive'. */
  attribute: string;
  keyframes: Keyframe[];
}

export interface ClipData {
  name: string;
  length: number;
  loop?: boolean;
  curves: ClipCurve[];
}

interface Binding {
  target: Object3D;
  euler: Map<string, ClipCurve>;
  quat: Map<string, ClipCurve>;
  pos: Map<string, ClipCurve>;
  scale: Map<string, ClipCurve>;
  active?: ClipCurve;
}

function findPath(root: Object3D, path: string): Object3D | null {
  if (!path) return root;
  let node: Object3D | undefined = root;
  for (const name of path.split('/')) {
    node = node?.children.find((c) => c.name === name);
    if (!node) return null;
  }
  return node ?? null;
}

/**
 * Samples a Unity AnimationClip onto an Object3D hierarchy the way an Animator with a single layer
 * does: properties the clip animates are written every frame, everything else is left alone. Rotations
 * from Euler curves use Unity's Z-X-Y order. Time advances via update(dt) from the main loop.
 */
export class ClipPlayer implements Linkable {
  private bindings: Binding[] = [];
  private clip: ClipData | null = null;
  private time = 0;
  private playing = false;
  speed = 1;
  alive = true;
  onFinished?: (clip: ClipData) => void;

  constructor(readonly root: Object3D) {}

  play(clip: ClipData, normalizedTime = 0): void {
    this.clip = clip;
    this.time = normalizedTime * clip.length;
    this.playing = true;
    this.bindings = this.bind(clip);
    this.sample();
  }

  stop(): void {
    this.playing = false;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  update(dt: number): void {
    if (!this.playing || !this.clip) return;
    this.time += dt * this.speed;
    if (this.time >= this.clip.length) {
      if (this.clip.loop) this.time %= this.clip.length || 1;
      else {
        this.time = this.clip.length;
        this.sample();
        this.playing = false;
        this.onFinished?.(this.clip);
        return;
      }
    }
    this.sample();
  }

  private bind(clip: ClipData): Binding[] {
    const byPath = new Map<string, Binding>();
    for (const c of clip.curves) {
      const target = findPath(this.root, c.path);
      if (!target) continue;
      let b = byPath.get(c.path);
      if (!b) {
        b = { target, euler: new Map(), quat: new Map(), pos: new Map(), scale: new Map() };
        byPath.set(c.path, b);
      }
      const [prop, comp] = c.attribute.split('.');
      if (prop === 'm_LocalPosition') b.pos.set(comp, c);
      else if (prop === 'localEulerAnglesRaw' || prop === 'localEulerAngles' || prop === 'localEulerAnglesBaked') b.euler.set(comp, c);
      else if (prop === 'm_LocalRotation') b.quat.set(comp, c);
      else if (prop === 'm_LocalScale') b.scale.set(comp, c);
      else if (prop === 'm_IsActive') b.active = c;
    }
    return [...byPath.values()];
  }

  private sample(): void {
    const t = this.time;
    const ev = (c: ClipCurve | undefined, fallback: number) => (c ? evaluateCurve(c.keyframes, t) : fallback);
    for (const b of this.bindings) {
      const o = b.target;
      if (b.pos.size) o.position.set(ev(b.pos.get('x'), o.position.x), ev(b.pos.get('y'), o.position.y), ev(b.pos.get('z'), o.position.z));
      if (b.scale.size) o.scale.set(ev(b.scale.get('x'), o.scale.x), ev(b.scale.get('y'), o.scale.y), ev(b.scale.get('z'), o.scale.z));
      if (b.euler.size) {
        const cur = new Euler().setFromQuaternion(o.quaternion, 'YXZ');
        const d = MathUtils.DEG2RAD;
        o.quaternion.setFromEuler(
          new Euler(
            b.euler.has('x') ? ev(b.euler.get('x'), 0) * d : cur.x,
            b.euler.has('y') ? ev(b.euler.get('y'), 0) * d : cur.y,
            b.euler.has('z') ? ev(b.euler.get('z'), 0) * d : cur.z,
            'YXZ',
          ),
        );
      } else if (b.quat.size) {
        const q = o.quaternion;
        o.quaternion.copy(new Quaternion(ev(b.quat.get('x'), q.x), ev(b.quat.get('y'), q.y), ev(b.quat.get('z'), q.z), ev(b.quat.get('w'), q.w)).normalize());
      }
      if (b.active) o.visible = ev(b.active, 1) > 0.5;
    }
  }
}
