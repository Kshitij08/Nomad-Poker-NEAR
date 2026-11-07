import type { LegalActions, PlayerAction } from '../../core/actions/actions';
import type { SeatSnapshot } from '../../core/events/pokerEvent';
import type { WaitFn } from '../../core/orchestration/actionProviders';
import { PokerSound, type AudioPort } from '../../core/orchestration/pokerSound';
import { TableEventPresenter } from '../../core/orchestration/tableEventPresenter';
import type { TableViewPort } from '../../core/orchestration/tableView';
import { BettingRound } from '../../core/state/state';
import { TournamentRules, TournamentViewReason, type TournamentResultEvent, type TournamentViewEvent } from '../../core/tournament';
import type { TournamentClientState } from '../clientState';
import { OUT_OF_BAND, type TournamentPacing, type WireEvent } from '../runtime/wire';
import { SeatMapView } from './seatMapView';

interface Queued {
  event: WireEvent;
  arrivedAt: number;
  catchUp: boolean;
}

export interface TournamentTableClientOptions {
  /** The session name these events belong to (TournamentClientState.Begin). */
  session: string;
  pacing: TournamentPacing;
  wait: WaitFn;
  /** Seconds since some epoch, on the same clock `wait` runs on (for the turn radial's backlog). */
  now: () => number;
  /** Sends the local player's action to the server. */
  submitAction: (seat: number, action: PlayerAction) => void;
  /** XP from a tournament result (VirtualEconomy.Grant(RewardGrant.Xp(n, "tournament"))). */
  grantXp?: (xp: number) => void;
}

/**
 * The tournament half of PokerClientGame: mirrors one tournament table from the server's event stream onto the
 * TableView, paced like PokerGameController, and feeds TournamentClientState. A TournamentView event clears the felt
 * and switches tables (same connection, another table's stream). Used by the offline practice tournament, whose
 * "server" is the in-browser TournamentServerGame; the same class can sit behind a WebSocket.
 */
export class TournamentTableClient {
  readonly view: SeatMapView;
  private presenter: TableEventPresenter;
  private readonly queue: Queued[] = [];
  private readonly abort = new AbortController();
  private waiter: (() => void) | null = null;
  private localSeat = -1;
  private turnSeat = -1;
  private myCurrentBet = 0;
  private promptOpen = false;
  private needsPerspective = false;

  constructor(
    private readonly rawView: TableViewPort,
    private readonly audio: AudioPort,
    private readonly state: TournamentClientState,
    private readonly opts: TournamentTableClientOptions,
  ) {
    this.view = new SeatMapView(rawView);
    this.presenter = new TableEventPresenter(this.view, -1, audio);
  }

  start(): void {
    this.state.begin(this.opts.session);
    void this.pump();
  }

  stop(): void {
    this.abort.abort();
    this.cancelLocalPrompt();
    this.wake();
  }

  /** One event from the server (PokerClientGame.OnEventReceived). */
  receive(sequence: number, e: WireEvent): void {
    if (this.abort.signal.aborted) return;
    // The status is a once-a-second picture for the overlay, not part of the hand: applied on arrival.
    if (e.type === 'TournamentStatus') {
      this.state.begin(this.opts.session);
      this.state.onStatus(e);
      return;
    }
    // "You're now looking at another table": what is still queued belongs to the table being left.
    // (A queued result is kept: the server sends a knockout's result right before the "watch" view, and dropping it
    // would lose the knockout panel and its XP.)
    if (e.type === 'TournamentView') {
      const keep = this.queue.filter((q) => q.event.type === 'TournamentResult');
      this.queue.length = 0;
      this.queue.push(...keep);
    }
    this.queue.push({ event: e, arrivedAt: this.opts.now(), catchUp: sequence === OUT_OF_BAND });
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  private pause(seconds: number): Promise<void> {
    return this.opts.wait(seconds, this.abort.signal);
  }

  // ---- Presentation pump (mirrors PokerGameController's event loop) ---

  private async pump(): Promise<void> {
    const p = this.opts.pacing;
    while (!this.abort.signal.aborted) {
      const q = this.queue.shift();
      if (!q) {
        await new Promise<void>((r) => (this.waiter = r));
        continue;
      }
      // Catch-up is a snapshot of a hand already on the felt: painted in one go and silently.
      const paced = !q.catchUp;
      this.presenter.silent = q.catchUp;
      const e = q.event;
      switch (e.type) {
        case 'TournamentView': this.onTournamentView(e); break;
        case 'TournamentResult': this.onTournamentResult(e); break;
        case 'TableRoster': this.onRoster(e.seats); break;
        case 'HandStarted':
          this.ensurePerspective(e.seats);
          this.myCurrentBet = 0;
          this.presenter.onHandStarted(e);
          break;
        case 'BlindPosted':
          if (e.seat === this.localSeat) this.myCurrentBet = e.amount;
          this.presenter.onBlindPosted(e);
          if (paced) await this.pause(p.dealDelay);
          break;
        case 'HoleCardsDealt':
          this.presenter.onHoleCardsDealt(e); // other seats arrive as HIDDEN_CARD, drawn face down
          if (paced) await this.pause(p.dealDelay);
          break;
        case 'BettingRoundChanged':
          this.myCurrentBet = 0;
          this.presenter.onRoundChanged(e);
          if (paced && e.round === BettingRound.Preflop) await this.pause(p.dealSettleDelay);
          break;
        case 'CommunityDealt':
          this.presenter.onCommunityDealt(e);
          if (paced) await this.pause(p.dealSettleDelay);
          break;
        case 'TurnStarted': this.onTurnStarted(e.seat, e.forYou, e.turnSeconds, e.legal, this.opts.now() - q.arrivedAt); break;
        case 'PlayerActed':
          if (e.seat === this.turnSeat) this.clearTurnIndicator();
          if (e.seat === this.localSeat) {
            this.myCurrentBet = e.amount;
            this.cancelLocalPrompt(); // the server may have timed us out; drop a stale panel
          }
          this.presenter.onPlayerActed(e);
          if (paced) await this.pause(p.actionDelay);
          break;
        case 'Showdown':
          this.presenter.onShowdown(e);
          if (paced) await this.pause(p.showdownDelay);
          break;
        case 'PotAwarded':
          this.presenter.onPotAwarded(e);
          if (paced) await this.pause(p.showdownDelay);
          break;
        case 'HandEnded':
          this.clearTurnIndicator();
          this.cancelLocalPrompt();
          this.presenter.onHandEnded(e);
          break;
        case 'GameOver': this.presenter.onGameOver(e); break;
        case 'Reaction': this.presenter.onReaction(e); break;
        case 'VoiceState': this.presenter.onVoiceState(e); break;
        default: break;
      }
    }
  }

  /**
   * The server moved this player's view: to their seat at a new table, to a table they watch, or off the felt while
   * they wait. The felt is cleared and painted again from the catch-up that follows. Port of OnTournamentView.
   */
  private onTournamentView(e: TournamentViewEvent): void {
    this.state.begin(this.opts.session);
    this.cancelLocalPrompt();
    this.clearTurnIndicator();
    this.rawView.betting?.hide();
    (this.rawView as { clearTable?: () => void }).clearTable?.();
    this.view.reset();
    this.myCurrentBet = 0;
    this.turnSeat = -1;
    this.localSeat = e.yourSeat;
    this.presenter = new TableEventPresenter(this.view, this.localSeat, this.audio);
    this.needsPerspective = e.tableId >= 0;

    this.view.showMessage(
      e.reason === TournamentViewReason.BeforeStart ? 'The tournament starts soon.'
        : e.reason === TournamentViewReason.Waiting ? 'Waiting for the next round.'
          : e.reason === TournamentViewReason.Watching ? `Watching table ${e.tableId + 1}.`
            : e.countdownSeconds > 0 ? `${e.isFinal ? 'Final table' : `Round ${e.round}`} · first hand in ${e.countdownSeconds}s` : '',
    );
    this.state.onView(e);
  }

  private onTournamentResult(e: TournamentResultEvent): void {
    this.state.begin(this.opts.session);
    this.state.onResult(e);
    if (e.xpEarned > 0 && this.state.tryClaimXp(this.opts.session, e.finished)) this.opts.grantXp?.(e.xpEarned);
  }

  private ensurePerspective(seats: readonly SeatSnapshot[]): void {
    const occupied = seats.map((s, i) => (s && s.isOccupied ? i : -1)).filter((i) => i >= 0);
    if (!this.needsPerspective && this.view.covers(occupied)) return;
    this.needsPerspective = false;
    this.view.setPerspective(occupied, this.localSeat, Math.max(TournamentRules.SeatsPerTable, seats.length));
  }

  /** Occupied seats keep their hand state; only empty↔occupied changes sit or hide a HUD. */
  private onRoster(seats: readonly SeatSnapshot[]): void {
    const fresh = this.needsPerspective;
    this.ensurePerspective(seats);
    seats.forEach((s, seat) => {
      if (s && s.isOccupied) {
        const name = s.isLeaving ? `${s.name} (leaving)` : (s.name ?? '');
        if (fresh) this.view.bindSeat(seat, name, s.stack, s.isBot, s.avatar, s.name);
      } else {
        this.view.hideSeat(seat);
      }
    });
  }

  private onTurnStarted(seat: number, forYou: boolean, turnSeconds: number, legal: LegalActions, backlog: number): void {
    this.cancelLocalPrompt();
    this.clearTurnIndicator();
    this.turnSeat = seat;
    this.view.setTurn(seat, turnSeconds, backlog);
    if (!forYou) return;

    this.audio.play(PokerSound.YourTurn);
    this.audio.startTurnTimer(turnSeconds - backlog);
    const betting = this.rawView.betting;
    if (!betting) return;
    this.promptOpen = true;
    betting.show(legal, this.myCurrentBet, (action) => {
      if (!this.promptOpen) return;
      this.promptOpen = false;
      betting.hide();
      this.audio.stopTurnTimer();
      this.opts.submitAction(seat, action);
    });
  }

  private cancelLocalPrompt(): void {
    if (this.promptOpen) {
      this.promptOpen = false;
      this.rawView.betting?.hide();
    }
    this.audio.stopTurnTimer();
  }

  private clearTurnIndicator(): void {
    if (this.turnSeat >= 0) this.view.clearTurn(this.turnSeat);
    this.turnSeat = -1;
  }
}
