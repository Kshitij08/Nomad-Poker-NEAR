import { ActionType } from '../actions/actions';
import { BettingRound } from '../state/state';
import type {
  BettingRoundChangedEvent, BlindPostedEvent, CommunityDealtEvent, GameOverEvent, HandEndedEvent, HandStartedEvent,
  HoleCardsDealtEvent, PlayerActedEvent, PotAwardedEvent, ReactionEvent, ShowdownEvent, VoiceStateEvent,
} from '../events/pokerEvent';
import { PokerSound, type AudioPort } from './pokerSound';
import { TableMoney } from './tableMoney';
import { SeatRole, type TableViewPort } from './tableView';

/**
 * Translates the engine's event stream into TableView calls and the sounds that go with them. Reads nothing but the
 * events. Pacing stays with the caller. Port of Game/Orchestration/TableEventPresenter.cs.
 */
export class TableEventPresenter {
  /** Draw, but make no sound (catch-up replays). */
  silent = false;
  /** The hole-card deal is one sound for the whole table; set once heard, cleared at the next hand. */
  private dealSoundPlayed = false;

  /**
   * Other seats whose dealt cards are drawn face up (besides your own). A networked table sets it to "the server sent
   * the real cards" (your own Agent while you watch it); an offline table, which knows every card, leaves it null.
   */
  faceUpSeat: ((e: HoleCardsDealtEvent) => boolean) | null = null;

  constructor(private readonly view: TableViewPort, public localSeat: number, private readonly audio: AudioPort) {}

  onHandStarted(e: HandStartedEvent): void {
    this.view.beginHand(e.handNumber);
    this.dealSoundPlayed = false;

    for (let seat = 0; seat < e.seats.length; seat++) {
      const s = e.seats[seat];
      if (!s || !s.isOccupied) {
        this.view.hideSeat(seat);
        continue;
      }
      const name = s.isPendingNextHand ? `${s.name} (next hand)` : (s.name ?? '');
      this.view.bindSeat(seat, name, s.stack, s.isBot, s.avatar, s.name);
      if (s.isPendingNextHand) continue;
      this.view.resetSeatForHand(seat, s.stack, roleOf(seat, e), s.isBusted);
    }
  }

  /** A blind is the seat's first chips in, so its bet-so-far equals the posted amount. */
  onBlindPosted(e: BlindPostedEvent): void {
    this.view.showBlind(e.seat, e.stackAfter, e.amount, e.potAfter);
  }

  onHoleCardsDealt(e: HoleCardsDealtEvent): void {
    this.view.showHoleCards(e.seat, e.card0, e.card1, e.seat === this.localSeat || !!this.faceUpSeat?.(e));
    if (this.dealSoundPlayed) return;
    this.dealSoundPlayed = true;
    this.play(PokerSound.HoleCardsDealt);
  }

  onRoundChanged(e: BettingRoundChangedEvent): void {
    if (e.round === BettingRound.Preflop) return;
    this.view.showMessage(BettingRound[e.round]!); // "Flop" / "Turn" / "River"
    this.play(PokerSound.ChipsToPot); // street closing: bets sweep into the pot
  }

  onCommunityDealt(e: CommunityDealtEvent): void {
    this.view.showBoard(e.newCards, e.board);
    this.play(boardSound(e.round));
  }

  onPlayerActed(e: PlayerActedEvent): void {
    this.view.showAction(e.seat, e.stackAfter, e.amount, describeAction(e), e.potAfter, e.action === ActionType.Fold);
    this.play(actionSound(e));
  }

  onShowdown(e: ShowdownEvent): void {
    for (const entry of e.entries) this.view.showShowdown(entry.seat, entry.card0, entry.card1, entry.description);
    this.view.showMessage('Showdown');
  }

  onPotAwarded(e: PotAwardedEvent): void {
    this.view.showPotAward(e.seat, e.stackAfter, `${e.seatName} wins ${TableMoney.chips(e.amount)} (${e.reason})`, e.potAfter);
    this.play(PokerSound.ChipsToWinner);
    if (e.seat === this.localSeat) this.play(PokerSound.HandWon);
  }

  onHandEnded(_e: HandEndedEvent): void {
    this.view.endHand();
    this.play(PokerSound.CardsReturned);
  }

  onReaction(e: ReactionEvent): void {
    this.view.showReaction?.(e.seat, e.reactionId);
    this.play(PokerSound.Reaction);
  }

  onVoiceState(e: VoiceStateEvent): void {
    this.view.setVoiceState?.(e.seat, e.isTalking, e.isMuted);
  }

  onGameOver(e: GameOverEvent): void {
    this.view.showGameOver(!e.winnerName ? 'Game over' : `${e.winnerName} wins the game!`);
  }

  private play(sound: PokerSound): void {
    if (!this.silent && sound !== PokerSound.None) this.audio.play(sound);
  }
}

/** Button checked with the small blind because heads-up they are the same seat. */
function roleOf(seat: number, e: HandStartedEvent): SeatRole {
  const button = seat === e.buttonSeat;
  const small = seat === e.smallBlindSeat;
  if (button && small) return SeatRole.DealerAndSmallBlind;
  if (button) return SeatRole.Dealer;
  if (small) return SeatRole.SmallBlind;
  return seat === e.bigBlindSeat ? SeatRole.BigBlind : SeatRole.None;
}

function boardSound(round: BettingRound): PokerSound {
  switch (round) {
    case BettingRound.Flop: return PokerSound.FlopDealt;
    case BettingRound.Turn: return PokerSound.TurnDealt;
    case BettingRound.River: return PokerSound.RiverDealt;
    default: return PokerSound.None;
  }
}

/** A seat left with nothing is all in whatever the engine called the action. */
function actionSound(e: PlayerActedEvent): PokerSound {
  if (e.action === ActionType.Fold) return PokerSound.Fold;
  if (e.action === ActionType.AllIn || e.stackAfter <= 0) return PokerSound.AllIn;
  switch (e.action) {
    case ActionType.Check: return PokerSound.Check;
    case ActionType.Call: return PokerSound.Call;
    case ActionType.Bet: return PokerSound.Raise;
    case ActionType.Raise: return PokerSound.Raise;
    default: return PokerSound.None;
  }
}

/** Seat status text per action (exact Unity strings). Amount = the seat's resulting total bet this street. */
export function describeAction(e: Pick<PlayerActedEvent, 'action' | 'amount'>): string {
  switch (e.action) {
    case ActionType.Fold: return 'Fold';
    case ActionType.Check: return 'Check';
    case ActionType.Call: return 'Call ' + TableMoney.chips(e.amount);
    case ActionType.Bet: return 'Bet ' + TableMoney.chips(e.amount);
    case ActionType.Raise: return 'Raise ' + TableMoney.chips(e.amount);
    case ActionType.AllIn: return 'All-In';
    default: return ActionType[e.action]!;
  }
}
