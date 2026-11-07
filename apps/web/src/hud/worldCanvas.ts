import { Vector3, type PerspectiveCamera } from 'three';
import { evaluateCurve, type Keyframe } from '../anim/animCurve';
import { Ease, ticker, type Tween } from '../anim/tween';
import type { UNode } from './unityUi';

/**
 * MMRotationShaker-style wobble for a seat canvas (the river slam's "Rotation Shake name tag", channel 1).
 * angle(t) = amplitude · sin(2π · frequency · t) · attenuation(t / duration), attenuation = the shakers' authored
 * AttenuationCurve (0 → 1 at 0.5 → 0, flat tangents). `axis` is in canvas-local space: [0,0,1] spins the tag in the
 * table plane; [0,1,0] / [1,0,0] tilt it (Unity's ShakeMainDirection; the feedback randomises it).
 */
const ATTENUATION: Keyframe[] = [
  { time: 0, value: 0, inSlope: 0, outSlope: 0 },
  { time: 0.5, value: 1, inSlope: 0, outSlope: 0 },
  { time: 1, value: 0, inSlope: 0, outSlope: 0 },
];

export class Shaker {
  angle = 0;
  axis: [number, number, number] = [0, 0, 1];
  private tween: Tween | null = null;

  start(durationSeconds: number, amplitudeDegrees: number, frequency: number, axis: [number, number, number] = [0, 0, 1]): void {
    this.tween?.kill();
    this.axis = axis;
    if (durationSeconds <= 0) return;
    this.tween = ticker.to(
      durationSeconds,
      (p) => {
        const t = p * durationSeconds;
        this.angle = amplitudeDegrees * Math.sin(2 * Math.PI * frequency * t) * evaluateCurve(ATTENUATION, p);
        if (p >= 1) this.angle = 0;
      },
      Ease.Linear,
    );
  }

  stop(): void {
    this.tween?.kill();
    this.tween = null;
    this.angle = 0;
  }
}

const tmp = new Vector3();

/**
 * A world-space canvas lying flat on the table (rotation 90° about X), seen by the straight-down camera. Its root
 * node is `size` canvas units square; each frame the canvas plane is projected (origin, +x, +y) and the root gets
 * the resulting affine as a CSS matrix — exact while the camera looks straight down, and it follows any camera
 * shake / zoom because it is recomputed from the live camera.
 */
export class WorldCanvas {
  readonly shaker = new Shaker();
  /**
   * River-slam name-tag shake from Feel (riverSlam.ts NameTagShake): degrees added to the canvas's Unity
   * localEulerAngles. Mapped to CSS as rotateY(-y) rotateX(x) rotateZ(z) about the canvas pivot.
   */
  eulerOffset: { x: number; y: number; z: number } | null = null;

  constructor(
    readonly root: UNode,
    /** Canvas pivot in Unity world space (x, y, z). */
    readonly position: [number, number, number],
    /** World units per canvas unit (RectTransform lossy scale, 0.0022457757). */
    readonly unitScale: number,
  ) {
    root.el.classList.add('u-world-canvas');
  }

  private projectPoint(x: number, y: number, z: number, camera: PerspectiveCamera, w: number, h: number): [number, number] {
    // Unity → three: z negated.
    tmp.set(x, y, -z).project(camera);
    return [((tmp.x + 1) / 2) * w, ((1 - tmp.y) / 2) * h];
  }

  /** Re-projects the canvas onto the viewport (CSS px). Call after the camera moved / the viewport resized. */
  update(camera: PerspectiveCamera, w: number, h: number): void {
    const [px, py, pz] = this.position;
    const d = 100 * this.unitScale;
    const o = this.projectPoint(px, py, pz, camera, w, h);
    const ex = this.projectPoint(px + d, py, pz, camera, w, h);
    const ey = this.projectPoint(px, py, pz + d, camera, w, h);
    // Screen delta per canvas unit along canvas +x and canvas +y (= Unity world +z = screen up).
    const X = [(ex[0] - o[0]) / 100, (ex[1] - o[1]) / 100];
    const Y = [(ey[0] - o[0]) / 100, (ey[1] - o[1]) / 100];
    // Sliced sprites rasterise at this resolution; re-render only when it drifts noticeably (resize, big zoom).
    const pxPerUnit = Math.hypot(X[0], X[1]);
    const prev = this.root.renderScale;
    this.root.renderScale = pxPerUnit;
    if (Math.abs(pxPerUnit - prev) > prev * 0.1 && this.root.activeInHierarchy) this.root.layout();
    const hw = this.root.sizeDelta[0] / 2;
    const hh = this.root.sizeDelta[1] / 2;
    // CSS local (u, v) from the root's top-left → canvas (u − hw, hh − v) → screen o + x·X + y·Y.
    const e = o[0] - hw * X[0] + hh * Y[0];
    const f = o[1] - hw * X[1] + hh * Y[1];
    let t = `matrix(${X[0]},${X[1]},${-Y[0]},${-Y[1]},${e},${f})`;
    const a = this.shaker.angle;
    if (a) {
      const [ax, ay, az] = this.shaker.axis;
      if (ax === 0 && ay === 0) {
        t += ` translate(${hw}px,${hh}px) rotate(${-a * Math.sign(az || 1)}deg) translate(${-hw}px,${-hh}px)`;
      } else {
        // Tilt: perspective from the camera's distance to the canvas, in canvas units. CSS y is down → flip y.
        const depth = Math.max(0.01, camera.position.y - py) / this.unitScale;
        t += ` translate(${hw}px,${hh}px) perspective(${depth}px) rotate3d(${ax},${-ay},${-az},${a}deg) translate(${-hw}px,${-hh}px)`;
      }
    }
    const eo = this.eulerOffset;
    if (eo && (eo.x || eo.y || eo.z)) {
      const depth = Math.max(0.01, camera.position.y - py) / this.unitScale;
      t += ` translate(${hw}px,${hh}px) perspective(${depth}px) rotateY(${-eo.y}deg) rotateX(${eo.x}deg) rotateZ(${eo.z}deg) translate(${-hw}px,${-hh}px)`;
    }
    this.root.el.style.transform = t;
  }
}
