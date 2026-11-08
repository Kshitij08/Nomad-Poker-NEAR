import { Deck } from '../cards/deck';
import type { Card } from '../cards/card';
import type { IRandom } from '../cards/random';
import { ActionType, NO_LEGAL_ACTIONS, PlayerAction, legalActions, type LegalActions } from '../actions/actions';
import { ArgumentOutOfRangeError, InvalidOperationError } from '../errors';
import { HandEvaluator } from '../evaluation/handEvaluator';
import type { HandValue } from '../evaluation/handValue';
import type { EngineEvent, SeatSnapshot, ShowdownEntry } from '../events/pokerEvent';
import { SidePotCalculator } from '../state/sidePotCalculator';
import { BettingRound, PlayerStatus, TableState, type PlayerState, type Pot } from '../state/state';
import type { TableConfig } from './tableConfig';

export type EngineListener = (e: EngineEvent) => void;

/**
 * Authoritative Texas Hold'em (cash game) rules engine. Port of Core/Engine/PokerEngine.cs.
 *
 * Subscribe with {@link onEvent}, call {@link startHand}, and whenever an ActionRequested event fires (or
 * {@link awaitingActionSeat} >= 0) submit that seat's choice via {@link submitAction}. The engine runs itself
 * forward synchronously until it next needs a decision or the hand ends.
 */
export class PokerEngine {
  private readonly random: IRandom;
  private readonly deck = new Deck();
  private readonly _table: TableState;
  /** Once every remaining opponent is all-in or folded, later streets must not reopen check/bet. */
  private runout = false;
  private smallBlindAmount: number;
  private bigBlindAmount: number;
  private readonly listeners = new Set<EngineListener>();

  handInProgress = false;
  awaitingActionSeat = -1;
  currentLegalActions: LegalActions = NO_LEGAL_ACTIONS;

  constructor(config: TableConfig, random: IRandom) {
    if (!config) throw new TypeError('config is required.');
    if (!random) throw new TypeError('random is required.');
    this.random = random;
    this._table = new TableState(config.seatCount);
    this.smallBlindAmount = config.smallBlind;
    this.bigBlindAmount = config.bigBlind;
  }

  /** C# `Events += handler`. Returns an unsubscribe function. Listeners run synchronously, in emit order. */
  onEvent(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The live table state (C# `Table`). Read-only by convention: only the engine mutates it. */
  get table(): TableState {
    return this._table;
  }

  get community(): readonly Card[] {
    return this._table.community;
  }

  /** Changes the blinds from the next hand on. Refused mid-hand. */
  setBlinds(smallBlind: number, bigBlind: number): void {
    if (this.handInProgress) throw new InvalidOperationError('Blinds can only change between hands.');
    if (smallBlind <= 0) throw new ArgumentOutOfRangeError('Small blind must be positive.');
    if (bigBlind < smallBlind) throw new ArgumentOutOfRangeError('Big blind must be at least the small blind.');
    this.smallBlindAmount = smallBlind;
    this.bigBlindAmount = bigBlind;
  }

  // ---- Seating -------------------------------------------------------

  seatPlayer(seat: number, id: string, name: string, isBot: boolean, stack: number, isAgent = false): void {
    const p = this._table.seats[seat]!;
    p.id = id;
    p.name = name;
    p.isBot = isBot || isAgent;
    p.isAgent = isAgent;
    p.stack = stack;
    p.holeCards.length = 0;
    p.currentBet = 0;
    p.totalCommitted = 0;
    p.hasActed = false;
    p.status = stack > 0 ? PlayerStatus.SittingOut : PlayerStatus.Busted;
  }

  /** Empties a seat completely. Call only between hands. */
  vacateSeat(seat: number): void {
    const p = this._table.seats[seat]!;
    p.id = null;
    p.name = null;
    p.isBot = false;
    p.isAgent = false;
    p.stack = 0;
    p.holeCards.length = 0;
    p.currentBet = 0;
    p.totalCommitted = 0;
    p.hasActed = false;
    p.status = PlayerStatus.Empty;
  }

  countFundedPlayers(): number {
    let n = 0;
    for (const p of this._table.seats) if (p.isOccupied && p.stack > 0) n++;
    return n;
  }

  countInHand(): number {
    let n = 0;
    for (const p of this._table.seats) if (p.isInHand) n++;
    return n;
  }

  // ---- Hand lifecycle ------------------------------------------------

  startHand(): void {
    if (this.countFundedPlayers() < 2) throw new InvalidOperationError('Need at least two funded players to start a hand.');

    this.resetForNewHand();
    this._table.handNumber++;
    this.deck.reset();
    this.deck.shuffle(this.random);

    this.moveButton();
    this._table.smallBlind = this.smallBlindAmount;
    this._table.bigBlind = this.bigBlindAmount;
    this._table.round = BettingRound.Preflop;
    this.handInProgress = true;

    this.emit({
      type: 'HandStarted',
      handNumber: this._table.handNumber,
      buttonSeat: this._table.buttonSeat,
      smallBlindSeat: this._table.smallBlindSeat,
      bigBlindSeat: this._table.bigBlindSeat,
      seats: this.snapshotSeats(),
    });

    this.postBlinds();
    this.dealHoleCards();
    this.emit({ type: 'BettingRoundChanged', round: BettingRound.Preflop });

    // Preflop action opens to the left of the big blind (heads-up: the button/SB).
    this._table.currentSeat = this._table.bigBlindSeat;
    this.advance();
  }

  submitAction(seat: number, action: PlayerAction): void {
    if (!this.handInProgress) throw new InvalidOperationError('No hand in progress.');
    if (seat !== this.awaitingActionSeat)
      throw new InvalidOperationError(`It is not seat ${seat}'s turn (awaiting ${this.awaitingActionSeat}).`);

    this.applyAction(seat, action, this.currentLegalActions);
    this._table.currentSeat = seat;
    this.awaitingActionSeat = -1;
    this.advance();
  }

  // ---- Core loop -----------------------------------------------------

  private advance(): void {
    for (;;) {
      if (this.countInHand() <= 1) {
        this.endHandUncontested();
        return;
      }

      // At most one player can still put chips in, and they have matched: run the board.
      if (this.shouldRunOutBoard()) {
        this.runout = true;
        if (!this.advanceStreet()) return;
        continue;
      }

      const next = this.findNextActor(this._table.currentSeat);
      if (next >= 0) {
        this._table.currentSeat = next;
        this.awaitingActionSeat = next;
        this.currentLegalActions = this.computeLegalActions(next);
        this.emit({ type: 'ActionRequested', seat: next, legal: this.currentLegalActions });
        return;
      }

      // Round complete. Next street.
      if (!this.advanceStreet()) return;
    }
  }

  private findNextActor(fromSeat: number): number {
    const n = this._table.seatCount;
    for (let i = 1; i <= n; i++) {
      const seat = (fromSeat + i) % n;
      if (this.needsToAct(this._table.seats[seat]!)) return seat;
    }
    return -1;
  }

  private countPlayersWhoCanAct(): number {
    let n = 0;
    for (const p of this._table.seats) if (p.canAct) n++;
    return n;
  }

  /** A lone player with chips must call or fold an unmatched shove; once matched, no check/bet on later streets. */
  private needsToAct(p: PlayerState): boolean {
    if (!p.canAct) return false;
    if (p.currentBet < this._table.currentHighBet) return true;
    if (this.runout || this.countPlayersWhoCanAct() <= 1) return false;
    return !p.hasActed;
  }

  private shouldRunOutBoard(): boolean {
    for (const p of this._table.seats) if (p.canAct && p.currentBet < this._table.currentHighBet) return false;
    return this.runout || this.countPlayersWhoCanAct() <= 1;
  }

  private advanceStreet(): boolean {
    switch (this._table.round) {
      case BettingRound.Preflop: this.dealCommunity(3, BettingRound.Flop); return true;
      case BettingRound.Flop: this.dealCommunity(1, BettingRound.Turn); return true;
      case BettingRound.Turn: this.dealCommunity(1, BettingRound.River); return true;
      case BettingRound.River: this.showdown(); return false;
      default: return false;
    }
  }

  // ---- Setup helpers -------------------------------------------------

  private resetForNewHand(): void {
    this.runout = false;
    for (const p of this._table.seats) {
      if (p.status === PlayerStatus.Empty) continue;
      p.holeCards.length = 0;
      p.currentBet = 0;
      p.totalCommitted = 0;
      p.hasActed = false;
      p.status = p.stack > 0 ? PlayerStatus.Active : PlayerStatus.Busted;
    }
    this._table.community.length = 0;
    this._table.pot = 0;
    this._table.currentHighBet = 0;
    this._table.minRaise = this.bigBlindAmount;
    this._table.round = BettingRound.None;
  }

  private moveButton(): void {
    const funded = this.countFundedPlayers();
    this._table.buttonSeat = this._table.buttonSeat < 0 ? this.firstFundedFrom(0) : this.nextFundedFrom(this._table.buttonSeat);

    if (funded === 2) {
      // Heads-up: the button is the small blind.
      this._table.smallBlindSeat = this._table.buttonSeat;
      this._table.bigBlindSeat = this.nextFundedFrom(this._table.buttonSeat);
    } else {
      this._table.smallBlindSeat = this.nextFundedFrom(this._table.buttonSeat);
      this._table.bigBlindSeat = this.nextFundedFrom(this._table.smallBlindSeat);
    }
  }

  private firstFundedFrom(start: number): number {
    const n = this._table.seatCount;
    for (let i = 0; i < n; i++) {
      const seat = (start + i) % n;
      if (this.isFunded(seat)) return seat;
    }
    return -1;
  }

  private nextFundedFrom(seat: number): number {
    return this.firstFundedFrom((seat + 1) % this._table.seatCount);
  }

  private isFunded(seat: number): boolean {
    const p = this._table.seats[seat]!;
    return p.isOccupied && p.stack > 0 && p.status !== PlayerStatus.Busted;
  }

  private postBlinds(): void {
    this.postBlind(this._table.smallBlindSeat, this.smallBlindAmount, true);
    this.postBlind(this._table.bigBlindSeat, this.bigBlindAmount, false);
    // Others must match the full big blind even if the BB itself is short / all-in.
    this._table.currentHighBet = this.bigBlindAmount;
    this._table.minRaise = this.bigBlindAmount;
  }

  private postBlind(seat: number, amount: number, isSmall: boolean): void {
    const p = this._table.seats[seat]!;
    const post = Math.min(amount, p.stack);
    this.commit(p, post);
    if (p.stack === 0) p.status = PlayerStatus.AllIn;
    // Blinds are forced, not voluntary: HasActed stays false so the big blind keeps its option.
    this.emit({ type: 'BlindPosted', seat, amount: post, isSmallBlind: isSmall, stackAfter: p.stack, potAfter: this._table.pot });
  }

  private dealHoleCards(): void {
    for (const p of this._table.seats) {
      if (p.status !== PlayerStatus.Active && p.status !== PlayerStatus.AllIn) continue;
      const a = this.deck.deal();
      const b = this.deck.deal();
      p.holeCards.push(a, b);
      this.emit({ type: 'HoleCardsDealt', seat: p.seatIndex, card0: a, card1: b });
    }
  }

  private dealCommunity(count: number, newRound: BettingRound): void {
    this.deck.burn();
    const newCards: Card[] = [];
    for (let i = 0; i < count; i++) {
      const c = this.deck.deal();
      this._table.community.push(c);
      newCards.push(c);
    }
    // NOTE: StartBettingRound emits BettingRoundChanged BEFORE CommunityDealt (same as C#).
    this.startBettingRound(newRound);
    this.emit({ type: 'CommunityDealt', round: newRound, newCards, board: [...this._table.community] });
  }

  private startBettingRound(round: BettingRound): void {
    this._table.round = round;
    for (const p of this._table.seats) {
      p.currentBet = 0;
      if (p.status === PlayerStatus.Active) p.hasActed = false;
    }
    this._table.currentHighBet = 0;
    this._table.minRaise = this.bigBlindAmount;
    // Postflop action opens to the left of the button.
    this._table.currentSeat = this._table.buttonSeat;
    this.emit({ type: 'BettingRoundChanged', round });
  }

  // ---- Action application -------------------------------------------

  private computeLegalActions(seat: number): LegalActions {
    const p = this._table.seats[seat]!;
    let toCall = this._table.currentHighBet - p.currentBet;
    if (toCall < 0) toCall = 0;
    const callAmount = Math.min(toCall, p.stack);
    const maxRaiseTo = p.currentBet + p.stack;
    // A shove or bet only makes sense if someone else can still put chips in.
    const opponentsCanAct = !this.runout && this.countPlayersWhoCanAct() > 1;

    const canCheck = toCall === 0;
    const canCall = toCall > 0 && p.stack > 0;

    let canBet = false, canRaise = false;
    let minRaiseTo = 0;

    if (toCall === 0) {
      if (p.stack > 0 && opponentsCanAct) {
        canBet = true;
        minRaiseTo = Math.min(p.currentBet + this._table.minRaise, maxRaiseTo);
      }
    } else if (p.stack > toCall && opponentsCanAct) {
      canRaise = true;
      minRaiseTo = Math.min(this._table.currentHighBet + this._table.minRaise, maxRaiseTo);
    }

    let canAllIn = p.stack > 0 && (toCall > 0 || opponentsCanAct);
    if (toCall > 0 && p.stack > toCall && !opponentsCanAct) canAllIn = false; // leftover chips would be an uncallable raise

    return legalActions(true, canCheck, canCall, callAmount, canBet, canRaise, minRaiseTo, maxRaiseTo, canAllIn);
  }

  private applyAction(seat: number, action: PlayerAction, legal: LegalActions): void {
    const p = this._table.seats[seat]!;
    switch (action.type) {
      case ActionType.Fold:
        if (!legal.canFold) throw illegal(action);
        p.status = PlayerStatus.Folded;
        p.hasActed = true;
        this.emitActed(p, ActionType.Fold);
        break;

      case ActionType.Check:
        if (!legal.canCheck) throw illegal(action);
        p.hasActed = true;
        this.emitActed(p, ActionType.Check);
        break;

      case ActionType.Call:
        if (!legal.canCall) throw illegal(action);
        this.commit(p, legal.callAmount);
        p.hasActed = true;
        if (p.stack === 0) p.status = PlayerStatus.AllIn;
        this.emitActed(p, ActionType.Call);
        break;

      case ActionType.Bet:
        if (!legal.canBet || action.amount < legal.minRaiseTo || action.amount > legal.maxRaiseTo) throw illegal(action);
        this.applyWager(p, action.amount);
        this.emitActed(p, ActionType.Bet);
        break;

      case ActionType.Raise:
        if (!legal.canRaise || action.amount < legal.minRaiseTo || action.amount > legal.maxRaiseTo) throw illegal(action);
        this.applyWager(p, action.amount);
        this.emitActed(p, ActionType.Raise);
        break;

      case ActionType.AllIn:
        if (!legal.canAllIn) throw illegal(action);
        this.applyWager(p, p.currentBet + p.stack);
        this.emitActed(p, ActionType.AllIn);
        break;

      default:
        throw illegal(action);
    }
  }

  private applyWager(p: PlayerState, totalTo: number): void {
    let delta = Math.min(totalTo - p.currentBet, p.stack);
    if (delta < 0) delta = 0;
    this.commit(p, delta);

    if (p.currentBet > this._table.currentHighBet) {
      const raiseSize = p.currentBet - this._table.currentHighBet;
      if (raiseSize >= this._table.minRaise) this._table.minRaise = raiseSize; // only a full raise re-sets the min
      this._table.currentHighBet = p.currentBet;
    }

    p.hasActed = true;
    if (p.stack === 0) p.status = PlayerStatus.AllIn;
  }

  private commit(p: PlayerState, amount: number): void {
    if (amount <= 0) return;
    p.stack -= amount;
    p.currentBet += amount;
    p.totalCommitted += amount;
    this._table.pot += amount;
    if (p.stack === 0 && p.status === PlayerStatus.Active) p.status = PlayerStatus.AllIn;
  }

  private emitActed(p: PlayerState, type: ActionType): void {
    this.emit({ type: 'PlayerActed', seat: p.seatIndex, action: type, amount: p.currentBet, stackAfter: p.stack, potAfter: this._table.pot });
  }

  // ---- Resolution ----------------------------------------------------

  private endHandUncontested(): void {
    let winner = -1;
    for (const p of this._table.seats) if (p.isInHand) { winner = p.seatIndex; break; }

    if (winner >= 0) {
      const amount = this._table.pot;
      this._table.pot = 0;
      const w = this._table.seats[winner]!;
      w.stack += amount;
      this.emit({ type: 'PotAwarded', seat: winner, seatName: w.name, amount, stackAfter: w.stack, potAfter: 0, reason: 'Uncontested' });
    }
    this.endHand();
  }

  private showdown(): void {
    const handValues = new Map<number, HandValue>();
    const entries: ShowdownEntry[] = [];
    for (const p of this._table.seats) {
      if (!p.isInHand) continue;
      const value = HandEvaluator.evaluateHand(p.holeCards, this._table.community);
      handValues.set(p.seatIndex, value);
      entries.push({ seat: p.seatIndex, card0: p.holeCards[0]!, card1: p.holeCards[1]!, value, description: value.describe() });
    }

    this.emit({ type: 'Showdown', entries, board: [...this._table.community] });

    const pots = SidePotCalculator.build(this._table.seats);
    for (let i = 0; i < pots.length; i++) {
      const reason = pots.length === 1 ? 'Pot' : i === 0 ? 'Main pot' : 'Side pot';
      this.awardPot(pots[i]!, handValues, reason);
    }

    this._table.pot = 0;
    this.endHand();
  }

  private awardPot(pot: Pot, handValues: Map<number, HandValue>, reason: string): void {
    const winners: number[] = [];
    let haveContender = false;
    let best: HandValue | null = null;

    for (const seat of pot.eligibleSeats) {
      const v = handValues.get(seat);
      if (!this._table.seats[seat]!.isInHand || !v) continue;
      if (!haveContender || v.gt(best!)) { best = v; haveContender = true; }
    }

    if (haveContender) {
      for (const seat of pot.eligibleSeats) {
        const v = handValues.get(seat);
        if (this._table.seats[seat]!.isInHand && v && v.equals(best!)) winners.push(seat);
      }
    } else {
      winners.push(...pot.eligibleSeats); // refund
    }

    if (winners.length === 0) return;

    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;

    // Odd chips go to the first eligible seat to the left of the button.
    winners.sort((a, b) => this.seatOrderFromButton(a) - this.seatOrderFromButton(b));

    for (const seat of winners) {
      let award = share;
      if (remainder > 0) { award++; remainder--; }
      const s = this._table.seats[seat]!;
      s.stack += award;
      this._table.pot -= award;
      this.emit({ type: 'PotAwarded', seat, seatName: s.name, amount: award, stackAfter: s.stack, potAfter: this._table.pot, reason });
    }
  }

  private seatOrderFromButton(seat: number): number {
    const n = this._table.seatCount;
    return (seat - this._table.buttonSeat - 1 + n) % n;
  }

  private endHand(): void {
    this.awaitingActionSeat = -1;
    this.handInProgress = false;
    this._table.round = BettingRound.Showdown;

    for (const p of this._table.seats) if (p.isOccupied && p.stack <= 0) p.status = PlayerStatus.Busted;

    this.emit({ type: 'HandEnded', handNumber: this._table.handNumber });

    if (this.countFundedPlayers() < 2) {
      let winner = -1;
      for (const p of this._table.seats) if (p.isOccupied && p.stack > 0) { winner = p.seatIndex; break; }
      this.emit({ type: 'GameOver', winnerSeat: winner, winnerName: winner >= 0 ? this._table.seats[winner]!.name : null });
    }
  }

  private snapshotSeats(): SeatSnapshot[] {
    return this._table.seats.map((p) => ({
      name: p.name,
      stack: p.stack,
      isOccupied: p.isOccupied,
      isBusted: p.status === PlayerStatus.Busted,
      isBot: p.isBot,
      isAgent: p.isAgent,
      isPendingNextHand: false,
      isLeaving: false,
      avatar: 0,
    }));
  }

  private emit(e: EngineEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
}

function illegal(a: PlayerAction): InvalidOperationError {
  return new InvalidOperationError(`Illegal action: ${PlayerAction.toString(a)}`);
}
