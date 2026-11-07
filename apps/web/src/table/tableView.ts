import type { BettingPanelPort, Card, SeatRole, TableViewPort, WaitFn } from '../core';
import { ticker } from '../anim/tween';
import type { UnitySpline } from '../anim/unitySpline';
import type { SplineCardDealer } from './splineCardDealer';

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

/** Port of Poker.Game.TableView (single-player: identity seat mapping). */
export class TableView implements TableViewPort {
  private boardCards: Card[] = [];

  constructor(
    private readonly hud: TableHud,
    private readonly dealer: SplineCardDealer,
    private readonly seatSplines: [UnitySpline, UnitySpline][],
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

  private seat(i: number): SeatHud | null {
    return this.hud.seats[i] ?? null;
  }

  bindSeat(seat: number, playerName: string, stack: number, isBot: boolean, avatar: number, avatarName: string | null): void {
    const v = this.seat(seat);
    if (!v) return;
    v.setVisible(true);
    v.bind(playerName, avatar, avatarName ?? playerName);
    v.setStack(stack);
    v.resetForNewHand();
    v.setBot(isBot);
  }

  hideSeat(seat: number): void {
    this.seat(seat)?.setVisible(false);
  }

  beginHand(handNumber: number): void {
    this.clearTable();
    this.hud.pot.setPot(0);
    this.hud.pot.setMessage(`Hand #${handNumber}`);
  }

  clearTable(): void {
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
    this.hud.pot.setPot(potAfter);
  }

  showHoleCards(seat: number, card0: Card, card1: Card, faceUp: boolean): void {
    const v = this.seat(seat);
    if (!v) return;
    v.setHoleCards(card0, card1, faceUp);
    if (faceUp) v.showHandStrength(card0, card1, this.boardCards);
    else v.hideHandStrength();
    const sp = this.seatSplines[seat];
    if (sp) this.dealer.dealHoleCards(seat, sp[0], sp[1], card0, card1, faceUp);
  }

  showBoard(newCards: Card[], board: Card[]): void {
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
    v.setStatus(description);
    if (folded) {
      v.setHoleCards(null, null, false);
      v.setFolded(true);
      this.dealer.greyOutHoleCards(seat);
    }
  }

  showShowdown(seat: number, card0: Card, card1: Card, description: string): void {
    this.dealer.revealHoleCards(seat, card0, card1);
    const v = this.seat(seat);
    if (!v) return;
    v.setHoleCards(card0, card1, true);
    v.setStatus(description);
  }

  showPotAward(seat: number, stackAfter: number, message: string, pot: number): void {
    const v = this.seat(seat);
    if (v) {
      v.setStack(stackAfter);
      v.setWinner(true);
      this.hud.pot.awardTokensTo(seat);
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
    this.hud.seats.forEach((v, i) => {
      const active = i === seat;
      v.setActiveTurn(active);
      if (active && timerSeconds > 0) v.startTurnTimer(timerSeconds, elapsedSeconds);
      else v.stopTurnTimer();
    });
  }

  clearTurn(seat: number): void {
    const v = this.seat(seat);
    v?.setActiveTurn(false);
    v?.stopTurnTimer();
  }
}
