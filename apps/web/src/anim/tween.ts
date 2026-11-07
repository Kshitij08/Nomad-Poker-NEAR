/**
 * A small stand-in for the DOTween features the Unity client uses: value tweens with DOTween's ease
 * formulas, DOVirtual.DelayedCall, sequences (Append / AppendInterval / AppendCallback), and SetLink
 * (a tween dies with the object it is linked to). Driven by one ticker the render loop advances.
 */

export type EaseFn = (t: number) => number;

/** DOTween's ease formulas (DG.Tweening.Core.Easing.EaseManager), normalized to t in [0,1]. */
export const Ease = {
  Linear: (t: number) => t,
  InSine: (t: number) => -Math.cos(t * (Math.PI / 2)) + 1,
  OutSine: (t: number) => Math.sin(t * (Math.PI / 2)),
  InOutSine: (t: number) => -0.5 * (Math.cos(Math.PI * t) - 1),
  InQuad: (t: number) => t * t,
  OutQuad: (t: number) => -t * (t - 2),
  InOutQuad: (t: number) => ((t *= 2) < 1 ? 0.5 * t * t : -0.5 * (--t * (t - 2) - 1)),
  InCubic: (t: number) => t * t * t,
  OutCubic: (t: number) => (t = t - 1) * t * t + 1,
  InOutCubic: (t: number) => ((t *= 2) < 1 ? 0.5 * t * t * t : 0.5 * ((t -= 2) * t * t + 2)),
  OutBack: (t: number, s = 1.70158) => (t = t - 1) * t * ((s + 1) * t + s) + 1,
  InBack: (t: number, s = 1.70158) => t * t * ((s + 1) * t - s),
  OutElastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    const p = 0.3;
    const s = p / 4;
    return Math.pow(2, -10 * t) * Math.sin(((t - s) * (2 * Math.PI)) / p) + 1;
  },
  OutBounce: (t: number) => {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
    if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
    return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
  },
} satisfies Record<string, EaseFn>;

/** DOTween's out-of-the-box default ease (DOTween.defaultEaseType). */
export const DEFAULT_EASE: EaseFn = Ease.OutQuad;

/** Anything a tween can be linked to: once `alive` turns false the tween is killed silently. */
export interface Linkable {
  readonly alive: boolean;
}

export interface Tween {
  readonly duration: number;
  readonly done: boolean;
  kill(complete?: boolean): void;
  /** Internal: advance; returns leftover time once finished (for sequences). */
  step(dt: number): number;
  onComplete(fn: () => void): Tween;
  setLink(target: Linkable): Tween;
}

abstract class BaseTween implements Tween {
  protected elapsed = 0;
  private completeFns: (() => void)[] = [];
  protected link?: Linkable;
  done = false;
  abstract readonly duration: number;

  protected abstract apply(elapsed: number): void;

  step(dt: number): number {
    if (this.done) return dt;
    if (this.link && !this.link.alive) {
      this.done = true;
      return 0;
    }
    this.elapsed += dt;
    const finished = this.elapsed >= this.duration;
    this.apply(Math.min(this.elapsed, this.duration));
    if (finished) {
      this.done = true;
      const leftover = this.elapsed - this.duration;
      for (const fn of this.completeFns) fn();
      return leftover;
    }
    return 0;
  }

  /** Marks the tween finished and fires its completion callbacks; returns the leftover time. */
  protected finish(leftover: number): number {
    if (this.link && !this.link.alive) {
      this.done = true;
      return 0;
    }
    this.done = true;
    for (const fn of this.completeFns) fn();
    return leftover;
  }

  kill(complete = false): void {
    if (this.done) return;
    if (complete) {
      this.apply(this.duration);
      this.done = true;
      for (const fn of this.completeFns) fn();
    } else {
      this.done = true;
    }
  }

  onComplete(fn: () => void): Tween {
    this.completeFns.push(fn);
    return this;
  }

  setLink(target: Linkable): Tween {
    this.link = target;
    return this;
  }
}

class ValueTween extends BaseTween {
  private started = false;
  constructor(
    readonly duration: number,
    private readonly update: (t: number) => void,
    private readonly ease: EaseFn,
    private readonly onStart?: () => void,
  ) {
    super();
  }
  protected apply(elapsed: number): void {
    if (!this.started) {
      this.started = true;
      this.onStart?.();
    }
    const raw = this.duration > 0 ? elapsed / this.duration : 1;
    this.update(this.ease(raw));
  }
}

class Sequence extends BaseTween {
  private readonly items: (() => Tween)[] = [];
  private current?: Tween;
  private index = 0;
  private total = 0;
  get duration(): number {
    return this.total;
  }
  append(make: () => Tween, duration: number): this {
    this.items.push(make);
    this.total += duration;
    return this;
  }
  protected apply(): void {
    /* children do the work */
  }
  step(dt: number): number {
    if (this.done) return dt;
    if (this.link && !this.link.alive) {
      this.kill();
      return 0;
    }
    let left = dt;
    for (;;) {
      if (!this.current) {
        if (this.index >= this.items.length) return this.finish(left);
        this.current = this.items[this.index++]();
      }
      left = this.current.step(left);
      if (!this.current.done) return 0;
      this.current = undefined;
    }
  }
  kill(complete = false): void {
    this.current?.kill(complete);
    super.kill(complete);
  }
}

/** The single clock every tween runs on. */
export class Ticker {
  private tweens: Tween[] = [];
  timeScale = 1;

  add<T extends Tween>(t: T): T {
    this.tweens.push(t);
    return t;
  }

  update(dt: number): void {
    const d = dt * this.timeScale;
    const list = this.tweens;
    this.tweens = [];
    for (const t of list) {
      if (!t.done) t.step(d);
      if (!t.done) this.tweens.push(t);
    }
  }

  killAll(): void {
    for (const t of this.tweens) t.kill();
    this.tweens = [];
  }

  /** DOVirtual.Float / a generic tween; `update` gets the eased 0→1 progress. */
  to(duration: number, update: (t: number) => void, ease: EaseFn = DEFAULT_EASE, onStart?: () => void): Tween {
    return this.add(new ValueTween(duration, update, ease, onStart));
  }

  /** DOVirtual.DelayedCall. */
  delayedCall(delay: number, fn: () => void): Tween {
    return this.add(new ValueTween(delay, () => {}, Ease.Linear)).onComplete(fn);
  }

  /** Builds a sequence: pass factories so each step reads the state at the moment it starts. */
  sequence(): SequenceBuilder {
    const seq = new Sequence();
    const builder: SequenceBuilder = {
      append: (duration, make) => {
        seq.append(() => make(), duration);
        return builder;
      },
      interval: (duration) => {
        seq.append(() => new ValueTween(duration, () => {}, Ease.Linear), duration);
        return builder;
      },
      callback: (fn) => {
        seq.append(() => {
          fn();
          return new ValueTween(0, () => {}, Ease.Linear);
        }, 0);
        return builder;
      },
      play: () => this.add(seq),
    };
    return builder;
  }

  /** A detached tween for sequence steps (not registered on the ticker). */
  static detached(duration: number, update: (t: number) => void, ease: EaseFn = DEFAULT_EASE, onStart?: () => void): Tween {
    return new ValueTween(duration, update, ease, onStart);
  }
}

export interface SequenceBuilder {
  append(duration: number, make: () => Tween): SequenceBuilder;
  interval(duration: number): SequenceBuilder;
  callback(fn: () => void): SequenceBuilder;
  play(): Tween;
}

export const ticker = new Ticker();
