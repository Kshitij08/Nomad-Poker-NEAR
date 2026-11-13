import type { BettingPanelPort, Card, SeatRole, TableViewPort, WaitFn } from '@nomad/engine';
import { ticker } from '../anim/tween';
import type { UnitySpline } from '../anim/unitySpline';
import type { SplineCardDealer } from './splineCardDealer';
import { sameMap, planSeats, type SeatPlan } from './seatSpread';

/**
 * The HUD half of Poker.Game.TableView: seat panels, pot readout and centre message. The 3D half (the
 * spline card dealer) lives in TableView itself. Implemented by the DOM HUD.
 */
export interface SeatHud {
  bind(name: string, avatar: number, avatarName: string): void;
  setStack(stack: number): void;
  setBet(bet: number): void;
  setStatus(text: string): void;
  setRole(role: SeatRole): void;
  setBot(isBot: boolean): void;
  setFolded(folded: boolean): void;
  setWinner(winner: boolean): void;
  resetForNewHand(): void;
  setHoleCards(card0: Card | null, card1: Card | null, faceUp: boolean): void;
  showHandStrength(card0: Card, card1: Card, board: Card[]): void;
  updateHandStrength(board: Card[]): void;
  hideHandStrength(): void;
  setActiveTurn(active: boolean): void;
  startTurnTimer(seconds: number, elapsed: number): void;
  stopTurnTimer(): void;
  setVisible(visible: boolean): void;
  readonly visible: boolean;
  /** A street closed: bets sweep to the pot, Check / Call / Bet / Raise statuses clear (Fold / All-in stay). */
  endStreet?(): void;
}

export interface PotHud {
  setPot(pot: number): void;
  setMessage(message: string): void;
  /** Pot tokens fly to the winning seat before the remaining pot restacks. */
  awardTokensTo(seat: number): void;
}

export interface TableHud {
  readonly seats: SeatHud[];
  readonly pot: PotHud;
  readonly betting: BettingPanelPort;
}

/** Engine waits on the same clock as every animation, so time scale and pausing affect both. */
export const tickerWait: WaitFn = (seconds, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      signal?.removeEventListener('abort', done);
      t.kill();
      resolve();
    };
    const t = ticker.delayedCall(Math.max(0, seconds), done);
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * Port of Poker.Game.TableView. Single player: seats are spread evenly round the table (`spread`, seatSpread.ts) —
 * seat 0 (you) at the bottom slot, the others at even intervals, re-planned between hands. The network view passes
 * already-permuted arrays and keeps the identity here.
 */
export class TableView implements TableViewPort {
  private boardCards: Card[] = [];
  /** Highest bet on the current street (blinds count): a "Bet" over one is shown as a "Raise". */
  private streetHigh = 0;
  /** Per-seat id of the latest hole-card deal, so a meter callback from an older (cleared) deal is ignored. */
  private dealSeq: number[] = [];
  private dealCount = 0;
  /** Logical seat → HUD slot (null = identity). */
  private map: number[] | null = null;
  /** The last seat plan: players already seated keep their places when someone joins or leaves (planSeats). */
  private plan: SeatPlan | null = null;
  private readonly occupied = new Set<number>();

  constructor(
    private readonly hud: TableHud,
    private readonly dealer: SplineCardDealer,
    private readonly seatSplines: [UnitySpline, UnitySpline][],
    private readonly opts: { spread?: boolean; anchorSeat?: number; onRing?: (ring: (number | null)[]) => void } = {},
  ) {
    this.hud.betting.hide();
    this.hud.pot.setPot(0);
    for (const s of this.hud.seats) s.setVisible(false);
  }

  get seatCount(): number {
    return this.hud.seats.length;
  }

  get betting(): BettingPanelPort {
    return this.hud.betting;
  }

  private slotOf(seat: number): number {
    return this.map && seat >= 0 && seat < this.map.length ? this.map[seat]! : seat;
  }

  private seat(i: number): SeatHud | null {
    return this.hud.seats[this.slotOf(i)] ?? null;
  }

  /** Between hands: re-plan the slots for who is seated (you at the bottom; everyone already seated keeps their place). */
  private replan(): void {
    if (!this.opts.spread) return;
    this.plan = planSeats(this.plan, this.hud.seats.length, [...this.occupied], this.opts.anchorSeat ?? 0, 0);
    const { map: next, ring } = this.plan;
    this.opts.onRing?.(ring);
    if (sameMap(this.map, next)) return;
    this.map = next;
    // Every seat is re-bound by the caller right after (onHandStarted binds each occupied seat).
    for (const s of this.hud.seats) s.setVisible(false);
  }

  bindSeat(seat: number, playerName: string, stack: number, isBot: boolean, avatar: number, avatarName: string | null): void {
    this.occupied.add(seat);
    const v = this.seat(seat);
    if (!v) return;
    v.setVisible(true);
    v.bind(playerName, avatar, avatarName ?? playerName);
    v.setStack(stack);
    v.resetForNewHand();
    v.setBot(isBot);
  }

  hideSeat(seat: number): void {
    this.occupied.delete(seat);
    this.seat(seat)?.setVisible(false);
  }

  beginHand(handNumber: number): void {
    // A new hand never keeps the last hand's action row or raise sheet (timeouts, auto-folds).
    this.hud.betting.hide();
    this.streetHigh = 0;
    this.replan();
    this.clearTable();
    this.hud.pot.setPot(0);
    this.hud.pot.setMessage(`Hand #${handNumber}`);
  }

  clearTable(): void {
    this.dealSeq = [];
    this.boardCards = [];
    this.dealer.clear();
    for (const s of this.hud.seats) s.setHoleCards(null, null, false);
  }

  endHand(): void {
    this.dealer.returnHoleCards();
    this.dealer.withdrawCommunityCards();
  }

  resetSeatForHand(seat: number, stack: number, role: SeatRole, busted: boolean): void {
    const v = this.seat(seat);
    if (!v) return;
    v.setVisible(true);
    v.resetForNewHand();
    v.setStack(stack);
    v.setRole(role);
    if (busted) v.setStatus('Busted');
  }

  showBlind(seat: number, stackAfter: number, currentBet: number, potAfter: number): void {
    const v = this.seat(seat);
    v?.setStack(stackAfter);
    v?.setBet(currentBet);
    this.streetHigh = Math.max(this.streetHigh, currentBet);
    this.hud.pot.setPot(potAfter);
  }

  showHoleCards(seat: number, card0: Card, card1: Card, faceUp: boolean): void {
    const v = this.seat(seat);
    if (!v) return;
    v.setHoleCards(card0, card1, faceUp);
    // The strength meter waits for the cards: it appears once both hole cards have landed, not while they fly.
    v.hideHandStrength();
    const deal = (this.dealSeq[seat] = ++this.dealCount);
    const meter = faceUp ? () => { if (this.dealSeq[seat] === deal) v.showHandStrength(card0, card1, this.boardCards); } : undefined;
    const sp = this.seatSplines[this.slotOf(seat)];
    if (sp) this.dealer.dealHoleCards(seat, sp[0], sp[1], card0, card1, faceUp, meter);
    else meter?.();
  }

  showBoard(newCards: Card[], board: Card[]): void {
    // Each board deal opens a new street (offline engine and net client both deal flop / turn / river here).
    if (newCards?.length) this.endStreet();
    this.boardCards = board ?? [];
    this.dealer.dealCommunity(newCards, board);
    for (const s of this.hud.seats) s.updateHandStrength(this.boardCards);
  }

  showAction(seat: number, stackAfter: number, currentBet: number, description: string, potAfter: number, folded: boolean): void {
    this.hud.pot.setPot(potAfter);
    const v = this.seat(seat);
    if (!v) return;
    v.setStack(stackAfter);
    v.setBet(currentBet);
    // Some engines name any wager into an unopened amount "Bet"; preflop the big blind already opened the
    // street, so more than the street's high bet is a raise (e.g. the big blind re-raising).
    const label = /^bet/i.test(description) && this.streetHigh > 0 && currentBet > this.streetHigh ? description.replace(/^bet/i, 'Raise') : description;
    v.setStatus(label);
    this.streetHigh = Math.max(this.streetHigh, currentBet);
    if (folded) {
      this.dealSeq[seat] = -1; // a meter still waiting on the deal stays hidden
      v.setHoleCards(null, null, false);
      v.setFolded(true);
      this.dealer.greyOutHoleCards(seat);
    }
  }

  /** The street's bets go into the pot and the per-street statuses clear. */
  endStreet(): void {
    this.streetHigh = 0;
    for (const s of this.hud.seats) s.endStreet?.();
  }

  showShowdown(seat: number, card0: Card, card1: Card, description: string): void {
    this.endStreet(); // river bets join the pot before the hands are shown
    this.dealer.revealHoleCards(seat, card0, card1);
    const v = this.seat(seat);
    if (!v) return;
    v.setHoleCards(card0, card1, true);
    v.setStatus(description);
  }

  showPotAward(seat: number, stackAfter: number, message: string, pot: number): void {
    this.endStreet(); // a hand won without a showdown: the last bets sweep in first
    const v = this.seat(seat);
    if (v) {
      v.setStack(stackAfter);
      v.setWinner(true);
      this.hud.pot.awardTokensTo(this.slotOf(seat));
    }
    this.hud.pot.setMessage(message);
    this.hud.pot.setPot(pot);
  }

  showMessage(message: string): void {
    this.hud.pot.setMessage(message);
  }

  showGameOver(message: string): void {
    this.hud.betting.hide();
    this.hud.pot.setMessage(message);
  }

  setTurn(seat: number, timerSeconds = 0, elapsedSeconds = 0): void {
    const active = this.seat(seat);
    this.hud.seats.forEach((v) => {
      const on = v === active;
      v.setActiveTurn(on);
      if (on && timerSeconds > 0) v.startTurnTimer(timerSeconds, elapsedSeconds);
      else v.stopTurnTimer();
    });
  }

  clearTurn(seat: number): void {
    const v = this.seat(seat);
    v?.setActiveTurn(false);
    v?.stopTurnTimer();
    // Every turn ends here — answered, timed out (the engine's / server's auto-fold) or abandoned. The action row and
    // the raise sheet never outlive it: a sheet left open after a timeout covered the row and soft-locked the player.
    this.hud.betting.hide();
  }
}
