import { describe, expect, it } from 'vitest';
import { Group, Object3D, PerspectiveCamera, Quaternion, Texture } from 'three';
import { Ticker } from '../../anim/tween';
import {
  CameraZoom,
  CurveBounce,
  MM_TWEEN_CURVES,
  NoiseWiggle,
  PERLIN_PERMUTATION,
  VectorShaker,
  mmTweenEvaluate,
  unityPerlin,
  vec3,
  type ShakeParams,
  type Vec3,
} from '../../anim/feel';
import { createRiverSlam, RIVER_SLAM_FEEDBACKS, RIVER_SLAM_TOTAL_DURATION, SLAM_CHANNELS, type NameTagShake, type SlamStep } from '../riverSlam';
import { distortUv, lensDistortionUniforms } from '../../three/lensDistortion';
import { limitVelocityStep } from '../../three/impactSmoke';
import { applyUnityCameraPose } from '../../three/unitySpace';
import sceneData from '../../data/unity-scene.json';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stepOf<K extends SlamStep['kind']>(kind: K, slot?: number): Extract<SlamStep, { kind: K }> {
  const f = RIVER_SLAM_FEEDBACKS.find((x) => x.step?.kind === kind && (slot === undefined || (x.step as { slot?: number }).slot === slot));
  return f!.step as Extract<SlamStep, { kind: K }>;
}

describe('MMTween', () => {
  it('maps the enum ints to Feel eases (4 = EaseInCubic, 16 = EaseInBounce)', () => {
    expect(MM_TWEEN_CURVES).toHaveLength(33);
    expect(MM_TWEEN_CURVES[4](0.5)).toBeCloseTo(0.125, 10);
    expect(MM_TWEEN_CURVES[16](0)).toBeCloseTo(0, 10);
    expect(MM_TWEEN_CURVES[16](1)).toBeCloseTo(1 + Math.pow(2, -10) * Math.sin(((1 - 0.075) * 2 * Math.PI) / 0.3), 10);
    expect(MM_TWEEN_CURVES[5](0.5)).toBeCloseTo(0.875, 10); // EaseOutCubic
  });

  it('uses the AnimationCurve when MMTweenDefinitionType is 1 (every river-slam tween is)', () => {
    const y = stepOf('bounce', 3).axes.y!;
    expect(y.definitionType).toBe(1);
    expect(y.curve).toBe(4); // ignored
    expect(mmTweenEvaluate(0, y)).toBeCloseTo(0, 6);
    expect(mmTweenEvaluate(0.15, y)).toBeCloseTo(0.5, 6); // flat tangents: smoothstep halfway
    expect(mmTweenEvaluate(0.3, y)).toBeCloseTo(1, 6);
    expect(mmTweenEvaluate(0.6, y)).toBeCloseTo(0, 6);
    expect(mmTweenEvaluate(0.8, y)).toBeCloseTo(0.25, 6);
    expect(mmTweenEvaluate(1, y)).toBeCloseTo(0, 6);
  });
});

describe('scene data', () => {
  it('compiles 21 feedbacks and skips the two inactive ones', () => {
    expect(RIVER_SLAM_FEEDBACKS).toHaveLength(21);
    expect(RIVER_SLAM_FEEDBACKS.filter((f) => !f.active).map((f) => f.index)).toEqual([2, 5]);
    expect(RIVER_SLAM_FEEDBACKS.every((f) => f.step)).toBe(true);
    expect(RIVER_SLAM_TOTAL_DURATION).toBeCloseTo(3.2, 6);
  });

  it('routes channels like Test.unity', () => {
    expect(SLAM_CHANNELS).toMatchObject({ cameraShaker: 0, cameraRotation: 2, lens: 0, feltRotation: 1, nameTagRotation: 1, cardRotation: 0, cardPosition: 0 });
  });
});

describe('Mathf.PerlinNoise port', () => {
  it('uses a true permutation and Unity normalisation', () => {
    expect(new Set(PERLIN_PERMUTATION).size).toBe(256);
    expect(unityPerlin(0, 0)).toBeCloseTo(0.69 / 1.483, 6); // lattice points are 0 before normalising
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const v = unityPerlin(i * 0.137, (i % 17) * 0.29);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThan(-0.05);
    expect(hi).toBeLessThan(1.05);
  });
});

describe('Feel shakers', () => {
  const params: ShakeParams = {
    duration: 2,
    speed: 1,
    range: 30,
    mainDirection: vec3(1, 1, 1),
    addDirectionalNoise: true,
    noiseStrengthMin: vec3(0.25, 0.25, 0.25),
    noiseStrengthMax: vec3(0.25, 0.25, 0.25),
    randomnessSeed: vec3(),
    randomizeSeedOnShake: true,
    useAttenuation: true,
    attenuation: [
      { time: 0, value: 0, inSlope: 0, outSlope: 0 },
      { time: 0.5, value: 1, inSlope: 0, outSlope: 0 },
      { time: 1, value: 0, inSlope: 0, outSlope: 0 },
    ],
    resetTargetValuesAfterShake: true,
  };

  it('is zero at both ends of the bell attenuation and returns to the initial value', () => {
    let v: Vec3 = vec3(10, 20, 30);
    const s = new VectorShaker({ grab: () => v, apply: (x) => (v = x) }, mulberry32(1));
    s.onShakeEvent(params);
    const o0 = s.offsetAt(0);
    expect(Math.hypot(o0.x, o0.y, o0.z)).toBeCloseTo(0, 9);
    expect(Math.hypot(...Object.values(s.offsetAt(1)))).toBeGreaterThan(0);
    for (let i = 0; i < 200; i++) s.update(1 / 60);
    expect(s.shaking).toBe(false);
    expect(v).toEqual({ x: 10, y: 20, z: 30 });
  });

  it('an interrupting event swaps parameters into the running shake (journey keeps going)', () => {
    let v = vec3();
    const s = new VectorShaker({ grab: () => v, apply: (x) => (v = x) }, mulberry32(2));
    s.onShakeEvent({ ...params, duration: 1 });
    for (let i = 0; i < 42; i++) s.update(1 / 60); // journey 0.7
    s.onShakeEvent({ ...params, duration: 0.5 });
    expect(s.journey).toBeCloseTo(0.7, 6);
    s.update(1 / 60);
    expect(s.shaking).toBe(false);
    expect(v).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('camera wiggle snaps back to the rest position when its time runs out', () => {
    const w = new NoiseWiggle(vec3(0, 11.03, 0.15), mulberry32(3));
    w.shakeCamera(0.5, 1, 5, 1, 1, 1);
    w.update(1 / 60);
    expect(w.shaking).toBe(true);
    for (let i = 0; i < 40; i++) w.update(1 / 60);
    expect(w.shaking).toBe(false);
    expect(w.value).toEqual({ x: 0, y: 11.03, z: 0.15 });
  });

  it('camera zoom follows the authored punch-in / snap-out curve', () => {
    const zf = stepOf('zoom');
    const z = new CameraZoom(60);
    z.zoom(1, zf.fov, zf.transition, 0, zf.tween, 60);
    expect(z.fovAt(0)).toBeCloseTo(60, 6);
    expect(z.fovAt(0.9458125 * 1.3)).toBeCloseTo(60 + (49.8 - 60) * 0.9969482, 4);
    expect(z.fovAt(0.95382965 * 1.3)).toBeCloseTo(60 + (49.8 - 60) * -0.10610241, 4);
    expect(z.fovAt(1.3)).toBeCloseTo(60 + (49.8 - 60) * 0.008281708, 4);
  });

  it('a bounce hops on Y only and lands where it started', () => {
    const b = stepOf('bounce', 0);
    expect(b.axes.x).toBeNull();
    expect(b.axes.z).toBeNull();
    let p = vec3(-1.98, 0.46, 0);
    const c = new CurveBounce(() => p, (v) => (p = v), b.duration, b.axes, b.remapZero, b.remapOne);
    c.play();
    expect(p.y).toBeCloseTo(0.46, 9);
    expect(c.valueAt(0.3, p).y).toBeCloseTo(0.71, 6);
    expect(c.valueAt(0.15, p).y).toBeCloseTo(0.585, 6);
    expect(c.valueAt(0.8, p).y).toBeCloseTo(0.46 + 0.0625, 6);
    for (let i = 0; i < 30; i++) c.step(1 / 60);
    expect(c.running).toBe(false);
    expect(p).toEqual({ x: -1.98, y: 0.46, z: 0 });
  });
});

describe('lens distortion (PPv2)', () => {
  it('builds the shader vectors like LensDistortionRenderer.Render', () => {
    const s = { intensity: 36, intensityX: 1, intensityY: 1, centerX: 0, centerY: 0, scale: 1 };
    const { amount, centerScale } = lensDistortionUniforms(s);
    const theta = (57.6 * Math.PI) / 180;
    expect(amount[0]).toBeCloseTo(theta, 9);
    expect(amount[1]).toBeCloseTo(2 * Math.tan(theta / 2), 9);
    expect(amount[2]).toBe(1);
    expect(amount[3]).toBe(36);
    expect(centerScale).toEqual([0, 0, 1, 1]);
    expect(lensDistortionUniforms({ ...s, intensity: -27 }).amount[0]).toBeCloseTo(1 / ((1.6 * 27 * Math.PI) / 180), 9);
    const [u, v] = distortUv(0.5, 0.5, s);
    expect(u).toBeCloseTo(0.5, 5);
    expect(v).toBeCloseTo(0.5, 5);
    expect(distortUv(0.9, 0.5, s)[0]).toBeLessThan(0.9); // positive: samples inward (picture bulges out)
    expect(distortUv(0.9, 0.5, { ...s, intensity: -36 })[0]).toBeGreaterThan(0.9); // negative: samples outward
  });
});

describe('impact smoke', () => {
  it('limit velocity drags the 20 u/s burst toward the 1 u/s limit', () => {
    let v = 20;
    for (let i = 0; i < 18; i++) v = limitVelocityStep(v, 0.35, 1 / 60);
    expect(v).toBeLessThan(1.1);
    expect(v).toBeGreaterThan(0.9);
  });
});

// ---- The whole player -----------------------------------------------------------------------------

function rig() {
  const clock = new Ticker();
  const slotRoots = sceneData.communitySlots.map((s, i) => {
    const o = new Group();
    o.name = `Slot_${i + 1}`;
    o.position.fromArray(s.worldPosition);
    if (i === 4) {
      const vfx = new Object3D();
      vfx.name = 'VFX_Impact_Smoke';
      o.add(vfx);
    }
    return o;
  });
  const dealt = new Group();
  const card = new Group();
  card.position.set(0.4, 0.5, -3.2);
  card.quaternion.set(0, 0, 1, 0);
  dealt.add(card);
  const felt = new Object3D();
  felt.name = 'Table_Canvas/Image';
  felt.matrixAutoUpdate = false;
  felt.matrix.fromArray(sceneData.table.tableCanvas.images[0].worldMatrix);
  const world = new Group();
  world.add(felt);
  const camera = new PerspectiveCamera(60, 16 / 9, 0.3, 1000);
  const c = sceneData.camera;
  applyUnityCameraPose(camera, { x: c.worldPosition[0], y: c.worldPosition[1], z: c.worldPosition[2] }, { x: c.worldRotation[0], y: c.worldRotation[1], z: c.worldRotation[2], w: c.worldRotation[3] });
  const lens = { intensity: 0 };
  const tags: Vec3[] = [];
  const events: NameTagShake[] = [];
  const slam = createRiverSlam({
    camera,
    slotRoots,
    getHoleCards: () => [card],
    world,
    lens,
    random: mulberry32(7),
    ticker: clock,
    smokeTexture: new Texture(),
    onNameTagShake: (e) => {
      events.push(e);
      e.play('seat0', (o) => tags.push(o));
    },
  });
  let t = 0;
  const advanceTo = (time: number) => {
    while (t < time - 1e-9) {
      clock.update(1 / 60);
      t += 1 / 60;
    }
  };
  return { slam, slotRoots, card, felt, camera, lens, tags, events, advanceTo, feltMatrix0: felt.matrix.clone() };
}

describe('createRiverSlam', () => {
  it('plays the timeline: bounces, slot spin, lens, felt and camera, then settles', () => {
    const r = rig();
    const restPos = r.camera.position.clone();
    r.slam.play();
    expect(r.slam.playing).toBe(true);

    r.advanceTo(1.0);
    expect(r.slotRoots[3].position.y).toBeCloseTo(0.46, 9); // Slot_4 waits for 1.1
    expect(r.camera.fov).toBeLessThan(60); // pushing in

    r.advanceTo(1.1 + 0.3 * 0.35);
    expect(r.slotRoots[3].position.y).toBeGreaterThan(0.69); // near the 0.25 peak
    r.advanceTo(1.1 + 0.3 * 1.3 + 1 / 60);
    const zAngle = (q: Quaternion) => (2 * Math.atan2(q.z, q.w) * 180) / Math.PI;
    expect(zAngle(r.slotRoots[3].quaternion)).toBeGreaterThan(85); // ~90 deg about world Z

    r.advanceTo(1.3);
    expect(Math.abs(r.lens.intensity)).toBeGreaterThan(0);
    expect(r.felt.matrix.equals(r.feltMatrix0)).toBe(false); // ch1 felt tilt
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('rotation');
    expect(r.camera.position.distanceTo(restPos)).toBeGreaterThan(0); // the 1.2 s wiggle

    r.advanceTo(3.3);
    expect(r.slam.playing).toBe(false);
    expect(r.lens.intensity).toBe(0);
    for (const s of r.slotRoots.slice(0, 4)) expect(s.position.y).toBeCloseTo(0.46, 9);
    expect(zAngle(r.slotRoots[3].quaternion)).toBeCloseTo(-1, 6); // Absolute mode leaves the curve end (-1 deg)
    expect(r.camera.position.distanceTo(restPos)).toBeLessThan(1e-9);
    expect(r.camera.fov).toBe(60);
    expect(r.felt.matrix.equals(r.feltMatrix0)).toBe(true);
    expect(r.card.position.toArray()).toEqual([0.4, 0.5, -3.2]);
    expect(r.tags[r.tags.length - 1]).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('the camera rotation shake (#20) is cut by #18 at 1.2 s', () => {
    const r = rig();
    const restQ = r.camera.quaternion.clone();
    r.slam.play();
    r.advanceTo(0.9);
    expect(r.camera.quaternion.angleTo(restQ)).toBeGreaterThan(0);
    r.advanceTo(1.25);
    // position may still wiggle, but rotation is back at rest
    expect(r.camera.quaternion.angleTo(restQ)).toBeLessThan(1e-6);
  });

  it('stop() mid-hop restores slots, camera, cards, felt and lens', () => {
    const r = rig();
    const restPos = r.camera.position.clone();
    const restQ = r.camera.quaternion.clone();
    r.slam.play();
    r.advanceTo(1.4);
    expect(r.slotRoots[0].position.y).toBeGreaterThan(0.5); // Slot_1 mid-hop
    expect(r.card.position.toArray()).not.toEqual([0.4, 0.5, -3.2]);
    r.slam.stop();
    expect(r.slam.playing).toBe(false);
    for (const s of r.slotRoots) {
      expect(s.position.y).toBeCloseTo(0.46, 9);
      expect(s.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-9);
    }
    expect(r.camera.position.distanceTo(restPos)).toBeLessThan(1e-9);
    expect(r.camera.quaternion.angleTo(restQ)).toBeLessThan(1e-9);
    expect(r.camera.fov).toBe(60);
    expect(r.card.position.toArray()).toEqual([0.4, 0.5, -3.2]);
    expect(r.card.quaternion.angleTo(new Quaternion(0, 0, 1, 0))).toBeLessThan(1e-6);
    expect(r.felt.matrix.equals(r.feltMatrix0)).toBe(true);
    expect(r.lens.intensity).toBe(0);
    // nothing moves afterwards
    r.advanceTo(2.5);
    expect(r.slotRoots[0].position.y).toBeCloseTo(0.46, 9);
    expect(r.camera.position.distanceTo(restPos)).toBeLessThan(1e-9);
  });
});
