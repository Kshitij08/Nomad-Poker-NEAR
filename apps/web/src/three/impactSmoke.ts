import { Group, Object3D, SRGBColorSpace, Sprite, SpriteMaterial, TextureLoader, type Texture } from 'three';
import { evaluateCurve, type Keyframe } from '../anim/animCurve';
import { ticker, type Linkable, type Ticker, type Tween } from '../anim/tween';
import type { Rng } from '../anim/feel';

/**
 * Assets/Test/VFX/VFX_Impact_Smoke.prefab, with the Test.unity overrides both instances share
 * (ShapeModule.type = 10 Circle, radiusThickness = 1). One ParticleSystem, not looping:
 *  - burst of 20 at t = 0, startLifetime 0.3 s, startSpeed 20, startSize random 0.2..0.5,
 *    startRotation random 0..2pi, gravity 0, white;
 *  - Circle shape, radius 0.0001, arc 360: every puff starts at the centre and flies radially in the
 *    emitter's local XY plane (the node is rotated -90 deg about X, so that is the felt plane);
 *  - Limit Velocity: speed limit 1, dampen 0.3, drag 0.05 x size x velocity;
 *  - Size over Lifetime curve (0,0) -> (0.631, 0.993) -> (1, 0);
 *  - billboard renderer, material "cfxr ww smoke bright hdr ab" (alpha blended, texture copied to
 *    public/assets/vfx/cfxr-ww-smoke-bright.png).
 *
 * Approximations: Unity's limit-velocity dampen is applied here as a frame-rate independent
 * 1 - (1 - 0.3)^(dt * 60) per frame; drag uses the start size; the CFXR soft-particle fade and
 * "HDR" tint are not reproduced (soft particles are off at the project's active quality level);
 * puffs are three.js Sprites (one material each, for per-puff rotation).
 */
export const IMPACT_SMOKE = {
  burstCount: 20,
  lifetime: 0.3,
  startSpeed: 20,
  startSizeMin: 0.2,
  startSizeMax: 0.5,
  speedLimit: 1,
  dampen: 0.3,
  drag: 0.05,
  sizeOverLifetime: [
    { time: 0, value: 0, inSlope: 0, outSlope: 0 },
    { time: 0.63094693, value: 0.99279994, inSlope: 1.2745562, outSlope: 1.2745562 },
    { time: 1, value: 0, inSlope: 0, outSlope: 0 },
  ] as Keyframe[],
  texture: 'assets/vfx/cfxr-ww-smoke-bright.png',
};

interface Puff {
  sprite: Sprite;
  dirX: number;
  dirY: number;
  speed: number;
  age: number;
  size: number;
  x: number;
  y: number;
}

let sharedTexture: Texture | null = null;
function smokeTexture(): Texture {
  if (!sharedTexture) {
    sharedTexture = new TextureLoader().load(`${import.meta.env.BASE_URL}${IMPACT_SMOKE.texture}`);
    sharedTexture.colorSpace = SRGBColorSpace;
  }
  return sharedTexture;
}

/** Speed after one frame of Limit Velocity (dampen toward the limit, plus size/velocity drag). */
export function limitVelocityStep(speed: number, size: number, dt: number): number {
  let s = speed;
  if (s > IMPACT_SMOKE.speedLimit) {
    const k = 1 - Math.pow(1 - IMPACT_SMOKE.dampen, dt * 60);
    s -= (s - IMPACT_SMOKE.speedLimit) * k;
  }
  s -= IMPACT_SMOKE.drag * size * s * s * dt;
  return Math.max(0, s);
}

/** One VFX_Impact_Smoke particle system, parented to the emitter node (Unity space). */
export class ImpactSmoke {
  readonly group = new Group();
  private readonly puffs: Puff[] = [];
  private texture: Texture | null;

  constructor(
    parent: Object3D,
    private readonly rng: Rng = Math.random,
    texture?: Texture,
  ) {
    this.group.name = 'VFX_Impact_Smoke/particles';
    this.texture = texture ?? null;
    parent.add(this.group);
  }

  get alive(): boolean {
    return this.puffs.length > 0;
  }

  /** ParticleSystem.Play(): the t = 0 burst. */
  play(): void {
    this.texture ??= smokeTexture();
    for (let i = 0; i < IMPACT_SMOKE.burstCount; i++) {
      const a = this.rng() * Math.PI * 2;
      const size = IMPACT_SMOKE.startSizeMin + (IMPACT_SMOKE.startSizeMax - IMPACT_SMOKE.startSizeMin) * this.rng();
      const material = new SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, rotation: this.rng() * Math.PI * 2 });
      const sprite = new Sprite(material);
      sprite.scale.set(0, 0, 1);
      this.group.add(sprite);
      this.puffs.push({ sprite, dirX: Math.cos(a), dirY: Math.sin(a), speed: IMPACT_SMOKE.startSpeed, age: 0, size, x: 0, y: 0 });
    }
  }

  update(dt: number): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      if (p.age >= IMPACT_SMOKE.lifetime) {
        this.remove(i);
        continue;
      }
      p.speed = limitVelocityStep(p.speed, p.size, dt);
      p.x += p.dirX * p.speed * dt;
      p.y += p.dirY * p.speed * dt;
      const s = p.size * evaluateCurve(IMPACT_SMOKE.sizeOverLifetime, p.age / IMPACT_SMOKE.lifetime);
      p.sprite.position.set(p.x, p.y, 0);
      p.sprite.scale.set(s, s, 1);
    }
  }

  /** Stop + clear. */
  clear(): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) this.remove(i);
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }

  private remove(i: number): void {
    const p = this.puffs[i];
    p.sprite.removeFromParent();
    p.sprite.material.dispose();
    this.puffs.splice(i, 1);
  }
}

/** A tween that calls `fn(dt)` every ticker frame until it returns false or is killed. */
export class FrameDriver implements Tween {
  readonly duration = Infinity;
  done = false;
  private link?: Linkable;
  private completeFns: (() => void)[] = [];
  constructor(private readonly fn: (dt: number) => boolean) {}
  step(dt: number): number {
    if (this.done) return dt;
    if ((this.link && !this.link.alive) || !this.fn(dt)) this.finish();
    return 0;
  }
  kill(complete = false): void {
    if (this.done) return;
    if (complete) this.finish();
    else this.done = true;
  }
  onComplete(fn: () => void): Tween {
    this.completeFns.push(fn);
    return this;
  }
  setLink(target: Linkable): Tween {
    this.link = target;
    return this;
  }
  private finish(): void {
    this.done = true;
    for (const f of this.completeFns) f();
  }
}

/**
 * Slot_4's VFX_Impact_Smoke has playOnAwake = 1 and is switched on by the Slot_04 clip at 1.75 s
 * (m_IsActive), so it bursts whenever that node turns visible. This watches the node and plays on
 * each false -> true edge. Returns a disposer.
 */
export function watchActivationSmoke(node: Object3D, clock: Ticker = ticker, rng: Rng = Math.random): () => void {
  const smoke = new ImpactSmoke(node, rng);
  let wasVisible = isShown(node);
  const driver = clock.add(
    new FrameDriver((dt) => {
      const shown = isShown(node);
      if (shown && !wasVisible) smoke.play();
      if (!shown && smoke.alive) smoke.clear();
      wasVisible = shown;
      smoke.update(dt);
      return true;
    }),
  );
  return () => {
    driver.kill();
    smoke.dispose();
  };
}

function isShown(o: Object3D): boolean {
  for (let n: Object3D | null = o; n; n = n.parent) if (!n.visible) return false;
  return true;
}
