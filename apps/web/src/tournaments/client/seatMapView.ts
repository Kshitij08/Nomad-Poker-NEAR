import type { Card } from '@nomad/engine/cards/card';
import { RoundPlanner } from '@nomad/engine/tournament';
import type { BettingPanelPort, SeatRole, TableViewPort } from '@nomad/engine/orchestration/tableView';

/**
 * Tournament tables have 8 chairs (TournamentRules.SeatsPerTable) and the local player must sit at the near seat
 * (PokerClientGame → TableView.SetLocalPerspective). This wraps the view and maps engine seats to view slots:
 * occupied seats in table order starting from the local one, spread round the view with RoundPlanner.spreadSeats so
 * a short table doesn't bunch up. If the view ever has fewer seat views than players, the furthest are not drawn.
 */
export class SeatMapView implements TableViewPort {
  private map = new Map<number, number>();
  private occupied: number[] = [];

  constructor(private readonly inner: TableViewPort) {}

  get seatCount(): number {
    return this.inner.seatCount;
  }
  get betting(): BettingPanelPort | null {
    return this.inner.betting;
  }

  /** The current mapping's engine seats (for tests and debugging). */
  get mappedSeats(): readonly number[] {
    return this.occupied;
  }

  slotOf(seat: number): number {
    return this.map.get(seat) ?? -1;
  }

  /** True when every occupied seat already has a slot. */
  covers(occupiedSeats: readonly number[]): boolean {
    return occupiedSeats.every((s) => this.map.has(s));
  }

  /** Builds the mapping for a table: `localSeat` (or -1 when watching) goes to view slot 0. */
  setPerspective(occupiedSeats: readonly number[], localSeat: number, tableSeats: number): void {
    const base = localSeat >= 0 ? localSeat : 0;
    const order = [...occupiedSeats].sort((a, b) => ((a - base + tableSeats) % tableSeats) - ((b - base + tableSeats) % tableSeats));
    const shown = order.slice(0, this.inner.seatCount);
    const slots = RoundPlanner.spreadSeats(shown.length, this.inner.seatCount);
    this.map = new Map(shown.map((seat, i) => [seat, slots[i]!]));
    this.occupied = shown;
    for (let slot = 0; slot < this.inner.seatCount; slot++) if (!slots.includes(slot)) this.inner.hideSeat(slot);
  }

  /** Forgets the mapping and hides every seat view (a new table is coming). */
  reset(): void {
    this.map.clear();
    this.occupied = [];
    for (let slot = 0; slot < this.inner.seatCount; slot++) this.inner.hideSeat(slot);
  }

  private with(seat: number, fn: (slot: number) => void): void {
    const slot = this.map.get(seat);
    if (slot !== undefined) fn(slot);
  }

  bindSeat(seat: number, playerName: string, stack: number, isBot: boolean, avatar: number, avatarName: string | null): void {
    this.with(seat, (s) => this.inner.bindSeat(s, playerName, stack, isBot, avatar, avatarName));
  }
  hideSeat(seat: number): void {
    this.with(seat, (s) => this.inner.hideSeat(s));
  }
  beginHand(handNumber: number): void {
    this.inner.beginHand(handNumber);
  }
  resetSeatForHand(seat: number, stack: number, role: SeatRole, busted: boolean): void {
    this.with(seat, (s) => this.inner.resetSeatForHand(s, stack, role, busted));
  }
  showBlind(seat: number, stackAfter: number, currentBet: number, potAfter: number): void {
    this.with(seat, (s) => this.inner.showBlind(s, stackAfter, currentBet, potAfter));
  }
  showHoleCards(seat: number, card0: Card, card1: Card, faceUp: boolean): void {
    this.with(seat, (s) => this.inner.showHoleCards(s, card0, card1, faceUp));
  }
  showBoard(newCards: Card[], board: Card[]): void {
    this.inner.showBoard(newCards, board);
  }
  showAction(seat: number, stackAfter: number, currentBet: number, description: string, potAfter: number, folded: boolean): void {
    this.with(seat, (s) => this.inner.showAction(s, stackAfter, currentBet, description, potAfter, folded));
  }
  showShowdown(seat: number, card0: Card, card1: Card, description: string): void {
    this.with(seat, (s) => this.inner.showShowdown(s, card0, card1, description));
  }
  showPotAward(seat: number, stackAfter: number, message: string, pot: number): void {
    const slot = this.map.get(seat);
    // A winner without a seat view still updates the pot readout and the message.
    if (slot !== undefined) this.inner.showPotAward(slot, stackAfter, message, pot);
    else this.inner.showMessage(message);
  }
  endHand(): void {
    this.inner.endHand();
  }
  showMessage(message: string): void {
    this.inner.showMessage(message);
  }
  showGameOver(message: string): void {
    this.inner.showGameOver(message);
  }
  setTurn(seat: number, timerSeconds: number, elapsedSeconds?: number): void {
    this.with(seat, (s) => this.inner.setTurn(s, timerSeconds, elapsedSeconds));
  }
  clearTurn(seat: number): void {
    this.with(seat, (s) => this.inner.clearTurn(s));
  }
  showReaction(seat: number, reactionId: number): void {
    this.with(seat, (s) => this.inner.showReaction?.(s, reactionId));
  }
  setVoiceState(seat: number, talking: boolean, muted: boolean): void {
    this.with(seat, (s) => this.inner.setVoiceState?.(s, talking, muted));
  }
}
