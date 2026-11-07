import { Group, Object3D } from 'three';
import { ticker } from '../anim/tween';
import type { UnitySpline } from '../anim/unitySpline';
import { CardView, type CardFace, type CardViewOptions, type CardVisual } from './cardView';

/** A pre-placed, Animator-driven community card slot (Slot_1..Slot_5). */
export interface CommunitySlot {
  readonly root: Object3D;
  /** SetActive(true): shows the slot and restarts its Animator at the reveal state. */
  activate(): void;
  /** SetActive(false). */
  deactivate(): void;
  readonly active: boolean;
  /** Animator.Play("Slot_0N_Withdrawal", 0, 0). */
  playWithdrawal(): void;
  /** The CardView inside the slot (its transform is left to the Animator). */
  setFace(card: CardFace): void;
  refreshBack(): void;
}

export interface RiverSlam {
  play(): void;
  stop(): void;
  readonly playing: boolean;
}

export interface DealerOptions {
  dealSpeed?: number;
  holeStagger?: number;
  cardOptions?: CardViewOptions;
}

/**
 * Port of Poker.Game.SplineCardDealer. Hole cards fly from the deck to each seat along that seat's two
 * splines; community cards are pre-placed animated slots switched on per street.
 */
export class SplineCardDealer {
  readonly dealtRoot = new Group();
  private readonly spawned: CardView[] = [];
  private holeViews: ({ card0: CardView | null; card1: CardView | null } | undefined)[] = [];
  readonly dealSpeed: number;
  readonly holeStagger: number;
  private readonly cardOptions: CardViewOptions;

  constructor(
    parent: Object3D,
    private readonly makeVisual: () => CardVisual,
    private readonly communitySlots: CommunitySlot[],
    private readonly riverSlam: RiverSlam | null,
    options: DealerOptions = {},
  ) {
    this.dealtRoot.name = 'DealtCards';
    parent.add(this.dealtRoot);
    this.dealSpeed = options.dealSpeed ?? 12;
    this.holeStagger = options.holeStagger ?? 0.12;
    this.cardOptions = options.cardOptions ?? {};
  }

  /** Deals a seat's two hole cards along its splines (face-up only for the human seat). */
  dealHoleCards(seat: number, spline0: UnitySpline | null, spline1: UnitySpline | null, a: CardFace, b: CardFace, faceUp: boolean): void {
    if (seat < 0) return;
    this.discardHoleCards(seat);
    this.holeViews[seat] = {
      card0: this.dealCard(spline0, a, faceUp, 0),
      card1: this.dealCard(spline1, b, faceUp, this.holeStagger),
    };
  }

  private discardHoleCards(seat: number): void {
    const h = this.holeViews[seat];
    if (!h) return;
    this.discard(h.card0);
    this.discard(h.card1);
    this.holeViews[seat] = { card0: null, card1: null };
  }

  private discard(view: CardView | null): void {
    if (!view) return;
    const i = this.spawned.indexOf(view);
    if (i >= 0) this.spawned.splice(i, 1);
    view.destroy();
  }

  greyOutHoleCards(seat: number): void {
    const h = this.holeViews[seat];
    h?.card0?.setGreyedOut();
    h?.card1?.setGreyedOut();
  }

  rehomeHoleCards(seat: number, spline0: UnitySpline | null, spline1: UnitySpline | null): void {
    const h = this.holeViews[seat];
    h?.card0?.retargetSpline(spline0);
    h?.card1?.retargetSpline(spline1);
  }

  /** Flips a seat's dealt hole cards to show the given cards (showdown). */
  revealHoleCards(seat: number, a: CardFace, b: CardFace): void {
    const h = this.holeViews[seat];
    if (!h) return;
    for (const [view, card] of [
      [h.card0, a],
      [h.card1, b],
    ] as const) {
      if (!view) continue;
      view.setFace(card);
      view.flip(true);
    }
  }

  /** Activates the slot for each card dealt this street and shows the real card on it. */
  dealCommunity(newCards: CardFace[], board: CardFace[]): void {
    const start = board.length - newCards.length;
    for (let i = 0; i < newCards.length; i++) {
      const slotIndex = start + i;
      const slot = this.communitySlots[slotIndex];
      if (!slot) continue;
      slot.activate();
      slot.setFace(newCards[i]);
      if (slotIndex === this.communitySlots.length - 1) this.riverSlam?.play();
    }
  }

  /** Plays each active slot's withdrawal clip; they stay active until the next Clear. */
  withdrawCommunityCards(): void {
    for (const slot of this.communitySlots) if (slot.active) slot.playWithdrawal();
  }

  /** Every dealt hole card flies back to the deck, last-dealt first, and is destroyed on arrival. */
  returnHoleCards(): void {
    this.holeViews = [];
    let order = 0;
    for (let i = this.spawned.length - 1; i >= 0; i--) {
      const cv = this.spawned[i];
      if (!cv.alive) continue;
      const delay = order++ * this.holeStagger * 0.5;
      const go = () => {
        if (cv.alive) cv.returnAlongSpline(this.dealSpeed, () => cv.destroy());
      };
      if (delay > 0) ticker.delayedCall(delay, go).setLink(cv);
      else go();
    }
  }

  /** Removes every dealt card and hides the community slots — the start of a new hand. */
  clear(): void {
    for (const cv of this.spawned) cv.destroy();
    this.spawned.length = 0;
    for (const child of [...this.dealtRoot.children]) child.removeFromParent();
    this.holeViews = [];
    if (this.riverSlam?.playing) this.riverSlam.stop();
    for (const slot of this.communitySlots) slot.deactivate();
  }

  refreshCardBacks(): void {
    for (const cv of this.spawned) cv.refreshBack();
    for (const slot of this.communitySlots) slot.refreshBack();
  }

  private dealCard(spline: UnitySpline | null, card: CardFace, revealAtEnd: boolean, delay: number): CardView | null {
    if (!spline) return null;
    const cv = new CardView(this.makeVisual(), this.cardOptions);
    this.dealtRoot.add(cv.transform);
    cv.setWorldPosition(spline.evaluatePosition(0)); // sit at the deck until it flies
    this.spawned.push(cv);
    cv.show(card, false);
    const go = () => {
      if (cv.alive) cv.dealAlongSpline(spline, card, revealAtEnd, this.dealSpeed);
    };
    if (delay > 0) ticker.delayedCall(delay, go).setLink(cv);
    else go();
    return cv;
  }
}
