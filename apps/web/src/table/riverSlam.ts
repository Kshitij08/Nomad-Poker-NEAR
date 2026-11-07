import { Euler, MathUtils, Matrix4, Object3D, PerspectiveCamera, Quaternion, Vector3, type Texture } from 'three';
import sceneData from '../data/unity-scene.json';
import type { Keyframe } from '../anim/animCurve';
import { ticker as defaultTicker, type Ticker } from '../anim/tween';
import {
  CameraZoom,
  CurveBounce,
  CurveRotation,
  FloatShaker,
  NoiseWiggle,
  VectorShaker,
  vec3,
  type FloatShakeParams,
  type MMTweenType,
  type Rng,
  type ShakeParams,
  type Vec3,
  type ZoomMode,
} from '../anim/feel';
import { FrameDriver, ImpactSmoke } from '../three/impactSmoke';
import { applyUnityCameraPose } from '../three/unitySpace';
import type { RiverSlam } from './splineCardDealer';

/**
 * Port of `PokerController/RiverSlamFeedback` (an MMF_Player in Assets/Test/Test.unity) that
 * SplineCardDealer plays when the 5th community slot activates. Every value is read from
 * unity-scene.json (dealer.riverSlamFeedback.feedbacks); the maths is Feel's (anim/feel.ts).
 * All feedbacks run on scaled time (the ticker), intensity 1, no randomised output/duration.
 *
 * Who listens (dealer.shakerListeners + the Card_Modular prefab): channel 0 = Main Camera's
 * MMCameraShaker/MMWiggle (position), MMCameraZoom, MMLensDistortionShaker, and every dealt hole
 * card's MMPositionShaker + MMRotationShaker; channel 1 = Background/Table_Canvas (the felt) and the
 * seven Name_Canvas* HUD tags (MMRotationShaker + MMPositionShaker; their MMCameraShakers get no
 * channel-1 camera shake); channel 2 = Main Camera's MMRotationShaker.
 *
 *  #  feedback (label)                      delay  what happens here
 *  0  MMF_CameraZoom "Camera Zoom"           0     FOV 60 -> 49.8 (Set) over 1.3 s on the custom curve:
 *                                                  slow push-in, snap back out (~61) at ~1.24 s, ends ~59.9;
 *                                                  CameraShakeRestPose puts it back to 60 once shakes end.
 *  1  MMF_CameraShake "Camera Shake"         1.2   camera position wiggle 0.5 s, Perlin @5, amp +-1 per axis.
 *  2  MMF_PositionShake "whole cards shake"  -     inactive: skipped.
 *  3  MMF_RotationShake "Rotation Shake"     1.2   ch0 -> hole cards: 2 s, range 30 deg, speed 1, dir (1,1,1).
 *  4  MMF_PositionShake "whole cards shake"  1.2   ch0 -> hole cards: 2 s, range 1, speed 1, dir (0.6,0,1).
 *  5  MMF_PositionShake "Name tag shake"     -     inactive: skipped.
 *  6  MMF_RotationShake "... name tag"       1.0   ch1 -> the felt (Table_Canvas, tilts about its pivot)
 *                                                  and the HUD name tags via onNameTagShake: 2 s, range 20.
 *  7/8   Bounce/Rotation Slot_1              1.25  hop 0.25 up on (0,.3,.6,.8,1)->(0,1,0,.25,0) over
 *  9/10  Bounce/Rotation Slot_2              1.2   0.35 s; rotate about world Z by -1 + 91*curve deg over
 *  11/12 Bounce/Rotation Slot_3              1.15  1.3 s (peak 90 deg at 0.39 s). Absolute mode ends at
 *  13/14 Bounce/Rotation Slot_4              1.1   -1 deg and Feel leaves it there (kept, faithfully).
 *  15 MMF_Particles "Particles Play"         1.1   Slot_5/VFX_Impact_Smoke burst (three/impactSmoke.ts).
 *  16 MMF_RotationShake "Rotation Shake"     0     ch0 -> hole cards: 0.5 s, range 1 deg, dir (0,1,0).
 *  17 MMF_LensDistortion "Lens Distortion"   1.2   PPv2 intensity = 36 * curve over 0.5 s (ctx.lens).
 *  18 MMF_RotationShake "Rotation Shake"     1.2   ch2 -> camera rotation shaker. It arrives while #20 is
 *                                                  still shaking, so (Feel quirk, reproduced) it swaps its
 *                                                  0.5 s duration into the running shake at journey 0.7:
 *                                                  the camera snaps back and #18 itself never shows.
 *  19 MMF_CameraShake "Camera Shake"         0     camera position wiggle 1 s, Perlin @20, amp +-0.05.
 *  20 MMF_RotationShake "Rotation Shake"     0.5   ch2 -> camera rotation: speed 50, range 0.49 deg, dir
 *                                                  (1,7.63,1) (mostly yaw), seed (0,1,0); cut at 1.2 by #18.
 *
 * `playing` is the MMF_Player's IsPlaying: true for its TotalDuration (3.2 s = #3/#4's 1.2 + 2).
 * `stop()` = StopFeedbacks + RestoreInitialValues: pending feedbacks cancelled, every shaker/curve
 * stopped, slots back to their play-time position and initial rotation, camera to its rest pose and
 * FOV, felt and hole cards to where they were, lens intensity 0, smoke cleared.
 */

// ---- Scene data ---------------------------------------------------------------------------------

type RawKey = { time: number; value: number; inSlope: number | string; outSlope: number | string; weightedMode?: number; inWeight?: number; outWeight?: number };
type RawCurve = { m_Curve: RawKey[] };
type RawTween = { MMTweenDefinitionType: number; MMTweenCurve: number; Curve: RawCurve };
type RawV3 = { x: number; y: number; z: number };
type Settings = Record<string, unknown>;
interface RawFeedback {
  class: string;
  label: string;
  active: boolean;
  channel: number;
  initialDelay: number;
  timing: { ConstantIntensity: number };
  settings: Settings;
}
interface RawListener {
  class: string;
  path: string;
  enabled: boolean;
  channel: number;
}

const slope = (s: number | string) => (typeof s === 'number' ? s : s === '-Infinity' ? -Infinity : s === 'Infinity' ? Infinity : Number(s));
export const curveKeys = (c: RawCurve): Keyframe[] =>
  c.m_Curve.map((k) => ({
    time: k.time,
    value: k.value,
    inSlope: slope(k.inSlope),
    outSlope: slope(k.outSlope),
    weightedMode: k.weightedMode ?? 0,
    inWeight: k.inWeight,
    outWeight: k.outWeight,
  }));
const tweenOf = (t: RawTween): MMTweenType => ({ definitionType: t.MMTweenDefinitionType === 1 ? 1 : 0, curve: t.MMTweenCurve, keys: curveKeys(t.Curve) });
const num = (s: Settings, k: string) => s[k] as number;
const flag = (s: Settings, k: string) => (s[k] as number) === 1;
const v3 = (s: Settings, k: string): Vec3 => {
  const r = s[k] as RawV3;
  return vec3(r.x, r.y, r.z);
};

function shakeParams(s: Settings, position: boolean): ShakeParams {
  return {
    duration: num(s, 'Duration'),
    speed: num(s, 'ShakeSpeed'),
    range: num(s, 'ShakeRange'),
    mainDirection: v3(s, 'ShakeMainDirection'),
    addDirectionalNoise: flag(s, 'AddDirectionalNoise'),
    noiseStrengthMin: v3(s, 'DirectionalNoiseStrengthMin'),
    noiseStrengthMax: v3(s, 'DirectionalNoiseStrengthMax'),
    randomnessSeed: v3(s, 'RandomnessSeed'),
    randomizeSeedOnShake: flag(s, 'RandomizeSeedOnShake'),
    useAttenuation: flag(s, 'UseAttenuation'),
    attenuation: curveKeys(s.AttenuationCurve as RawCurve),
    resetTargetValuesAfterShake: flag(s, 'ResetTargetValuesAfterShake'),
    oscillationOffset: position ? ((s.OscillationOffset as number | undefined) ?? 0) : 0,
  };
}

export type SlamStep =
  | { kind: 'zoom'; mode: ZoomMode; fov: number; transition: number; duration: number; relative: boolean; tween: MMTweenType }
  | { kind: 'cameraShake'; duration: number; amplitude: number; frequency: number; ax: number; ay: number; az: number }
  | { kind: 'rotationShake' | 'positionShake'; params: ShakeParams }
  | { kind: 'bounce'; slot: number; duration: number; axes: { x: MMTweenType | null; y: MMTweenType | null; z: MMTweenType | null }; remapZero: number; remapOne: number }
  | { kind: 'rotation'; slot: number; duration: number; worldSpace: boolean; axes: { x: MMTweenType | null; y: MMTweenType | null; z: MMTweenType | null }; remapZero: number; remapOne: number }
  | { kind: 'particles'; slot: number; path: string }
  | { kind: 'lens'; params: FloatShakeParams };

export interface SlamFeedback {
  index: number;
  label: string;
  className: string;
  active: boolean;
  channel: number;
  delay: number;
  /** MMF_Feedback.FeedbackDuration (what MMF_Player.TotalDuration adds up). */
  duration: number;
  step: SlamStep | null;
}

const slotIndex = (name: string) => Number(/Slot_(\d)/.exec(name)?.[1] ?? 0) - 1;

function compile(f: RawFeedback, index: number): SlamFeedback {
  const s = f.settings;
  const base = { index, label: f.label, className: f.class, active: f.active, channel: f.channel, delay: f.initialDelay };
  switch (f.class) {
    case 'MMF_CameraZoom':
      return {
        ...base,
        duration: num(s, 'ZoomDuration'),
        step: {
          kind: 'zoom',
          mode: num(s, 'ZoomMode') as ZoomMode,
          fov: num(s, 'ZoomFieldOfView'),
          transition: num(s, 'ZoomTransitionDuration'),
          duration: num(s, 'ZoomDuration'),
          relative: flag(s, 'RelativeFieldOfView'),
          tween: tweenOf(s.ZoomTween as RawTween),
        },
      };
    case 'MMF_CameraShake': {
      const p = s.CameraShakeProperties as Record<string, number>;
      return { ...base, duration: p.Duration, step: { kind: 'cameraShake', duration: p.Duration, amplitude: p.Amplitude, frequency: p.Frequency, ax: p.AmplitudeX, ay: p.AmplitudeY, az: p.AmplitudeZ } };
    }
    case 'MMF_RotationShake':
    case 'MMF_PositionShake': {
      const position = f.class === 'MMF_PositionShake';
      return { ...base, duration: num(s, 'Duration'), step: { kind: position ? 'positionShake' : 'rotationShake', params: shakeParams(s, position) } };
    }
    case 'MMF_Position': {
      const axis = (a: string) => (flag(s, `Animate${a}`) ? tweenOf(s[`AnimatePositionTween${a}`] as RawTween) : null);
      const target = (s.AnimatePositionTarget as { gameObject: string }).gameObject;
      return {
        ...base,
        duration: num(s, 'AnimatePositionDuration'),
        step: { kind: 'bounce', slot: slotIndex(target), duration: num(s, 'AnimatePositionDuration'), axes: { x: axis('X'), y: axis('Y'), z: axis('Z') }, remapZero: num(s, 'RemapCurveZero'), remapOne: num(s, 'RemapCurveOne') },
      };
    }
    case 'MMF_Rotation': {
      const axis = (a: string) => (flag(s, `Animate${a}`) ? tweenOf(s[`AnimateRotationTween${a}`] as RawTween) : null);
      const target = (s.AnimateRotationTarget as { gameObject: string }).gameObject;
      return {
        ...base,
        duration: num(s, 'AnimateRotationDuration'),
        step: {
          kind: 'rotation',
          slot: slotIndex(target),
          duration: num(s, 'AnimateRotationDuration'),
          worldSpace: num(s, 'RotationSpace') === 0,
          axes: { x: axis('X'), y: axis('Y'), z: axis('Z') },
          remapZero: num(s, 'RemapCurveZero'),
          remapOne: num(s, 'RemapCurveOne'),
        },
      };
    }
    case 'MMF_Particles': {
      const path = (s.BoundParticleSystem as { path: string }).path;
      return { ...base, duration: num(s, 'DeclaredDuration'), step: { kind: 'particles', slot: slotIndex(path), path: path.split('/').slice(1).join('/') } };
    }
    case 'MMF_LensDistortion':
      return {
        ...base,
        duration: num(s, 'Duration'),
        step: {
          kind: 'lens',
          params: {
            duration: num(s, 'Duration'),
            curve: curveKeys(s.Intensity as RawCurve),
            remapZero: num(s, 'RemapIntensityZero'),
            remapOne: num(s, 'RemapIntensityOne'),
            relative: flag(s, 'RelativeIntensity'),
            resetTargetValuesAfterShake: flag(s, 'ResetTargetValuesAfterShake'),
          },
        },
      };
    default:
      return { ...base, duration: 0, step: null };
  }
}

const rawPlayer = sceneData.dealer.riverSlamFeedback as unknown as { feedbacksIntensity: number; initialDelay: number; feedbacks: RawFeedback[] };
/** The 21 feedbacks, in list order, compiled from the scene dump. */
export const RIVER_SLAM_FEEDBACKS: readonly SlamFeedback[] = rawPlayer.feedbacks.map(compile);
/** MMF_Player.TotalDuration: max over active feedbacks of InitialDelay + FeedbackDuration. */
export const RIVER_SLAM_TOTAL_DURATION =
  rawPlayer.initialDelay + Math.max(0, ...RIVER_SLAM_FEEDBACKS.filter((f) => f.active).map((f) => f.delay + f.duration));

const listeners = sceneData.dealer.shakerListeners as unknown as RawListener[];
const cardComponents = sceneData.card.rootComponents as unknown as { class: string; enabled: boolean; fields: { Channel: number } }[];
function channelOf(cls: string, pathTest: (p: string) => boolean, fallback: number): number {
  const l = listeners.find((x) => x.class.endsWith(cls) && x.enabled && pathTest(x.path));
  return l ? l.channel : fallback;
}
/** Listener channels in Test.unity. */
export const SLAM_CHANNELS = {
  cameraShaker: channelOf('MMCameraShaker', (p) => p === 'Main Camera', 0),
  cameraRotation: channelOf('MMRotationShaker', (p) => p === 'Main Camera', 2),
  lens: channelOf('MMLensDistortionShaker', (p) => p.startsWith('Main Camera'), 0),
  zoom: 0,
  feltRotation: channelOf('MMRotationShaker', (p) => p.endsWith('Table_Canvas'), 1),
  feltPosition: channelOf('MMPositionShaker', (p) => p.endsWith('Table_Canvas'), 1),
  nameTagRotation: channelOf('MMRotationShaker', (p) => p.startsWith('Name_Canvas'), 1),
  nameTagPosition: channelOf('MMPositionShaker', (p) => p.startsWith('Name_Canvas'), 1),
  cardRotation: cardComponents.find((c) => c.class.endsWith('MMRotationShaker'))?.fields.Channel ?? 0,
  cardPosition: cardComponents.find((c) => c.class.endsWith('MMPositionShaker'))?.fields.Channel ?? 0,
};

// ---- Unity-space helpers --------------------------------------------------------------------------

const D2R = MathUtils.DEG2RAD;
const R2D = MathUtils.RAD2DEG;
const scratchEuler = new Euler();

/** Quaternion.eulerAngles (Unity's Z-X-Y order is three.js 'YXZ'); degrees. */
export function unityEulerDeg(q: Quaternion): Vec3 {
  scratchEuler.setFromQuaternion(q, 'YXZ');
  return vec3(scratchEuler.x * R2D, scratchEuler.y * R2D, scratchEuler.z * R2D);
}

/** Quaternion.Euler(x, y, z) in degrees. */
export function unityQuatFromEuler(v: Vec3, out = new Quaternion()): Quaternion {
  return out.setFromEuler(scratchEuler.set(v.x * D2R, v.y * D2R, v.z * D2R, 'YXZ'));
}

const UNITY_AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
/** MMF_Rotation.ApplyRotation: rotation = initial, then Rotate(right, x), Rotate(up, y), Rotate(forward, z). */
export function rotateAbsolute(initial: Quaternion, angles: Vec3, worldSpace: boolean, out = new Quaternion()): Quaternion {
  out.copy(initial);
  const a = [angles.x, angles.y, angles.z];
  const step = new Quaternion();
  for (let i = 0; i < 3; i++) {
    if (a[i] === 0) continue;
    step.setFromAxisAngle(UNITY_AXES[i], a[i] * D2R);
    if (worldSpace) out.premultiply(step);
    else out.multiply(step);
  }
  return out;
}

const positionTarget = (o: Object3D) => ({
  grab: () => vec3(o.position.x, o.position.y, o.position.z),
  apply: (v: Vec3) => void o.position.set(v.x, v.y, v.z),
});
const rotationTarget = (o: Object3D) => ({
  grab: () => unityEulerDeg(o.quaternion),
  apply: (v: Vec3) => void unityQuatFromEuler(v, o.quaternion),
});

// ---- Public API ---------------------------------------------------------------------------------

/**
 * A channel-1 shake event for the HUD name tags (Name_Canvas*). Each tag has its own Feel shaker,
 * so call `play` once per tag with a stable key: the tag gets its own random seed, and a second
 * event while it is still shaking interrupts that same shaker the way Feel does.
 *
 * `apply(offset)` runs every ticker frame with the offset from the tag's rest pose -- for
 * 'rotation', degrees added to the tag's Unity localEulerAngles (x, y, z, applied Z then X then Y);
 * for 'position', Unity units added to its localPosition -- and once more with (0,0,0) when the
 * shake ends or the slam is stopped. For a camera-facing DOM tag a faithful mapping is
 * `transform: rotateY(${-y}deg) rotateX(${x}deg) rotateZ(${z}deg)` (Unity is left-handed; CSS lists
 * compose in the same Y*X*Z order). Only 'rotation' fires in the shipped scene (#6: 2 s, range 20).
 */
export interface NameTagShake {
  kind: 'rotation' | 'position';
  channel: number;
  duration: number;
  play(key: string, apply: (offset: Vec3) => void): void;
}

export interface RiverSlamContext {
  camera: PerspectiveCamera;
  /** Slot_1..Slot_5 roots (TableScene.slots[i].root), Unity space. */
  slotRoots: readonly Object3D[];
  /** The dealt hole cards' CardView.transform groups at the moment a shake event fires. */
  getHoleCards(): readonly Object3D[];
  /** The felt mesh named 'Table_Canvas/Image' (matrixAutoUpdate off); looked up in `world` if omitted. */
  felt?: Object3D | null;
  world?: Object3D;
  /** PPv2 lens distortion settings to animate (three/lensDistortion.ts LensDistortionRenderer). */
  lens?: { intensity: number } | null;
  /** HUD name-tag shakes (channel 1). */
  onNameTagShake?: (shake: NameTagShake) => void;
  /** Camera rest pose in Unity space; defaults to Test.unity's Main Camera. */
  cameraRest?: { position: Vec3; rotation: { x: number; y: number; z: number; w: number }; fov: number };
  random?: Rng;
  ticker?: Ticker;
  smokeTexture?: Texture;
}

export interface RiverSlamPlayer extends RiverSlam {
  /** Seconds since the latest play() (slam clock). */
  readonly elapsed: number;
  dispose(): void;
}

interface Pending {
  at: number;
  fb: SlamFeedback;
}

type CardShakers = { pos: VectorShaker; rot: VectorShaker };

export function createRiverSlam(ctx: RiverSlamContext): RiverSlamPlayer {
  const rng: Rng = ctx.random ?? Math.random;
  const clock = ctx.ticker ?? defaultTicker;
  const intensity = rawPlayer.feedbacksIntensity;

  // Camera rest pose (CameraShakeRestPose caches it on Awake).
  const cam = sceneData.camera;
  const rest = ctx.cameraRest ?? {
    position: vec3(cam.worldPosition[0], cam.worldPosition[1], cam.worldPosition[2]),
    rotation: { x: cam.worldRotation[0], y: cam.worldRotation[1], z: cam.worldRotation[2], w: cam.worldRotation[3] },
    fov: cam.fieldOfView,
  };
  const restRot = new Quaternion(rest.rotation.x, rest.rotation.y, rest.rotation.z, rest.rotation.w);
  let camPos: Vec3 = { ...rest.position };
  const camRot = restRot.clone();
  let fov = rest.fov;
  let fovHoldUntil = 0;
  let cameraDirty = false;

  const wiggle = new NoiseWiggle(rest.position, rng);
  const zoom = new CameraZoom(rest.fov);
  const camRotShaker = new VectorShaker(
    { grab: () => unityEulerDeg(camRot), apply: (v) => void unityQuatFromEuler(v, camRot) },
    rng,
  );

  // Felt: Background/Table_Canvas is the shaker's transform; the felt mesh is its Image child.
  const felt = ctx.felt ?? ctx.world?.getObjectByName('Table_Canvas/Image') ?? null;
  const canvas = sceneData.table.tableCanvas;
  const canvasPos0 = new Vector3().fromArray(canvas.worldPosition);
  const canvasRot0 = new Quaternion().fromArray(canvas.worldRotation);
  const canvasInv = new Matrix4().compose(canvasPos0, canvasRot0, new Vector3(1, 1, 1)).invert();
  const feltMatrix0 = felt ? felt.matrix.clone() : null;
  const feltPos = canvasPos0.clone();
  const feltRot = canvasRot0.clone();
  let feltMoved = false;
  const applyFelt = () => {
    if (!felt || !feltMatrix0) return;
    felt.matrix.compose(feltPos, feltRot, new Vector3(1, 1, 1)).multiply(canvasInv).multiply(feltMatrix0);
    felt.matrixWorldNeedsUpdate = true;
    feltMoved = true;
  };
  /** Back to the exact authored matrix (the euler round trip is only equal to ~1e-16). */
  const settleFelt = () => {
    if (!felt || !feltMatrix0 || !feltMoved) return;
    feltPos.copy(canvasPos0);
    feltRot.copy(canvasRot0);
    felt.matrix.copy(feltMatrix0);
    felt.matrixWorldNeedsUpdate = true;
    feltMoved = false;
  };
  const feltRotShaker = new VectorShaker(
    {
      grab: () => unityEulerDeg(feltRot),
      apply: (v) => {
        unityQuatFromEuler(v, feltRot);
        applyFelt();
      },
    },
    rng,
  );
  const feltPosShaker = new VectorShaker(
    {
      grab: () => vec3(feltPos.x, feltPos.y, feltPos.z),
      apply: (v) => {
        feltPos.set(v.x, v.y, v.z);
        applyFelt();
      },
    },
    rng,
  );

  // Lens (MMLensDistortionShaker on Main Camera/ppv).
  const lensShaker = new FloatShaker(
    () => ctx.lens?.intensity ?? 0,
    (v) => {
      if (ctx.lens) ctx.lens.intensity = v;
    },
  );

  // Hole cards: one MMPositionShaker + MMRotationShaker per Card_Modular instance.
  const cardShakers = new Map<Object3D, CardShakers>();
  const cardFor = (o: Object3D): CardShakers => {
    let c = cardShakers.get(o);
    if (!c) {
      c = { pos: new VectorShaker(positionTarget(o), rng), rot: new VectorShaker(rotationTarget(o), rng) };
      cardShakers.set(o, c);
    }
    return c;
  };

  // HUD name tags.
  const tagShakers = new Map<string, { shaker: VectorShaker; apply: (o: Vec3) => void }>();

  // Slot bounces / rotations (MMF_Rotation captures the initial rotation at Initialization).
  const slotInitialRot = ctx.slotRoots.map((r) => r.quaternion.clone());
  const bounces = new Map<number, CurveBounce>();
  const rotations = new Map<number, CurveRotation>();
  const smokes = new Map<string, ImpactSmoke>();
  for (const fb of RIVER_SLAM_FEEDBACKS) {
    if (!fb.active || !fb.step) continue;
    const st = fb.step;
    const root = st.kind === 'bounce' || st.kind === 'rotation' ? ctx.slotRoots[st.slot] : undefined;
    if (st.kind === 'bounce' && root) {
      bounces.set(fb.index, new CurveBounce(() => vec3(root.position.x, root.position.y, root.position.z), (v) => void root.position.set(v.x, v.y, v.z), st.duration, st.axes, st.remapZero * intensity, st.remapOne * intensity));
    } else if (st.kind === 'rotation' && root) {
      const init = slotInitialRot[st.slot];
      rotations.set(
        fb.index,
        new CurveRotation((a) => void rotateAbsolute(init, a, st.worldSpace, root.quaternion), () => void root.quaternion.copy(init), st.duration, st.axes, st.remapZero * intensity, st.remapOne * intensity),
      );
    }
  }

  let time = 0;
  let playStart = -Infinity;
  let playEnd = -Infinity;
  let pending: Pending[] = [];
  let driver: FrameDriver | null = null;

  const hold = (seconds: number) => (fovHoldUntil = Math.max(fovHoldUntil, time + Math.max(0, seconds)));

  function fire(fb: SlamFeedback): void {
    const st = fb.step;
    if (!st) return;
    switch (st.kind) {
      case 'zoom':
        if (fb.channel !== SLAM_CHANNELS.zoom) return;
        zoom.zoom(st.mode, st.fov, st.transition, st.duration, st.tween, fov, st.relative);
        hold(st.transition + (st.mode === 0 ? st.duration + st.transition : 0)); // CameraShakeRestPose.OnCameraZoom
        return;
      case 'cameraShake':
        if (fb.channel !== SLAM_CHANNELS.cameraShaker) return;
        wiggle.shakeCamera(st.duration, st.amplitude * intensity, st.frequency, st.ax * intensity, st.ay * intensity, st.az * intensity);
        hold(st.duration); // CameraShakeRestPose.OnCameraShake
        return;
      case 'rotationShake': {
        if (fb.channel === SLAM_CHANNELS.cameraRotation) camRotShaker.onShakeEvent(st.params, intensity);
        if (fb.channel === SLAM_CHANNELS.feltRotation && felt) feltRotShaker.onShakeEvent(st.params, intensity);
        if (fb.channel === SLAM_CHANNELS.cardRotation) for (const c of ctx.getHoleCards()) if (c.parent) cardFor(c).rot.onShakeEvent(st.params, intensity);
        if (fb.channel === SLAM_CHANNELS.nameTagRotation) emitTagShake('rotation', fb, st.params);
        return;
      }
      case 'positionShake': {
        if (fb.channel === SLAM_CHANNELS.feltPosition && felt) feltPosShaker.onShakeEvent(st.params, intensity);
        if (fb.channel === SLAM_CHANNELS.cardPosition) for (const c of ctx.getHoleCards()) if (c.parent) cardFor(c).pos.onShakeEvent(st.params, intensity);
        if (fb.channel === SLAM_CHANNELS.nameTagPosition) emitTagShake('position', fb, st.params);
        return;
      }
      case 'bounce':
        bounces.get(fb.index)?.play();
        return;
      case 'rotation':
        rotations.get(fb.index)?.play();
        return;
      case 'particles': {
        const node = ctx.slotRoots[st.slot]?.getObjectByName(st.path.split('/').pop()!);
        if (!node) return;
        let smoke = smokes.get(st.path);
        if (!smoke) smokes.set(st.path, (smoke = new ImpactSmoke(node, rng, ctx.smokeTexture)));
        smoke.play();
        return;
      }
      case 'lens':
        if (fb.channel === SLAM_CHANNELS.lens) lensShaker.onShakeEvent(st.params, intensity);
        return;
    }
  }

  function emitTagShake(kind: 'rotation' | 'position', fb: SlamFeedback, params: ShakeParams): void {
    if (!ctx.onNameTagShake) return;
    ctx.onNameTagShake({
      kind,
      channel: fb.channel,
      duration: params.duration,
      play: (key, apply) => {
        const id = `${kind}:${key}`;
        let entry = tagShakers.get(id);
        if (!entry) {
          const e = { apply, shaker: null as unknown as VectorShaker };
          e.shaker = new VectorShaker({ grab: () => vec3(), apply: (v) => e.apply(v) }, rng);
          tagShakers.set(id, (entry = e));
        }
        entry.apply = apply;
        entry.shaker.onShakeEvent(params, intensity);
      },
    });
  }

  function anyShaking(): boolean {
    if (camRotShaker.shaking || feltRotShaker.shaking || feltPosShaker.shaking || lensShaker.shaking || wiggle.shaking || zoom.zooming) return true;
    for (const c of cardShakers.values()) if (c.pos.shaking || c.rot.shaking) return true;
    for (const t of tagShakers.values()) if (t.shaker.shaking) return true;
    for (const b of bounces.values()) if (b.running) return true;
    for (const r of rotations.values()) if (r.running) return true;
    for (const s of smokes.values()) if (s.alive) return true;
    return false;
  }

  function applyCamera(): void {
    applyUnityCameraPose(ctx.camera, camPos, camRot);
    if (ctx.camera.fov !== fov) {
      ctx.camera.fov = fov;
      ctx.camera.updateProjectionMatrix();
    }
  }

  function frame(dt: number): boolean {
    time += dt;
    // Update(): shakers, wiggle, zoom.
    if (wiggle.update(dt)) camPos = { ...wiggle.value };
    camRotShaker.update(dt);
    if (zoom.update(dt)) fov = zoom.fov;
    feltRotShaker.update(dt);
    feltPosShaker.update(dt);
    if (!feltRotShaker.shaking && !feltPosShaker.shaking) settleFelt();
    lensShaker.update(dt);
    for (const [card, c] of cardShakers) {
      c.pos.update(dt);
      c.rot.update(dt);
      if (!card.parent && !c.pos.shaking && !c.rot.shaking) cardShakers.delete(card);
    }
    for (const t of tagShakers.values()) t.shaker.update(dt);
    for (const s of smokes.values()) s.update(dt);
    // Coroutines: running curve moves resume, then due feedbacks start (and run to their first yield).
    for (const b of bounces.values()) b.step(dt);
    for (const r of rotations.values()) r.step(dt);
    const due = pending.filter((p) => p.at <= time + 1e-9);
    if (due.length) {
      pending = pending.filter((p) => p.at > time + 1e-9);
      for (const p of due) fire(p.fb);
    }
    // CameraShakeRestPose.LateUpdate: snap back once no position/rotation shake is running.
    if (!wiggle.shaking && !camRotShaker.shaking) {
      camPos = { ...rest.position };
      camRot.copy(restRot);
      if (time >= fovHoldUntil) fov = rest.fov;
    }
    applyCamera();
    cameraDirty = true;

    const busy = pending.length > 0 || time < playEnd || time < fovHoldUntil || anyShaking();
    if (!busy) settleCamera();
    return busy;
  }

  function settleCamera(): void {
    camPos = { ...rest.position };
    camRot.copy(restRot);
    fov = rest.fov;
    if (cameraDirty) applyCamera();
    cameraDirty = false;
  }

  function ensureDriver(): void {
    if (driver && !driver.done) return;
    driver = clock.add(new FrameDriver(frame));
  }

  function play(): void {
    // MMF_Player.PlayFeedbacks (CanPlayWhileAlreadyPlaying): ResetFeedbacks, then every feedback's
    // Play(); earlier delayed plays are NOT cancelled. Particles stop on reset (StopSystemOnReset).
    for (const s of smokes.values()) s.clear();
    playStart = time;
    playEnd = time + RIVER_SLAM_TOTAL_DURATION;
    const start = time + rawPlayer.initialDelay;
    for (const fb of RIVER_SLAM_FEEDBACKS) {
      if (!fb.active || !fb.step) continue;
      if (fb.delay > 0 || rawPlayer.initialDelay > 0) pending.push({ at: start + fb.delay, fb });
      else fire(fb);
    }
    ensureDriver();
  }

  function stop(): void {
    pending = [];
    playEnd = time;
    // StopFeedbacks (InterruptsOnStop on all): shakers Stop() -> ShakeComplete -> initial values.
    camRotShaker.stop();
    feltRotShaker.stop();
    feltPosShaker.stop();
    lensShaker.stop();
    for (const c of cardShakers.values()) {
      c.pos.stop();
      c.rot.stop();
    }
    for (const t of tagShakers.values()) t.shaker.stop();
    wiggle.stop();
    zoom.stop();
    for (const b of bounces.values()) b.stop();
    for (const r of rotations.values()) r.stop();
    for (const s of smokes.values()) s.clear();
    // RestoreInitialValues.
    camRotShaker.restore();
    feltRotShaker.restore();
    feltPosShaker.restore();
    lensShaker.restore();
    for (const c of cardShakers.values()) {
      c.pos.restore();
      c.rot.restore();
    }
    for (const b of bounces.values()) b.restore();
    for (const r of rotations.values()) r.restore();
    zoom.restore();
    settleFelt();
    fovHoldUntil = 0;
    cameraDirty = true;
    settleCamera();
    cardShakers.clear();
    driver?.kill();
    driver = null;
  }

  return {
    play,
    stop,
    get playing() {
      return time < playEnd && driver !== null && !driver.done;
    },
    get elapsed() {
      return time - playStart;
    },
    dispose() {
      stop();
      for (const s of smokes.values()) s.dispose();
      smokes.clear();
    },
  };
}
