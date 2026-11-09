import { Euler, Group, MathUtils, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { lookRotation, splineAnimateDuration, splineEase, UnitySpline } from '../anim/unitySpline';
import { Ease, Ticker, ticker, type EaseFn, type Linkable, type Tween } from '../anim/tween';

/** Rank 2..14, suit 0 clubs / 1 diamonds / 2 hearts / 3 spades — the same numbering as Poker.Core.Card. */
export interface CardFace {
  rank: number;
  suit: number;
}

/** What a card looks like. The 3D layer supplies one per card (mesh + materials). */
export interface CardVisual {
  readonly object: Object3D;
  setFace(card: CardFace): void;
  setGreyedOut(): void;
  refreshBack(): void;
  dispose(): void;
}

const DEG = MathUtils.DEG2RAD;

function unityEuler(e: { x: number; y: number; z: number }): Quaternion {
  // Unity applies Z, then X, then Y — three.js order 'YXZ'.
  return new Quaternion().setFromEuler(new Euler(e.x * DEG, e.y * DEG, e.z * DEG, 'YXZ'));
}

export interface CardViewOptions {
  /** Serialized on the card prefab. The model lies flat back-up at identity; face-up is a roll around Z. */
  faceUpLocalEuler?: { x: number; y: number; z: number };
  faceDownLocalEuler?: { x: number; y: number; z: number };
}

/**
 * Port of Poker.Game.CardView: one dealt card. All transforms are Unity-space (see unitySpace.ts);
 * `transform` is parented under the dealer's DealtRoot, so localRotation here means the same thing it
 * does in the C#.
 */
export class CardView implements Linkable {
  readonly transform = new Group();
  private readonly faceUpLocalEuler: { x: number; y: number; z: number };
  private readonly faceDownLocalEuler: { x: number; y: number; z: number };
  private greyedOut = false;
  private faceUp = false;
  private destroyed = false;

  /** The spline this card was dealt along (what SplineAnimate.Container remembers). */
  private spline: UnitySpline | null = null;
  /** SplineAnimate state: playing / normalized time / enabled. */
  private animPlaying = false;
  private animEnabled = true;
  private animDuration = 0;
  private animNormalized = 0;
  private animTween: Tween | null = null;
  private flipTween: Tween | null = null;
  /**
   * Where the card is along its spline: 0 at the deck, 1 at the seat (the deal and the return both write it; a card
   * placed without a flight is at 1). Web-port only: the portrait table turns cards upright near the seat.
   */
  pathProgress = 1;

  constructor(
    readonly visual: CardVisual,
    options: CardViewOptions = {},
  ) {
    this.faceUpLocalEuler = options.faceUpLocalEuler ?? { x: 0, y: 0, z: 180 };
    this.faceDownLocalEuler = options.faceDownLocalEuler ?? { x: 0, y: 0, z: 0 };
    this.transform.name = 'Card';
    this.transform.add(visual.object);
  }

  get alive(): boolean {
    return !this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.animTween?.kill();
    this.flipTween?.kill();
    this.transform.removeFromParent();
    this.visual.dispose();
  }

  show(card: CardFace, faceUp: boolean): void {
    this.applyFace(card);
    this.faceUp = faceUp;
    this.transform.quaternion.copy(unityEuler(faceUp ? this.faceUpLocalEuler : this.faceDownLocalEuler));
  }

  setFace(card: CardFace): void {
    this.applyFace(card);
  }

  setGreyedOut(): void {
    this.greyedOut = true;
    this.visual.setGreyedOut();
  }

  refreshBack(): void {
    if (this.greyedOut) this.visual.setGreyedOut();
    else this.visual.refreshBack();
  }

  private applyFace(card: CardFace): void {
    this.visual.setFace(card);
    if (this.greyedOut) this.visual.setGreyedOut();
  }

  // ---- World/local helpers (the card's parent is DealtRoot, inside the Unity-space root) ----

  /** Ancestors between this card and the mirrored Unity root, top-most first. */
  private unityAncestors(): Object3D[] {
    const chain: Object3D[] = [];
    let p = this.transform.parent;
    while (p && p.name !== 'UnityWorld') {
      chain.unshift(p);
      p = p.parent;
    }
    return chain;
  }

  /** The parent's Unity-space world rotation. */
  private unityParentRotation(): Quaternion {
    const q = new Quaternion();
    for (const a of this.unityAncestors()) q.multiply(a.quaternion);
    return q;
  }

  /** The parent's Unity-space localToWorld matrix. */
  private unityParentMatrix(): Matrix4 {
    const m = new Matrix4();
    for (const a of this.unityAncestors()) {
      a.updateMatrix();
      m.multiply(a.matrix);
    }
    return m;
  }

  /** transform.rotation in Unity world space. */
  private worldRotationInUnity(): Quaternion {
    return this.unityParentRotation().multiply(this.transform.quaternion);
  }

  /** transform.position = world (Unity space). */
  setWorldPosition(world: Vector3): void {
    this.transform.position.copy(world.clone().applyMatrix4(this.unityParentMatrix().invert()));
  }

  /** transform.rotation = world (Unity space). */
  setWorldRotation(world: Quaternion): void {
    this.transform.quaternion.copy(this.unityParentRotation().invert().multiply(world));
  }

  /** transform.forward in Unity world space. */
  private worldForward(): Vector3 {
    return new Vector3(0, 0, 1).applyQuaternion(this.worldRotationInUnity());
  }

  // ---- Flip / settle ----

  /**
   * Rolls the card face-up/face-down while keeping the heading it has on the table — only tilt and roll
   * are corrected, as the shortest arc (DOLocalRotateQuaternion, DOTween's default ease).
   */
  flip(faceUp: boolean, duration = 0.25): Tween {
    this.faceUp = faceUp;
    this.flipTween?.kill();
    const from = this.transform.quaternion.clone();
    const to = this.settleRotation(faceUp);
    const tween = ticker.to(duration, (t) => this.transform.quaternion.slerpQuaternions(from, to, t)).setLink(this);
    this.flipTween = tween;
    return tween;
  }

  /** Same as flip() but not started on the ticker — for sequences. Reads the rotation when it starts. */
  private flipStep(faceUp: boolean, duration = 0.25): Tween {
    let from = new Quaternion();
    let to = new Quaternion();
    return detached(
      duration,
      (t) => this.transform.quaternion.slerpQuaternions(from, to, t),
      () => {
        this.faceUp = faceUp;
        from = this.transform.quaternion.clone();
        to = this.settleRotation(faceUp);
      },
    );
  }

  private settleRotation(faceUp: boolean): Quaternion {
    const target = { ...(faceUp ? this.faceUpLocalEuler : this.faceDownLocalEuler) };
    const heading = this.worldForward();
    heading.y = 0;
    if (heading.lengthSq() > 0.0001) target.y = Math.atan2(heading.x, heading.z) * MathUtils.RAD2DEG;
    return unityEuler(target);
  }

  // ---- Spline flights ----

  /**
   * Flies from the deck (spline start) to the seat (spline end), aligned to the path like SplineAnimate
   * with AlignmentMode.SplineElement, Method.Speed and EasingMode.EaseInOut. On arrival it settles flat:
   * face-up when revealAtEnd, otherwise face-down.
   */
  dealAlongSpline(spline: UnitySpline | null, card: CardFace, revealAtEnd: boolean, speed = 12, onArrive?: () => void): void {
    if (!spline) {
      this.show(card, revealAtEnd);
      onArrive?.();
      return;
    }
    this.applyFace(card);
    this.refreshBack();
    this.faceUp = false;
    this.transform.quaternion.copy(unityEuler(this.faceDownLocalEuler));

    this.spline = spline;
    this.animEnabled = true;
    this.animDuration = splineAnimateDuration(spline.length, speed, true);
    this.animNormalized = 0;
    this.applySplinePose(0); // Restart(false): snap to the deck
    this.animPlaying = true;

    this.animTween?.kill();
    this.animTween = ticker
      .to(
        this.animDuration,
        (raw) => {
          if (!this.animEnabled) return;
          this.animNormalized = splineEase.inOut(raw);
          this.applySplinePose(this.animNormalized);
        },
        Ease.Linear,
      )
      .setLink(this)
      .onComplete(() => {
        this.animPlaying = false;
        if (!this.animEnabled) return;
        this.flip(revealAtEnd);
        this.refreshBack();
        onArrive?.();
      });
  }

  /** SplineAnimate.EvaluatePositionAndRotation for SplineElement alignment (default axes: Z forward, Y up). */
  private applySplinePose(t: number): void {
    const spline = this.spline;
    if (!spline) return;
    this.pathProgress = t;
    this.setWorldPosition(spline.evaluatePosition(t));
    let forward = spline.evaluateTangent(t);
    if (forward.length() <= Number.EPSILON) forward = spline.evaluateTangent(t < 1 ? Math.min(1, t + 0.01) : t - 0.01);
    forward.normalize();
    const up = spline.evaluateUpVector(t);
    if (Number.isFinite(forward.x) && Number.isFinite(up.x)) this.setWorldRotation(lookRotation(forward, up));
  }

  /**
   * Moves this card onto another spline (the table rotated under it). In flight: keeps flying from the
   * same normalized point. Landed: snaps to the new end and settles flat again.
   */
  retargetSpline(spline: UnitySpline | null): void {
    if (!spline) return;
    if (!this.spline) {
      this.setWorldPosition(spline.evaluatePosition(1));
      return;
    }
    if (!this.animEnabled) return; // already returning to the deck
    const inFlight = this.animPlaying;
    this.spline = spline;
    const t = inFlight ? Math.min(1, Math.max(0, this.animNormalized)) : 1;
    this.applySplinePose(t);
    if (!inFlight) this.transform.quaternion.copy(this.settleRotation(this.faceUp));
  }

  /**
   * The deal in reverse: flip back-up, then fly from the seat to the deck along the dealt spline over
   * length / speed seconds (InOutQuad), banking with the path. Destroying the card mid-return is safe.
   */
  returnAlongSpline(speed = 12, onArrive?: () => void): void {
    const spline = this.spline;
    if (!spline) {
      onArrive?.();
      return;
    }
    this.animEnabled = false;
    this.animTween?.kill();
    this.flipTween?.kill();
    const length = spline.length;
    const duration = speed > 0 && length > 0 ? length / speed : 0.4;

    ticker
      .sequence()
      .append(0.25, () => this.flipStep(false))
      .append(duration, () =>
        detached(
          duration,
          (e) => {
            const t = 1 - e; // DOVirtual.Float(1, 0, ...)
            this.pathProgress = t;
            this.setWorldPosition(spline.evaluatePosition(t));
            const tangent = spline.evaluateTangent(t);
            if (tangent.lengthSq() > 0.0001) this.setWorldRotation(lookRotation(tangent, spline.evaluateUpVector(t)));
          },
          undefined,
          Ease.InOutQuad,
        ),
      )
      .play()
      .setLink(this)
      .onComplete(() => onArrive?.());
  }
}

function detached(duration: number, update: (t: number) => void, onStart?: () => void, ease?: EaseFn): Tween {
  return Ticker.detached(duration, update, ease, onStart);
}
