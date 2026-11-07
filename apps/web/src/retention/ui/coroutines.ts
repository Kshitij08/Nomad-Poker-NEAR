/**
 * Unity coroutines on the shared ticker (so ?speed / ?paused / __poker.step drive them like every other animation).
 * A routine is a generator that yields `null` (next frame), a number (WaitForSecondsRealtime) or another generator
 * (`yield return Tween(...)`: wait for it to finish). `host.dt` is Time.unscaledDeltaTime for the current frame and
 * `host.time` Time.unscaledTime since the host started.
 */
import { ticker, type Tween } from '../../anim/tween';

export type Routine = Generator<Yieldable, void, void>;
export type Yieldable = null | number | Routine;

interface Running {
  stack: Routine[];
  wait: number;
}

export class CoroutineHost {
  dt = 1 / 60;
  time = 0;
  private running: Running[] = [];
  private readonly tween: Tween;
  private disposed = false;

  constructor() {
    const self = this;
    this.tween = ticker.add<Tween>({
      duration: Infinity,
      get done() {
        return self.disposed;
      },
      kill() {
        self.disposed = true;
      },
      step(dt: number) {
        self.update(dt);
        return 0;
      },
      onComplete() {
        return this;
      },
      setLink() {
        return this;
      },
    });
  }

  /** StartCoroutine: runs synchronously up to the first yield, like Unity. */
  start(routine: Routine): Routine {
    const r: Running = { stack: [routine], wait: 0 };
    this.running.push(r);
    this.advance(r);
    return routine;
  }

  stop(routine: Routine | null): void {
    if (!routine) return;
    this.running = this.running.filter((r) => r.stack[0] !== routine);
  }

  stopAll(): void {
    this.running = [];
  }

  /** Per-frame callbacks (MonoBehaviour.Update); return a disposer. */
  private readonly updaters = new Set<() => void>();
  onUpdate(fn: () => void): () => void {
    this.updaters.add(fn);
    return () => this.updaters.delete(fn);
  }

  dispose(): void {
    this.disposed = true;
    this.running = [];
    this.updaters.clear();
    this.tween.kill();
  }

  private update(dt: number): void {
    if (this.disposed) return;
    this.dt = dt;
    this.time += dt;
    for (const r of [...this.running]) {
      if (!this.running.includes(r)) continue;
      if (r.wait > 0) {
        r.wait -= dt;
        if (r.wait > 0) continue;
      }
      this.advance(r);
    }
    for (const fn of [...this.updaters]) fn();
  }

  private advance(r: Running): void {
    for (;;) {
      const top = r.stack[r.stack.length - 1];
      if (!top) {
        this.running = this.running.filter((x) => x !== r);
        return;
      }
      const res = top.next();
      if (res.done) {
        r.stack.pop();
        if (!r.stack.length) {
          this.running = this.running.filter((x) => x !== r);
          return;
        }
        continue; // the parent resumes in the same frame
      }
      const v = res.value;
      if (v === null || v === undefined) return;
      if (typeof v === 'number') {
        r.wait = v;
        return;
      }
      r.stack.push(v);
    }
  }
}

/** LevelUpPanel.Tween: waits `delay`, then calls step(clamp01(t / duration)) every frame and step(1) at the end. */
export function* tweenRoutine(host: CoroutineHost, duration: number, delay: number, step: (k: number) => void): Routine {
  let d = 0;
  while (d < delay) {
    d += host.dt;
    yield null;
  }
  let t = 0;
  while (t < duration) {
    t += host.dt;
    step(Math.min(1, Math.max(0, t / duration)));
    yield null;
  }
  step(1);
}

/** LevelUpPanel.Wait. */
export function* waitRoutine(host: CoroutineHost, seconds: number): Routine {
  let d = 0;
  while (d < seconds) {
    d += host.dt;
    yield null;
  }
}

// Mathf-style helpers the Unity panels use.
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);
export const lerpUnclamped = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);
export function easeOutBack(x: number, c1 = 1.70158): number {
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
export function easeOutElastic(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
}
/** Mathf.SmoothStep. */
export function smoothStep(from: number, to: number, t: number): number {
  t = clamp01(t);
  t = -2 * t * t * t + 3 * t * t;
  return to * t + from * (1 - t);
}
