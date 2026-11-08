import type { Card } from '../cards/card';
import type { LegalActions, PlayerAction } from '../actions/actions';

/**
 * A seat's position for the hand — what the D_Token shows. Port of SeatView.cs SeatRole.
 * Token label (SeatView.RoleLabel): Dealer "D", SmallBlind "S", BigBlind "B", DealerAndSmallBlind "D" (heads-up),
 * None = token hidden.
 */
export enum SeatRole {
  None = 0,
  Dealer = 1,
  SmallBlind = 2,
  BigBlind = 3,
  DealerAndSmallBlind = 4,
}

export function seatRoleLabel(role: SeatRole): string {
  switch (role) {
    case SeatRole.Dealer: return 'D';
    case SeatRole.SmallBlind: return 'S';
    case SeatRole.BigBlind: return 'B';
    case SeatRole.DealerAndSmallBlind: return 'D';
    default: return '';
  }
}

/**
 * The display surface the presenter/controller drive: the method set of Game/Views/TableView.cs that single player
 * uses. The web view layer implements this. See web/docs/unity-behaviour-notes.md for what each call must draw.
 */
export interface TableViewPort {
  /** How many seats the view can display (controller clamps seatCount to this). */
  readonly seatCount: number;
  /** Player action controls. */
  readonly betting: BettingPanelPort | null;

  /** Name, avatar, stack, bot badge, and a clean hand state (TableView.BindSeat → SeatView.ResetForNewHand). */
  bindSeat(seat: number, playerName: string, stack: number, isBot: boolean, avatar: number, avatarName: string | null): void;
  hideSeat(seat: number): void;
  /** Clears the felt (board, dealt cards, hole cards), pot → 0, centre message "Hand #N". */
  beginHand(handNumber: number): void;
  /** Reset seat for the hand + role token; busted → status "Busted". */
  resetSeatForHand(seat: number, stack: number, role: SeatRole, busted: boolean): void;
  showBlind(seat: number, stackAfter: number, currentBet: number, potAfter: number): void;
  showHoleCards(seat: number, card0: Card, card1: Card, faceUp: boolean): void;
  showBoard(newCards: Card[], board: Card[]): void;
  showAction(seat: number, stackAfter: number, currentBet: number, description: string, potAfter: number, folded: boolean): void;
  showShowdown(seat: number, card0: Card, card1: Card, description: string): void;
  /** Winner highlight + pot tokens fly to seat, centre message, then pot readout = remaining pot. */
  showPotAward(seat: number, stackAfter: number, message: string, pot: number): void;
  /** End-of-hand exit animation: hole cards fly back to the deck, community cards play their withdrawal. */
  endHand(): void;
  showMessage(message: string): void;
  showGameOver(message: string): void;
  /** Highlight `seat` as the active turn (clearing all others) and start its radial timer (0 = no timer). */
  setTurn(seat: number, timerSeconds: number, elapsedSeconds?: number): void;
  clearTurn(seat: number): void;
  /** Network-only in practice (reactions). Optional. */
  showReaction?(seat: number, reactionId: number): void;
  /** Network-only (voice). Optional. */
  setVoiceState?(seat: number, talking: boolean, muted: boolean): void;
}

/** BettingPanel.Show / Hide. The view layer implements this; see bettingPanelModel.ts for the pure rules. */
export interface BettingPanelPort {
  show(legal: LegalActions, myCurrentBet: number, onChosen: (action: PlayerAction) => void): void;
  hide(): void;
}
