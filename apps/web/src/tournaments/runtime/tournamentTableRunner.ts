import { ActionType, NO_LEGAL_ACTIONS, PlayerAction, type LegalActions } from '../../core/actions/actions';
import { positionOf, type BotContext, type IPokerBot } from '../../core/bots/botContext';
import { PokerEngine } from '../../core/engine/pokerEngine';
import { HIDDEN_CARD } from '../../core/events/pokerEventCodec';
import type { ActionRequestedEvent, EngineEvent, HoleCardsDealtEvent, SeatSnapshot } from '../../core/events/pokerEvent';
import { BettingRound, PlayerStatus } from '../../core/state/state';
import { TournamentRules, seatResult, type BlindLevel, type SeatResult, type TableOpenedCommand } from '../../core/tournament';
import { OUT_OF_BAND, type PlayerRef, type TournamentPacing, type RuntimeTiming, type WireEvent } from './wire';

/** What a table runner asks of the tournament that owns it (TournamentServerGame's internal members). */
export interface TableRunnerHost {
  readonly timing: RuntimeTiming;
  readonly pacing: TournamentPacing;
  readonly signal: AbortSignal;
  nameOf(entrantId: string): string;
  avatarOf(entrantId: string): number;
  isConnected(entrantId: string): boolean;
  botFor(entrantId: string): IPokerBot | null;
  seatAt(player: PlayerRef, tableId: number): number;
  recipientsOf(tableId: number): PlayerRef[];
  send(player: PlayerRef, sequence: number, event: WireEvent): void;
}

const ABSENT_TURN_SECONDS = 0.8;
const POLL_SECONDS = 0.1;

/**
 * One table of a tournament: its engine, its event stream and its turns. Port of Net/Tournament/TournamentTableRunner.cs
 * (Unity coroutines → async). The hand loop, per-recipient hole cards and turn prompts and the late-joiner catch-up
 * follow PokerServerGame. Differences are the tournament's: this table's events go only to its own players and
 * watchers with this table's own sequence; nobody buys in or cashes out; and an absent player's turn times out to
 * check or fold straight away, so their stack is blinded off without holding the table up.
 */
export class TournamentTableRunner {
  private readonly seatEntrant = new Map<number, string>();
  private readonly entrantSeat = new Map<string, number>();
  /** RemoteActionProvider per seat: the action a connected player sent for the turn being waited on. */
  private readonly pending = new Map<number, (a: PlayerAction) => void>();
  private readonly events: EngineEvent[] = [];
  private sequence = 0;
  private renderBudget = 0;

  readonly tableId: number;
  readonly round: number;
  readonly isFinal: boolean;
  readonly dealAtMs: number;
  readonly engine: PokerEngine;
  handRunning = false;
  closed = false;
  readonly seatCount = TournamentRules.SeatsPerTable;

  constructor(private readonly host: TableRunnerHost, opened: TableOpenedCommand) {
    this.tableId = opened.tableId;
    this.round = opened.round;
    this.isFinal = opened.isFinal;
    this.dealAtMs = opened.dealAtMs;

    // A secure shuffle per table: tables opened in the same millisecond must not deal the same deck.
    this.engine = new PokerEngine({ seatCount: this.seatCount, smallBlind: 25, bigBlind: 50, startingStack: opened.startingStack }, host.timing.makeRandom());
    this.engine.onEvent((e) => this.events.push(e));

    for (const seat of opened.seats) {
      this.engine.seatPlayer(seat.seat, seat.entrantId, host.nameOf(seat.entrantId), false, opened.startingStack);
      this.seatEntrant.set(seat.seat, seat.entrantId);
      this.entrantSeat.set(seat.entrantId, seat.seat);
    }
  }

  seatOf(entrantId: string): number {
    return this.entrantSeat.get(entrantId) ?? -1;
  }

  /** An eliminated player leaves the engine. Only ever between hands. */
  remove(entrantId: string): void {
    const seat = this.entrantSeat.get(entrantId);
    if (seat === undefined) return;
    this.entrantSeat.delete(entrantId);
    this.seatEntrant.delete(seat);
    this.pending.delete(seat);
    this.engine.vacateSeat(seat);
  }

  deliver(seat: number, action: PlayerAction): void {
    this.pending.get(seat)?.(action);
  }

  /** Plays one hand at `blinds` and reports every player's stack either side of it. */
  async playHand(blinds: BlindLevel, done: (runner: TournamentTableRunner, results: SeatResult[]) => void): Promise<void> {
    this.handRunning = true;
    const startStacks = new Map<string, number>();
    for (const [id, seat] of this.entrantSeat) startStacks.set(id, this.engine.table.seats[seat]!.stack);

    this.events.length = 0;
    this.engine.setBlinds(blinds.smallBlind, blinds.bigBlind);
    this.engine.startHand();
    const p = this.host.pacing;

    let handEnded = false;
    while (!handEnded) {
      if (this.host.signal.aborted) return;
      const e = this.events.shift();
      if (!e) {
        await this.wait(0);
        continue;
      }
      switch (e.type) {
        case 'ActionRequested': await this.onActionRequested(e); break;
        case 'HoleCardsDealt': this.replicateHoleCards(e); this.renderBudget += p.dealDelay; break;
        case 'BlindPosted': this.replicate(e); this.renderBudget += p.dealDelay; break;
        case 'BettingRoundChanged':
          this.replicate(e);
          if (e.round === BettingRound.Preflop) this.renderBudget += p.dealSettleDelay;
          break;
        case 'CommunityDealt': this.replicate(e); this.renderBudget += p.dealSettleDelay; break;
        case 'PlayerActed': this.replicate(e); this.renderBudget += p.actionDelay; break;
        case 'Showdown':
        case 'PotAwarded': this.replicate(e); this.renderBudget += p.showdownDelay; break;
        case 'HandEnded': this.replicate(e); handEnded = true; break;
        case 'GameOver': break; // the director decides when a table is over, not the engine
        default: this.replicate(e); break;
      }
    }

    await this.settleRender();
    await this.wait(p.betweenHands);
    if (this.host.signal.aborted) return;

    const results: SeatResult[] = [];
    for (const [id, seat] of this.entrantSeat) results.push(seatResult(id, startStacks.get(id)!, this.engine.table.seats[seat]!.stack));
    this.handRunning = false;
    done(this, results);
  }

  private wait(seconds: number): Promise<void> {
    return this.host.timing.wait(seconds, this.host.signal);
  }

  private async settleRender(): Promise<void> {
    if (this.renderBudget > 0) await this.wait(this.renderBudget);
    this.renderBudget = 0;
  }

  private async onActionRequested(e: ActionRequestedEvent): Promise<void> {
    await this.settleRender();
    this.replicateTurnStarted(e);

    let submitted = false;
    const submit = (action: PlayerAction) => {
      if (submitted) return;
      submitted = true;
      try {
        this.engine.submitAction(e.seat, action);
      } catch (ex) {
        // An illegal action from a client must not stop the table.
        console.warn(`[Tournament] Table ${this.tableId} seat ${e.seat}: ${(ex as Error).message} — checking/folding instead.`);
        this.engine.submitAction(e.seat, timeoutAction(e.legal));
      }
    };

    const entrant = this.seatEntrant.get(e.seat) ?? null;

    // Practice tournaments: a bot thinks for a moment like a person would, then plays.
    const bot = entrant !== null ? this.host.botFor(entrant) : null;
    if (bot) {
      await this.wait(0.7 + this.host.timing.random() * (1.6 - 0.7));
      if (this.host.signal.aborted) return;
      submit(bot.decide(this.botContextFor(e)));
      return;
    }

    if (entrant === null || !this.host.isConnected(entrant)) {
      // Away: blinded off, not waited for.
      await this.wait(ABSENT_TURN_SECONDS);
      if (this.host.signal.aborted) return;
      submit(timeoutAction(e.legal));
      return;
    }

    this.pending.set(e.seat, submit);
    const deadline = this.host.timing.nowMs() + this.host.pacing.turnTimer * 1000;
    while (!submitted && this.host.timing.nowMs() < deadline && this.host.isConnected(entrant) && !this.host.signal.aborted)
      await this.wait(POLL_SECONDS);
    this.pending.delete(e.seat);
    if (!submitted && !this.host.signal.aborted) submit(timeoutAction(e.legal));
  }

  private botContextFor(e: ActionRequestedEvent): BotContext {
    const t = this.engine.table;
    const p = t.seats[e.seat]!;
    return {
      seatIndex: e.seat,
      holeCards: p.holeCards,
      community: t.community,
      round: t.round,
      pot: t.pot,
      myStack: p.stack,
      myCurrentBet: p.currentBet,
      bigBlind: t.bigBlind,
      opponentsInHand: this.engine.countInHand() - 1,
      position: positionOf(t.buttonSeat, e.seat, t.seatCount),
      legal: e.legal,
    };
  }

  // ---- Replication (this table's recipients only) -------------------------------------

  private replicate(e: WireEvent): void {
    this.stampAvatars(e);
    const seq = this.sequence++;
    for (const player of this.host.recipientsOf(this.tableId)) this.host.send(player, seq, e);
  }

  broadcastRoster(): void {
    this.replicate({ type: 'TableRoster', seats: this.snapshot() });
  }

  replicateReaction(seat: number, reactionId: number): void {
    this.replicate({ type: 'Reaction', seat, reactionId });
  }

  private replicateHoleCards(e: HoleCardsDealtEvent): void {
    const seq = this.sequence++;
    const hidden: WireEvent = { type: 'HoleCardsDealt', seat: e.seat, card0: HIDDEN_CARD, card1: HIDDEN_CARD };
    for (const player of this.host.recipientsOf(this.tableId))
      this.host.send(player, seq, this.host.seatAt(player, this.tableId) === e.seat ? e : hidden);
  }

  private replicateTurnStarted(e: ActionRequestedEvent): void {
    const seq = this.sequence++;
    const seconds = this.host.pacing.turnTimer;
    for (const player of this.host.recipientsOf(this.tableId)) {
      const forYou = this.host.seatAt(player, this.tableId) === e.seat;
      this.host.send(player, seq, { type: 'TurnStarted', seat: e.seat, forYou, turnSeconds: seconds, legal: forYou ? e.legal : NO_LEGAL_ACTIONS });
    }
  }

  private snapshot(): SeatSnapshot[] {
    const seats: SeatSnapshot[] = [];
    for (let seat = 0; seat < this.seatCount; seat++) {
      const p = this.engine.table.seats[seat]!;
      const id = this.seatEntrant.get(seat);
      seats.push({
        name: p.name,
        stack: p.stack,
        isOccupied: p.isOccupied,
        isBusted: p.status === PlayerStatus.Busted,
        isBot: p.isOccupied && id !== undefined && this.host.botFor(id) !== null,
        isAgent: false,
        isPendingNextHand: false,
        isLeaving: p.isOccupied && id !== undefined && !this.host.isConnected(id),
        avatar: 0,
      });
    }
    return seats;
  }

  private stampAvatars(e: WireEvent): void {
    const seats = e.type === 'TableRoster' || e.type === 'HandStarted' ? e.seats : null;
    if (!seats) return;
    seats.forEach((snapshot, seat) => {
      if (!snapshot || !snapshot.isOccupied) return;
      const id = this.seatEntrant.get(seat);
      if (id !== undefined) snapshot.avatar = this.host.avatarOf(id);
    });
  }

  /**
   * Paints this table for one peer who just started looking at it: the seats, then the hand in progress if there is
   * one. Outside the table's sequence, so nobody else sees a gap.
   */
  sendCatchUpTo(player: PlayerRef): void {
    this.sendOutOfBand(player, { type: 'TableRoster', seats: this.snapshot() });
    if (!this.engine.handInProgress) return;

    const table = this.engine.table;
    const recipientSeat = this.host.seatAt(player, this.tableId);
    this.sendOutOfBand(player, {
      type: 'HandStarted', handNumber: table.handNumber, buttonSeat: table.buttonSeat, smallBlindSeat: table.smallBlindSeat,
      bigBlindSeat: table.bigBlindSeat, seats: this.snapshot(),
    });

    for (let seat = 0; seat < table.seatCount; seat++) {
      const p = table.seats[seat]!;
      if (p.holeCards.length < 2) continue;
      const mine = seat === recipientSeat;
      this.sendOutOfBand(player, { type: 'HoleCardsDealt', seat, card0: mine ? p.holeCards[0]! : HIDDEN_CARD, card1: mine ? p.holeCards[1]! : HIDDEN_CARD });
    }

    this.sendOutOfBand(player, { type: 'BettingRoundChanged', round: table.round });
    if (table.community.length > 0) {
      const board = [...table.community];
      this.sendOutOfBand(player, { type: 'CommunityDealt', round: table.round, newCards: board, board });
    }

    for (let seat = 0; seat < table.seatCount; seat++) {
      const p = table.seats[seat]!;
      if (!p.isOccupied) continue;
      if (p.status === PlayerStatus.Folded)
        this.sendOutOfBand(player, { type: 'PlayerActed', seat, action: ActionType.Fold, amount: p.currentBet, stackAfter: p.stack, potAfter: table.pot });
      else if (p.currentBet > 0 || p.status === PlayerStatus.AllIn)
        this.sendOutOfBand(player, {
          type: 'PlayerActed', seat, action: p.status === PlayerStatus.AllIn ? ActionType.AllIn : ActionType.Bet,
          amount: p.currentBet, stackAfter: p.stack, potAfter: table.pot,
        });
    }

    const acting = this.engine.awaitingActionSeat;
    if (acting >= 0) {
      const forYou = acting === recipientSeat;
      this.sendOutOfBand(player, {
        type: 'TurnStarted', seat: acting, forYou, turnSeconds: this.host.pacing.turnTimer,
        legal: forYou ? this.engine.currentLegalActions : NO_LEGAL_ACTIONS,
      });
    }
  }

  private sendOutOfBand(player: PlayerRef, e: WireEvent): void {
    this.stampAvatars(e);
    this.host.send(player, OUT_OF_BAND, e);
  }
}

/** When a seat's turn runs out: check for free if possible, otherwise fold. */
export function timeoutAction(legal: LegalActions): PlayerAction {
  return legal.canCheck ? PlayerAction.check() : PlayerAction.fold();
}
