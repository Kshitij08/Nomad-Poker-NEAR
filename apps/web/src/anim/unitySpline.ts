import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';

/**
 * A port of the parts of com.unity.splines the card animations use, kept numerically faithful:
 *
 * - Knots are BezierKnots: tangentIn/tangentOut live in knot-local space and are rotated by the knot's
 *   rotation. A curve between knots a and b is P0 = a.pos, P1 = a.pos + a.rot*a.tangentOut,
 *   P2 = b.pos + b.rot*b.tangentIn, P3 = b.pos.
 * - Normalized spline t is arc-length based: t*length picks the curve, then a 30-entry distance→t lookup
 *   table per curve gives the curve t (SplineUtility.SplineToCurveT + Spline.GetCurveInterpolation).
 * - Up vectors come from a 30-entry table per curve, each entry built from 16 rotation-minimizing frames
 *   with the end-knot mismatch spread across the curve (CurveUtility.EvaluateUpVector), linearly lerped.
 * - Everything is evaluated in the container's local space, then moved to world space the way
 *   SplineContainer does: TransformPoint for positions, TransformVector for tangents, TransformDirection
 *   (rotation only) for up vectors.
 *
 * All values are in Unity's left-handed world space. The renderer converts once, at the scene root.
 */

export type V3 = { x: number; y: number; z: number };
export type Q4 = { x: number; y: number; z: number; w: number };

export interface KnotData {
  position: V3;
  tangentIn: V3;
  tangentOut: V3;
  rotation: Q4;
}

export interface SplineData {
  name?: string;
  closed?: boolean;
  knots: KnotData[];
  /** The container's localToWorld matrix, column-major (Unity Matrix4x4 m00,m10,m20,m30,m01,...). */
  worldMatrix: number[];
}

const LUT_RESOLUTION = 30; // Spline.k_CurveDistanceLutResolution
const NORMALS_PER_CURVE = 16; // CurveUtility.k_NormalsPerCurve
const UP = new Vector3(0, 1, 0);

interface Curve {
  p0: Vector3;
  p1: Vector3;
  p2: Vector3;
  p3: Vector3;
}

interface CurveMeta {
  lut: { distance: number; t: number }[];
  ups: Vector3[];
  length: number;
}

function v(o: V3): Vector3 {
  return new Vector3(o.x, o.y, o.z);
}

function q(o: Q4): Quaternion {
  return new Quaternion(o.x, o.y, o.z, o.w);
}

export function bezierPosition(c: Curve, t: number, out = new Vector3()): Vector3 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const cc = 3 * u * t * t;
  const d = t * t * t;
  return out.set(
    c.p0.x * a + c.p1.x * b + c.p2.x * cc + c.p3.x * d,
    c.p0.y * a + c.p1.y * b + c.p2.y * cc + c.p3.y * d,
    c.p0.z * a + c.p1.z * b + c.p2.z * cc + c.p3.z * d,
  );
}

export function bezierTangent(c: Curve, tIn: number, out = new Vector3()): Vector3 {
  const t = Math.min(1, Math.max(0, tIn));
  const t2 = t * t;
  const k0 = -3 * t2 + 6 * t - 3;
  const k1 = 9 * t2 - 12 * t + 3;
  const k2 = -9 * t2 + 6 * t;
  const k3 = 3 * t2;
  return out.set(
    c.p0.x * k0 + c.p1.x * k1 + c.p2.x * k2 + c.p3.x * k3,
    c.p0.y * k0 + c.p1.y * k1 + c.p2.y * k2 + c.p3.y * k3,
    c.p0.z * k0 + c.p1.z * k1 + c.p2.z * k2 + c.p3.z * k3,
  );
}

function approximately(a: number, b: number): boolean {
  return Math.abs(b - a) < Math.max(0.000001 * Math.max(Math.abs(a), Math.abs(b)), 0.0001 * 8);
}

/** Vector3.Slerp: slerps direction and lerps magnitude. Inputs here are unit normals. */
function slerpDir(a: Vector3, b: Vector3, t: number): Vector3 {
  const la = a.length();
  const lb = b.length();
  if (la < 1e-8 || lb < 1e-8) return a.clone().lerp(b, t);
  const na = a.clone().divideScalar(la);
  const nb = b.clone().divideScalar(lb);
  const dot = Math.min(1, Math.max(-1, na.dot(nb)));
  const theta = Math.acos(dot) * t;
  const rel = nb.sub(na.clone().multiplyScalar(dot));
  if (rel.lengthSq() < 1e-12) return na.multiplyScalar(la + (lb - la) * t);
  rel.normalize();
  return na
    .multiplyScalar(Math.cos(theta))
    .add(rel.multiplyScalar(Math.sin(theta)))
    .multiplyScalar(la + (lb - la) * t);
}

interface Frame {
  origin: Vector3;
  tangent: Vector3;
  normal: Vector3;
  binormal: Vector3;
}

function nextRotationMinimizingFrame(curve: Curve, prev: Frame, t: number): Frame {
  const origin = bezierPosition(curve, t);
  const tangent = bezierTangent(curve, t);
  const toCurrent = origin.clone().sub(prev.origin);
  const c1 = toCurrent.dot(toCurrent);
  const riL = prev.binormal.clone().sub(toCurrent.clone().multiplyScalar((2 / c1) * toCurrent.dot(prev.binormal)));
  const tiL = prev.tangent.clone().sub(toCurrent.clone().multiplyScalar((2 / c1) * toCurrent.dot(prev.tangent)));
  const v2 = tangent.clone().sub(tiL);
  const c2 = v2.dot(v2);
  const binormal = riL.clone().sub(v2.clone().multiplyScalar((2 / c2) * v2.dot(riL))).normalize();
  const normal = new Vector3().crossVectors(binormal, tangent).normalize();
  return { origin, tangent, normal, binormal };
}

/** CurveUtility.EvaluateUpVector (fixEndUpMismatch = true). */
function curveUpVector(curveIn: Curve, t: number, startUp: Vector3, endUp: Vector3): Vector3 {
  const curve: Curve = { p0: curveIn.p0.clone(), p1: curveIn.p1.clone(), p2: curveIn.p2.clone(), p3: curveIn.p3.clone() };
  const linearTangentLen = curve.p3.clone().sub(curve.p0).divideScalar(3).length();
  const linearTangentOut = curve.p3.clone().sub(curve.p0).normalize().multiplyScalar(linearTangentLen);
  if (approximately(curve.p1.distanceTo(curve.p0), 0)) curve.p1 = curve.p0.clone().add(linearTangentOut);
  if (approximately(curve.p2.distanceTo(curve.p3), 0)) curve.p2 = curve.p3.clone().sub(linearTangentOut);

  const normals: Vector3[] = new Array(NORMALS_PER_CURVE);
  let frame: Frame = {
    origin: curve.p0.clone(),
    tangent: curve.p1.clone().sub(curve.p0),
    normal: startUp.clone(),
    binormal: new Vector3(),
  };
  frame.binormal.crossVectors(frame.tangent, frame.normal).normalize();
  if (Number.isNaN(frame.binormal.x) || frame.binormal.lengthSq() === 0) return new Vector3();
  normals[0] = frame.normal.clone();

  const step = 1 / (NORMALS_PER_CURVE - 1);
  let currentT = step;
  let prevT = 0;
  let up = new Vector3();
  for (let i = 1; i < NORMALS_PER_CURVE; i++) {
    const prevFrame = frame;
    frame = nextRotationMinimizingFrame(curve, prevFrame, currentT);
    normals[i] = frame.normal.clone();
    if (prevT <= t && currentT >= t) up = slerpDir(prevFrame.normal, frame.normal, (t - prevT) / step);
    prevT = currentT;
    currentT += step;
  }

  if (prevT <= t && currentT >= t) up = endUp.clone();

  const lastNormal = normals[NORMALS_PER_CURVE - 1];
  let angle = Math.acos(Math.min(1, Math.max(-1, lastNormal.dot(endUp))));
  if (angle === 0) return up;

  const lastTangent = frame.tangent.clone().normalize();
  const pos = endUp.clone().applyQuaternion(new Quaternion().setFromAxisAngle(lastTangent, angle));
  const neg = endUp.clone().applyQuaternion(new Quaternion().setFromAxisAngle(lastTangent, -angle));
  const posResult = Math.acos(Math.min(1, Math.max(-1, pos.dot(lastNormal))));
  const negResult = Math.acos(Math.min(1, Math.max(-1, neg.dot(lastNormal))));
  if (posResult > negResult) angle *= -1;

  currentT = step;
  prevT = 0;
  for (let i = 1; i < normals.length; i++) {
    const adjust = angle * currentT;
    const tangent = bezierTangent(curve, currentT).normalize();
    normals[i] = normals[i].clone().applyQuaternion(new Quaternion().setFromAxisAngle(tangent, -adjust));
    if (prevT <= t && currentT >= t) return slerpDir(normals[i - 1], normals[i], (t - prevT) / step);
    prevT = currentT;
    currentT += step;
  }
  return endUp.clone();
}

export class UnitySpline {
  readonly name: string;
  readonly closed: boolean;
  readonly knots: { position: Vector3; tangentIn: Vector3; tangentOut: Vector3; rotation: Quaternion }[];
  readonly curves: Curve[] = [];
  readonly world = new Matrix4();
  private readonly world3 = new Matrix3();
  private readonly worldRotation = new Quaternion();
  private readonly meta: CurveMeta[] = [];
  /** Length in the container's local space (what Unity's t mapping uses). */
  readonly localLength: number;

  constructor(data: SplineData) {
    this.name = data.name ?? 'spline';
    this.closed = !!data.closed;
    this.knots = data.knots.map((k) => ({
      position: v(k.position),
      tangentIn: v(k.tangentIn),
      tangentOut: v(k.tangentOut),
      rotation: q(k.rotation).normalize(),
    }));
    this.world.fromArray(data.worldMatrix);
    this.world3.setFromMatrix4(this.world);
    const s = new Vector3();
    this.world.decompose(new Vector3(), this.worldRotation, s);

    const count = this.closed ? this.knots.length : this.knots.length - 1;
    for (let i = 0; i < count; i++) {
      const a = this.knots[i];
      const b = this.knots[(i + 1) % this.knots.length];
      this.curves.push({
        p0: a.position.clone(),
        p1: a.position.clone().add(a.tangentOut.clone().applyQuaternion(a.rotation)),
        p2: b.position.clone().add(b.tangentIn.clone().applyQuaternion(b.rotation)),
        p3: b.position.clone(),
      });
    }

    let total = 0;
    this.curves.forEach((c, i) => {
      const lut: { distance: number; t: number }[] = [{ distance: 0, t: 0 }];
      let mag = 0;
      let prev = bezierPosition(c, 0);
      for (let j = 1; j < LUT_RESOLUTION; j++) {
        const t = j / (LUT_RESOLUTION - 1);
        const p = bezierPosition(c, t);
        mag += p.distanceTo(prev);
        lut.push({ distance: mag, t });
        prev = p;
      }
      const a = this.knots[i];
      const b = this.knots[(i + 1) % this.knots.length];
      const startUp = UP.clone().applyQuaternion(a.rotation);
      const endUp = UP.clone().applyQuaternion(b.rotation);
      const ups: Vector3[] = [startUp];
      for (let j = 1; j < LUT_RESOLUTION - 1; j++) ups.push(curveUpVector(c, j / (LUT_RESOLUTION - 1), startUp, endUp));
      ups.push(endUp);
      this.meta.push({ lut, ups, length: mag });
      total += mag;
    });
    this.localLength = total;
  }

  /** World-space length, as SplineContainer.CalculateLength reports it. */
  get length(): number {
    // Uniform scale assumed (non-uniform containers bake a native spline in Unity; not used by the table).
    const sx = new Vector3().setFromMatrixColumn(this.world, 0).length();
    return this.localLength * sx;
  }

  /** SplineUtility.SplineToCurveT with the distance LUT. */
  private splineToCurveT(splineT: number): { index: number; t: number } {
    if (this.knots.length <= 1) return { index: 0, t: 0 };
    const tLength = Math.min(1, Math.max(0, splineT)) * this.localLength;
    let start = 0;
    for (let i = 0; i < this.curves.length; i++) {
      const len = this.meta[i].length;
      if (tLength <= start + len) return { index: i, t: this.distanceToT(i, tLength - start) };
      start += len;
    }
    return { index: this.curves.length - 1, t: 1 };
  }

  private distanceToT(index: number, distance: number): number {
    const lut = this.meta[index].lut;
    if (distance <= 0) return 0;
    const len = lut[lut.length - 1].distance;
    if (distance >= len) return 1;
    let prev = lut[0];
    for (let i = 1; i < lut.length; i++) {
      const cur = lut[i];
      if (distance < cur.distance) return prev.t + (cur.t - prev.t) * ((distance - prev.distance) / (cur.distance - prev.distance));
      prev = cur;
    }
    return 1;
  }

  private curveUp(index: number, t: number): Vector3 {
    const ups = this.meta[index].ups;
    const offset = 1 / (ups.length - 1);
    let curveT = 0;
    for (let i = 0; i < ups.length - 1; i++) {
      if (t <= curveT + offset) return ups[i].clone().lerp(ups[i + 1], (t - curveT) / offset);
      curveT += offset;
    }
    return ups[ups.length - 1].clone();
  }

  evaluatePosition(t: number, out = new Vector3()): Vector3 {
    const { index, t: ct } = this.splineToCurveT(t);
    return bezierPosition(this.curves[index], ct, out).applyMatrix4(this.world);
  }

  evaluateTangent(t: number, out = new Vector3()): Vector3 {
    const { index, t: ct } = this.splineToCurveT(t);
    return bezierTangent(this.curves[index], ct, out).applyMatrix3(this.world3);
  }

  evaluateUpVector(t: number, out = new Vector3()): Vector3 {
    const { index, t: ct } = this.splineToCurveT(t);
    return out.copy(this.curveUp(index, ct)).applyQuaternion(this.worldRotation);
  }
}

/** Quaternion.LookRotation with Unity's conventions (local +Z → forward, local +Y → up). */
export function lookRotation(forward: Vector3, up: Vector3, out = new Quaternion()): Quaternion {
  const z = forward.clone().normalize();
  let x = new Vector3().crossVectors(up, z);
  if (x.lengthSq() < 1e-12) {
    // Forward parallel to up: Unity falls back to a rotation from +Z to forward.
    return out.setFromUnitVectors(new Vector3(0, 0, 1), z);
  }
  x.normalize();
  const y = new Vector3().crossVectors(z, x);
  return out.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/** SplineAnimate's quadratic eases. */
export const splineEase = {
  in: (t: number) => t * t,
  out: (t: number) => t * (2 - t),
  inOut: (t: number) => {
    const e = 2 * t * t;
    return t > 0.5 ? 4 * t - e - 1 : e;
  },
};

/**
 * SplineAnimate duration for Method.Speed: length / maxSpeed with no easing, and twice that with
 * EaseIn / EaseOut / EaseInOut (average speed is half of max).
 */
export function splineAnimateDuration(length: number, maxSpeed: number, eased = true): number {
  if (maxSpeed <= 0) return 0;
  return (eased ? 2 : 1) * (length / maxSpeed);
}
