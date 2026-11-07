import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { lookRotation, splineAnimateDuration, splineEase, UnitySpline } from '../unitySpline';
import { Ticker } from '../tween';

const I = new Matrix4().toArray();
const qI = { x: 0, y: 0, z: 0, w: 1 };
const zero = { x: 0, y: 0, z: 0 };

describe('UnitySpline', () => {
  it('evaluates a straight two-knot spline uniformly by arc length', () => {
    const s = new UnitySpline({
      knots: [
        { position: { x: 0, y: 0, z: 0 }, tangentIn: zero, tangentOut: { x: 0, y: 0, z: 1 }, rotation: qI },
        { position: { x: 0, y: 0, z: 9 }, tangentIn: { x: 0, y: 0, z: -1 }, tangentOut: zero, rotation: qI },
      ],
      worldMatrix: I,
    });
    expect(s.length).toBeCloseTo(9, 3);
    // Bezier parameter would bunch up near the knots; arc-length t must not.
    expect(s.evaluatePosition(0.5).z).toBeCloseTo(4.5, 2);
    expect(s.evaluatePosition(0.25).z).toBeCloseTo(2.25, 1);
    expect(s.evaluateUpVector(0.5).y).toBeCloseTo(1, 4);
  });

  it('applies the container transform (translation + uniform scale + rotation)', () => {
    const m = new Matrix4().compose(new Vector3(1, 2, 3), lookRotation(new Vector3(1, 0, 0), new Vector3(0, 1, 0)), new Vector3(2, 2, 2));
    const s = new UnitySpline({
      knots: [
        { position: zero, tangentIn: zero, tangentOut: { x: 0, y: 0, z: 1 }, rotation: qI },
        { position: { x: 0, y: 0, z: 3 }, tangentIn: { x: 0, y: 0, z: -1 }, tangentOut: zero, rotation: qI },
      ],
      worldMatrix: m.toArray(),
    });
    expect(s.length).toBeCloseTo(6, 3);
    const end = s.evaluatePosition(1);
    expect(end.x).toBeCloseTo(7, 3);
    expect(end.y).toBeCloseTo(2, 3);
    expect(end.z).toBeCloseTo(3, 3);
    expect(s.evaluateTangent(0.5).normalize().x).toBeCloseTo(1, 3);
  });

  it('keeps the up vector continuous on a curved, banked path', () => {
    const tilt = { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) }; // 45° roll at the end
    const s = new UnitySpline({
      knots: [
        { position: zero, tangentIn: zero, tangentOut: { x: 0, y: 1, z: 2 }, rotation: qI },
        { position: { x: 4, y: 0, z: 4 }, tangentIn: { x: 0, y: 0, z: -2 }, tangentOut: zero, rotation: tilt },
      ],
      worldMatrix: I,
    });
    let prev = s.evaluateUpVector(0);
    for (let i = 1; i <= 40; i++) {
      const up = s.evaluateUpVector(i / 40);
      expect(up.angleTo(prev)).toBeLessThan(0.2);
      prev = up;
    }
  });
});

describe('SplineAnimate timing', () => {
  it('uses quadratic ease-in-out and doubles duration when eased', () => {
    expect(splineEase.inOut(0.25)).toBeCloseTo(0.125);
    expect(splineEase.inOut(0.75)).toBeCloseTo(0.875);
    expect(splineAnimateDuration(6, 12, true)).toBeCloseTo(1);
    expect(splineAnimateDuration(6, 12, false)).toBeCloseTo(0.5);
  });
});

describe('Ticker', () => {
  it('runs sequence steps in order and carries leftover time', () => {
    const t = new Ticker();
    const log: string[] = [];
    t.sequence()
      .append(0.25, () => Ticker.detached(0.25, () => {}, undefined, () => log.push('a')))
      .callback(() => log.push('cb'))
      .append(0.5, () => Ticker.detached(0.5, () => {}, undefined, () => log.push('b')))
      .play()
      .onComplete(() => log.push('done'));
    t.update(0.3);
    expect(log).toEqual(['a', 'cb', 'b']);
    t.update(0.5);
    expect(log).toEqual(['a', 'cb', 'b', 'done']);
  });

  it('kills linked tweens when the target dies', () => {
    const t = new Ticker();
    const target = { alive: true };
    let hits = 0;
    t.delayedCall(0.1, () => hits++).setLink(target);
    target.alive = false;
    t.update(1);
    expect(hits).toBe(0);
  });
});
