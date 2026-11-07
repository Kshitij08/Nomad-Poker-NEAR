/**
 * The bits of MoreMountains Feel (MMFeedbacks) the river slam needs, ported line for line from the
 * C# in Assets/TopDownEngine/ThirdParty/MoreMountains. Pure maths, no three.js scene objects, so it
 * can be unit-tested and driven by any clock.
 *
 * Sources: MMTween.cs / MMTweenDefinitions.cs / MMTweenType.cs (eases), MMFeedbacksHelpers.Remap,
 * MMShaker.cs + MMPositionShaker.cs + MMRotationShaker.cs (VectorShaker), MMWiggle.cs Noise mode +
 * MMCameraShaker.cs (NoiseWiggle), MMCameraZoom.cs (CameraZoom), MMF_Position.cs AlongCurve
 * (CurveBounce), MMF_Rotation.cs Absolute (CurveRotation), MMLensDistortionShaker.cs (FloatShaker).
 */
import { evaluateCurve, type Keyframe } from './animCurve';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

/** MMFeedbacksHelpers.Remap / MMMaths.Remap: unclamped linear remap. */
export function remap(x: number, a: number, b: number, c: number, d: number): number {
  return c + ((x - a) / (b - a)) * (d - c);
}

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

// ---- MMTween ------------------------------------------------------------------------------------

const inOut = (f: (t: number) => number) => (t: number) => (t < 0.5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2);
const out = (f: (t: number) => number) => (t: number) => 1 - f(1 - t);
const easeInQuad = (t: number) => t * t;
const easeInCubic = (t: number) => t * t * t;
const easeInQuart = (t: number) => Math.pow(t, 4);
const easeInQuint = (t: number) => Math.pow(t, 5);
const easeInSine = (t: number) => 1 + Math.sin((Math.PI / 2) * t - Math.PI / 2);
/** Feel names this "Bounce" but it is an elastic-style decaying sine (MMTweenDefinitions.EaseIn_Bounce). */
const easeInBounce = (t: number) => {
  const p = 0.3;
  return Math.pow(2, -10 * t) * Math.sin(((t - p / 4) * (2 * Math.PI)) / p) + 1;
};
const easeInOverhead = (t: number) => {
  const back = 1.6;
  return t * t * ((back + 1) * t - back);
};
const easeInExpo = (t: number) => (t === 0 ? 0 : Math.pow(1024, t - 1));
const easeInElastic = (t: number) => {
  if (t === 0) return 0;
  if (t === 1) return 1;
  t -= 1;
  return -Math.pow(2, 10 * t) * Math.sin(((t - 0.1) * (2 * Math.PI)) / 0.4);
};
const easeInCirc = (t: number) => 1 - Math.sqrt(1 - t * t);

/**
 * MMTween.MMTweenCurve, in enum order (the serialized int is the index): 0 LinearTween,
 * 1-3 Quadratic In/Out/InOut, 4-6 Cubic, 7-9 Quartic, 10-12 Quintic, 13-15 Sinusoidal,
 * 16-18 Bounce, 19-21 Overhead, 22-24 Exponential, 25-27 Elastic, 28-30 Circular,
 * 31 AntiLinearTween, 32 AlmostIdentity. So 4 = EaseInCubic, 16 = EaseInBounce.
 */
export const MM_TWEEN_CURVES: readonly ((t: number) => number)[] = [
  (t) => t,
  easeInQuad, out(easeInQuad), inOut(easeInQuad),
  easeInCubic, out(easeInCubic), inOut(easeInCubic),
  easeInQuart, out(easeInQuart), inOut(easeInQuart),
  easeInQuint, out(easeInQuint), inOut(easeInQuint),
  easeInSine, out(easeInSine), inOut(easeInSine),
  easeInBounce, out(easeInBounce), inOut(easeInBounce),
  easeInOverhead, out(easeInOverhead), inOut(easeInOverhead),
  easeInExpo, out(easeInExpo), inOut(easeInExpo),
  easeInElastic, out(easeInElastic), inOut(easeInElastic),
  easeInCirc, out(easeInCirc), inOut(easeInCirc),
  (t) => 1 - t,
  (t) => t * t * (2 - t),
];

/** MMTweenType: MMTweenDefinitionType 0 = MMTween (use the enum ease), 1 = AnimationCurve (use `keys`). */
export interface MMTweenType {
  definitionType: 0 | 1;
  curve: number;
  keys: Keyframe[];
}

/** MMTween.Evaluate(t, MMTweenType). AnimationCurve mode clamps outside the keys (Unity's default wrap). */
export function mmTweenEvaluate(t: number, tween: MMTweenType): number {
  if (tween.definitionType === 0) return (MM_TWEEN_CURVES[tween.curve] ?? MM_TWEEN_CURVES[0])(t);
  return evaluateCurve(tween.keys, t);
}

/** MMTween.Tween(currentTime, initialTime, endTime, startValue, endValue, MMTweenType). */
export function mmTween(current: number, initial: number, end: number, start: number, endValue: number, tween: MMTweenType): number {
  const t = mmTweenEvaluate(remap(current, initial, end, 0, 1), tween);
  return start + t * (endValue - start);
}

// ---- Randomness -----------------------------------------------------------------------------------

/** UnityEngine.Random stand-in; inject a seeded one in tests. */
export interface Rng {
  /** [0, 1) */
  (): number;
}

export const rangeRandom = (rng: Rng, min: number, max: number) => min + (max - min) * rng();

/** MMMaths.RandomVector3: an independent Random.Range per component. */
export const randomVector3 = (rng: Rng, min: Vec3, max: Vec3): Vec3 =>
  vec3(rangeRandom(rng, min.x, max.x), rangeRandom(rng, min.y, max.y), rangeRandom(rng, min.z, max.z));

/** Random.insideUnitSphere (uniform in the ball). */
export function insideUnitSphere(rng: Rng): Vec3 {
  for (;;) {
    const x = rng() * 2 - 1;
    const y = rng() * 2 - 1;
    const z = rng() * 2 - 1;
    if (x * x + y * y + z * z <= 1) return vec3(x, y, z);
  }
}

// ---- Mathf.PerlinNoise ----------------------------------------------------------------------------

// Ken Perlin's reference permutation (Improved Noise, 2002).
// prettier-ignore
const PERM_BASE = [151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180];
export const PERLIN_PERMUTATION: readonly number[] = PERM_BASE;
const P = new Uint8Array(512);
for (let i = 0; i < 512; i++) P[i] = PERM_BASE[i & 255];

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t: number, a: number, b: number) => a + t * (b - a);
function grad(hash: number, x: number, y: number): number {
  // Improved-noise 3D gradient with z = 0.
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : 0;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** Raw improved Perlin noise on the z = 0 slice, roughly in [-0.7, 0.8]. */
export function perlinRaw(x: number, y: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const X = fx & 255;
  const Y = fy & 255;
  x -= fx;
  y -= fy;
  const u = fade(x);
  const v = fade(y);
  const A = P[X] + Y;
  const B = P[X + 1] + Y;
  const AA = P[A];
  const AB = P[A + 1];
  const BA = P[B];
  const BB = P[B + 1];
  return lerp(v, lerp(u, grad(P[AA], x, y), grad(P[BA], x - 1, y)), lerp(u, grad(P[AB], x, y - 1), grad(P[BB], x - 1, y - 1)));
}

/**
 * Mathf.PerlinNoise: Unity's native implementation is improved Perlin noise normalised with
 * (n + 0.69) / (0.793 + 0.69), giving values in about [0, 1] (slightly outside at the extremes).
 */
export function unityPerlin(x: number, y: number): number {
  return (perlinRaw(x, y) + 0.69) / (0.793 + 0.69);
}

// ---- MMPositionShaker / MMRotationShaker --------------------------------------------------------

/** The payload of MMPositionShakeEvent / MMRotationShakeEvent (fields the shakers read). */
export interface ShakeParams {
  duration: number;
  speed: number;
  range: number;
  mainDirection: Vec3;
  addDirectionalNoise: boolean;
  noiseStrengthMin: Vec3;
  noiseStrengthMax: Vec3;
  randomnessSeed: Vec3;
  randomizeSeedOnShake: boolean;
  useAttenuation: boolean;
  attenuation: Keyframe[];
  /** Always ends on the initial value anyway (see VectorShaker.complete). */
  resetTargetValuesAfterShake: boolean;
  /** MMPositionShaker.OscillationOffset (0 on the rotation shaker). */
  oscillationOffset?: number;
}

/** What a vector shaker drives: localPosition, or localRotation.eulerAngles in degrees. */
export interface VectorTarget {
  grab(): Vec3;
  apply(v: Vec3): void;
}

/**
 * MMShaker + MMPositionShaker / MMRotationShaker (Transform mode). A shake event while already
 * shaking (Interruptible) replaces every parameter -- including the randomness seed -- but does
 * NOT restart: `journey` keeps counting, exactly like Feel (Play() only re-enables the component,
 * and StartShaking runs from OnEnable, which an enabled shaker never gets again). Note too that
 * Shake() uses ShakeMainDirection; RandomizeDirection only feeds an unused field in Feel.
 */
export class VectorShaker {
  shaking = false;
  journey = 0;
  private p: ShakeParams | null = null;
  private initial: Vec3 = vec3();
  private seed: Vec3 = vec3();

  constructor(
    readonly target: VectorTarget,
    private readonly rng: Rng,
  ) {}

  /** OnMM*ShakeEvent (non-stop, non-restore). `intensity` multiplies the range (feedbacksIntensity). */
  onShakeEvent(params: ShakeParams, intensity = 1): void {
    this.p = { ...params, range: params.range * intensity };
    this.seed = params.randomnessSeed;
    if (this.shaking) return; // Play() on an enabled shaker: parameters swap in, journey continues
    // OnEnable -> StartShaking -> GrabInitialValues / ShakeStarts
    this.journey = 0;
    this.shaking = true;
    this.initial = this.target.grab();
    if (params.randomizeSeedOnShake) this.seed = insideUnitSphere(this.rng);
  }

  /** The shaker's Update(): Shake() at the current journey, then advance. */
  update(dt: number): void {
    if (!this.shaking || !this.p) return;
    this.shake();
    this.journey += dt;
    if (this.journey < 0 || this.journey > this.p.duration) {
      this.shaking = false;
      this.complete();
    }
  }

  /** stop:true event -> Stop(): Shaking = false; ShakeComplete(). */
  stop(): void {
    if (!this.p) return;
    this.shaking = false;
    this.complete();
  }

  /** restore:true event -> ResetTargetValues(). */
  restore(): void {
    if (this.p) this.target.apply(this.initial);
  }

  /** The offset the shake adds at the given journey (no target writes); exposed for tests. */
  offsetAt(journey: number, attenuationOverride?: number): Vec3 {
    const p = this.p!;
    const randomness = this.seed.x + this.seed.y + this.seed.z;
    const osc = (p.oscillationOffset ?? 0) + Math.sin(p.speed * (randomness + journey));
    const att = attenuationOverride ?? (p.useAttenuation ? evaluateCurve(p.attenuation, remap(journey, 0, p.duration, 0, 1)) : 1);
    let dx = p.mainDirection.x;
    let dy = p.mainDirection.y;
    let dz = p.mainDirection.z;
    if (p.addDirectionalNoise) {
      const s = randomVector3(this.rng, p.noiseStrengthMin, p.noiseStrengthMax); // re-rolled every frame, as in Feel
      dx += s.x * (unityPerlin(this.seed.x, journey) - 0.5);
      dy += s.y * (unityPerlin(this.seed.y, journey) - 0.5);
      dz += s.z * (unityPerlin(this.seed.z, journey) - 0.5);
    }
    const len = Math.hypot(dx, dy, dz);
    const k = len > 1e-5 ? (osc * p.range * att) / len : 0; // Vector3.Normalize zeroes tiny vectors
    return vec3(dx * k, dy * k, dz * k);
  }

  private shake(): void {
    const o = this.offsetAt(this.journey);
    this.target.apply(vec3(this.initial.x + o.x, this.initial.y + o.y, this.initial.z + o.z));
  }

  private complete(): void {
    // ShakeComplete: Shake() at the end, reset target if asked, then the subclass re-applies with
    // attenuation 0 -- which is the initial value either way.
    // attenuation 0 -- the initial value whether or not ResetTargetValuesAfterShake was set.
    this.journey = this.p!.duration;
    this.target.apply(this.initial);
  }
}

// ---- MMLensDistortionShaker (MMShaker.ShakeFloat) -----------------------------------------------

export interface FloatShakeParams {
  duration: number;
  curve: Keyframe[];
  remapZero: number;
  remapOne: number;
  relative: boolean;
  resetTargetValuesAfterShake: boolean;
}

/** A float shaker (MMLensDistortionShaker): value = remap(curve(journey / duration), 0, 1, zero, one). */
export class FloatShaker {
  shaking = false;
  journey = 0;
  private p: FloatShakeParams | null = null;
  private initial = 0;

  constructor(
    private readonly get: () => number,
    private readonly set: (v: number) => void,
  ) {}

  onShakeEvent(params: FloatShakeParams, intensity = 1): void {
    this.p = { ...params, remapZero: params.remapZero * intensity, remapOne: params.remapOne * intensity };
    if (this.shaking) return;
    this.journey = 0;
    this.shaking = true;
    this.initial = this.get();
  }

  valueAt(journey: number): number {
    const p = this.p!;
    const v = remap(evaluateCurve(p.curve, remap(journey, 0, p.duration, 0, 1)), 0, 1, p.remapZero, p.remapOne);
    return p.relative ? v + this.initial : v;
  }

  update(dt: number): void {
    if (!this.shaking || !this.p) return;
    this.set(this.valueAt(this.journey));
    this.journey += dt;
    if (this.journey > this.p.duration) {
      this.shaking = false;
      this.complete();
    }
  }

  stop(): void {
    if (!this.p) return;
    this.shaking = false;
    this.complete();
  }

  restore(): void {
    if (this.p) this.set(this.initial);
  }

  private complete(): void {
    const p = this.p!;
    this.journey = p.duration;
    this.set(this.valueAt(p.duration));
    if (p.resetTargetValuesAfterShake) this.set(this.initial);
  }
}

// ---- MMWiggle (Noise) driven by MMCameraShaker ---------------------------------------------------

/**
 * MMWiggle position wiggle in Noise mode with a limited time, as MMCameraShaker.ShakeCamera sets it
 * up: per-axis amplitude rolled in [-A, A] once per shake, Perlin noise at `frequency` along x with
 * a zero shift, a linear 1 -> 0 falloff over the duration (the default LimitedTimeFalloff), offsets
 * relative to the pose captured at Start (initialValue), and a snap back to it when time runs out.
 */
export class NoiseWiggle {
  permitted = false;
  private total = 0;
  private left = 0;
  private elapsed = 0;
  private amplitude: Vec3 = vec3();
  private frequency: Vec3 = vec3();
  private shift: Vec3 = vec3();
  value: Vec3;

  constructor(
    readonly initialValue: Vec3,
    private readonly rng: Rng,
    private readonly falloff: Keyframe[] = [
      { time: 0, value: 1, inSlope: 0, outSlope: -1 },
      { time: 1, value: 0, inSlope: -1, outSlope: 0 },
    ],
  ) {
    this.value = { ...initialValue };
  }

  /** MMCameraShaker.ShakeCamera: per-axis amplitudes win when any is non-zero. */
  shakeCamera(duration: number, amplitude: number, frequency: number, ax: number, ay: number, az: number): void {
    const a = ax !== 0 || ay !== 0 || az !== 0 ? vec3(ax, ay, az) : vec3(amplitude, amplitude, amplitude);
    // InitializeRandomValues
    this.elapsed = 0;
    this.amplitude = randomVector3(this.rng, vec3(-a.x, -a.y, -a.z), a);
    this.frequency = vec3(frequency, frequency, frequency);
    this.shift = vec3();
    // WiggleValue
    this.left = duration;
    this.total = duration;
    this.permitted = true;
  }

  /** MMWiggle position active-and-wiggling (what CameraShakeRestPose.IsPositionShaking reads). */
  get shaking(): boolean {
    return this.permitted && this.left > 0;
  }

  /** Returns true when it wrote `value` this frame. */
  update(dt: number): boolean {
    if (!this.permitted) return false;
    if (this.total > 0) {
      const timeSave = this.left;
      this.left -= dt;
      if (this.left <= 0) {
        if (timeSave > 0) {
          this.value = { ...this.initialValue };
          this.left = 0;
          this.permitted = false;
          return true;
        }
        return false;
      }
    }
    this.elapsed += dt;
    const fall = this.total > 0 ? evaluateCurve(this.falloff, (this.total - this.left) / this.total) : 1;
    this.value = vec3(
      (unityPerlin(this.frequency.x * this.elapsed, this.shift.x) * 2 - 1) * this.amplitude.x * fall + this.initialValue.x,
      (unityPerlin(this.frequency.y * this.elapsed, this.shift.y) * 2 - 1) * this.amplitude.y * fall + this.initialValue.y,
      (unityPerlin(this.frequency.z * this.elapsed, this.shift.z) * 2 - 1) * this.amplitude.z * fall + this.initialValue.z,
    );
    return true;
  }

  /** MMWiggle.RestoreInitialValues (via CameraShakeRestPose on a shake stop). */
  stop(): void {
    this.permitted = false;
    this.left = 0;
    this.value = { ...this.initialValue };
  }
}

// ---- MMCameraZoom ---------------------------------------------------------------------------------

/** MMCameraZoomModes */
export const ZoomMode = { For: 0, Set: 1, Reset: 2 } as const;
export type ZoomMode = (typeof ZoomMode)[keyof typeof ZoomMode];

/** MMCameraZoom: a zoom request is ignored while one is running. */
export class CameraZoom {
  zooming = false;
  fov: number;
  private mode: ZoomMode = ZoomMode.Set;
  private start = 0;
  private target = 0;
  private transition = 0;
  private duration = 0;
  private direction = 1;
  private elapsed = 0;
  private reached = false;
  private reachedAt = 0;
  private time = 0;
  private tween: MMTweenType = { definitionType: 1, curve: 4, keys: [] };

  constructor(readonly initialFov: number) {
    this.fov = initialFov;
  }

  /** `currentFov` is the camera's fieldOfView right now (the zoom starts from it). */
  zoom(mode: ZoomMode, newFov: number, transition: number, duration: number, tween: MMTweenType, currentFov: number, relative = false): void {
    if (this.zooming) return;
    this.zooming = true;
    this.elapsed = 0;
    this.mode = mode;
    this.start = currentFov;
    this.transition = transition;
    this.duration = duration;
    this.direction = 1;
    this.reached = false;
    this.tween = tween;
    this.target = mode === ZoomMode.Reset ? this.initialFov : newFov;
    if (relative) this.target += this.initialFov;
  }

  /** The zoomed field of view `elapsed` seconds into the transition. */
  fovAt(elapsed: number): number {
    const t = remap(elapsed, 0, this.transition, 0, 1);
    return this.start + (this.target - this.start) * mmTweenEvaluate(t, this.tween);
  }

  /**
   * MMCameraZoom.Update; returns true when it wrote `fov` this frame. Once the transition is over it
   * stops writing, so the camera keeps the last in-transition frame's value, like Feel.
   */
  update(dt: number): boolean {
    this.time += dt;
    if (!this.zooming) return false;
    this.elapsed += dt;
    if (this.elapsed <= this.transition) {
      this.fov = this.fovAt(this.elapsed);
      return true;
    }
    if (!this.reached) {
      this.reachedAt = this.time;
      this.reached = true;
    }
    if (this.mode === ZoomMode.For && this.direction === 1) {
      if (this.time - this.reachedAt > this.duration) {
        this.direction = -1;
        this.elapsed = 0;
        this.start = this.target;
        this.target = this.initialFov;
      }
    } else {
      this.zooming = false;
    }
    return false;
  }

  stop(): void {
    this.zooming = false;
  }

  restore(): void {
    this.fov = this.initialFov;
  }
}

// ---- MMF_Position (AlongCurve) / MMF_Rotation (Absolute) ----------------------------------------

/**
 * MMF_Position in AlongCurve mode, relative, world space: each animated axis is
 * initial + MMTween.Tween(percent, 0, 1, remapZero, remapOne, curveAxis); un-animated axes keep
 * whatever the transform currently has. A play while one is running is ignored (no additive plays).
 */
export class CurveBounce {
  running = false;
  private journey = 0;
  /** _workInitialPosition: captured on play (DeterminePositionsOnPlay). */
  initial: Vec3 | null = null;

  constructor(
    private readonly get: () => Vec3,
    private readonly set: (v: Vec3) => void,
    readonly duration: number,
    readonly axes: { x: MMTweenType | null; y: MMTweenType | null; z: MMTweenType | null },
    readonly remapZero: number,
    readonly remapOne: number,
  ) {}

  valueAt(percent: number, current: Vec3, intensity = 1): Vec3 {
    const i = this.initial!;
    const axis = (t: MMTweenType | null, init: number, cur: number) =>
      t ? init + mmTween(percent, 0, 1, this.remapZero * intensity, this.remapOne * intensity, t) : cur;
    return vec3(axis(this.axes.x, i.x, current.x), axis(this.axes.y, i.y, current.y), axis(this.axes.z, i.z, current.z));
  }

  play(): void {
    if (this.running) return;
    this.initial = this.get();
    this.running = true;
    this.journey = 0;
    this.step(0); // the coroutine body runs to its first yield immediately
  }

  /** One coroutine resume: apply at the current journey, then advance by dt. */
  step(dt: number): void {
    if (!this.running) return;
    if (this.journey >= 0 && this.journey <= this.duration && this.duration > 0) {
      this.set(this.valueAt(clamp01(this.journey / this.duration), this.get()));
      this.journey += dt;
      return;
    }
    this.set(this.valueAt(1, this.get()));
    this.running = false;
  }

  stop(): void {
    this.running = false;
  }

  restore(): void {
    if (this.initial) this.set({ ...this.initial });
  }
}

/** MMF_Rotation in Absolute mode: each frame rotation = initial, then Rotate(axis, Tween(...), space). */
export class CurveRotation {
  running = false;
  private journey = 0;

  constructor(
    /** Writes initial rotation composed with the per-axis angles (degrees) about X, then Y, then Z. */
    private readonly apply: (angles: Vec3) => void,
    private readonly restoreInitial: () => void,
    readonly duration: number,
    readonly axes: { x: MMTweenType | null; y: MMTweenType | null; z: MMTweenType | null },
    readonly remapZero: number,
    readonly remapOne: number,
  ) {}

  anglesAt(percent: number): Vec3 {
    const a = (t: MMTweenType | null) => (t ? mmTween(percent, 0, 1, this.remapZero, this.remapOne, t) : 0);
    return vec3(a(this.axes.x), a(this.axes.y), a(this.axes.z));
  }

  play(): void {
    if (this.running || this.duration === 0) return;
    this.running = true;
    this.journey = 0;
    this.step(0);
  }

  step(dt: number): void {
    if (!this.running) return;
    if (this.journey >= 0 && this.journey <= this.duration) {
      this.apply(this.anglesAt(clamp01(this.journey / this.duration)));
      this.journey += dt;
      return;
    }
    this.apply(this.anglesAt(1)); // FinalNormalizedTime -- leaves the curve's end value applied
    this.running = false;
  }

  stop(): void {
    this.running = false;
  }

  restore(): void {
    this.restoreInitial();
  }
}
