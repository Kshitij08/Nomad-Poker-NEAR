/**
 * Evaluates Unity AnimationCurves exactly as the Animator samples them: cubic Hermite segments built
 * from each key's in/out slopes, Bezier-style segments when either side is weighted, and constant
 * (stepped) segments when a slope is infinite.
 */

export interface Keyframe {
  time: number;
  value: number;
  inSlope: number;
  outSlope: number;
  /** 0 none, 1 in, 2 out, 3 both (Unity WeightedMode). */
  weightedMode?: number;
  inWeight?: number;
  outWeight?: number;
}

const DEFAULT_WEIGHT = 1 / 3;

function isInf(x: number | string | undefined): boolean {
  return x === Infinity || x === -Infinity || x === 'Infinity' || x === '-Infinity';
}

function hermite(k0: Keyframe, k1: Keyframe, t: number): number {
  const dt = k1.time - k0.time;
  const s = (t - k0.time) / dt;
  const m0 = k0.outSlope * dt;
  const m1 = k1.inSlope * dt;
  const s2 = s * s;
  const s3 = s2 * s;
  const a = 2 * s3 - 3 * s2 + 1;
  const b = s3 - 2 * s2 + s;
  const c = s3 - s2;
  const d = -2 * s3 + 3 * s2;
  return a * k0.value + b * m0 + c * m1 + d * k1.value;
}

/** Weighted segment: a 2D cubic Bezier in (time, value); solve x(u) = t for u, then return y(u). */
function weighted(k0: Keyframe, k1: Keyframe, t: number): number {
  const dt = k1.time - k0.time;
  const outW = k0.weightedMode === 2 || k0.weightedMode === 3 ? (k0.outWeight ?? DEFAULT_WEIGHT) : DEFAULT_WEIGHT;
  const inW = k1.weightedMode === 1 || k1.weightedMode === 3 ? (k1.inWeight ?? DEFAULT_WEIGHT) : DEFAULT_WEIGHT;
  const x0 = 0;
  const x1 = outW;
  const x2 = 1 - inW;
  const x3 = 1;
  const y0 = k0.value;
  const y1 = k0.value + k0.outSlope * dt * outW;
  const y2 = k1.value - k1.inSlope * dt * inW;
  const y3 = k1.value;
  const target = (t - k0.time) / dt;
  const bez = (p0: number, p1: number, p2: number, p3: number, u: number) => {
    const v = 1 - u;
    return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3;
  };
  // Bisection is plenty precise for animation sampling and always converges (x is monotonic for valid weights).
  let lo = 0;
  let hi = 1;
  let u = target;
  for (let i = 0; i < 30; i++) {
    const x = bez(x0, x1, x2, x3, u);
    if (Math.abs(x - target) < 1e-6) break;
    if (x < target) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return bez(y0, y1, y2, y3, u);
}

export function evaluateCurve(keys: Keyframe[], time: number): number {
  if (keys.length === 0) return 0;
  if (keys.length === 1 || time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  let i = 0;
  while (i < keys.length - 2 && time >= keys[i + 1].time) i++;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  if (isInf(k0.outSlope) || isInf(k1.inSlope)) return k0.value;
  const w0 = k0.weightedMode === 2 || k0.weightedMode === 3;
  const w1 = k1.weightedMode === 1 || k1.weightedMode === 3;
  return w0 || w1 ? weighted(k0, k1, time) : hermite(k0, k1, time);
}
