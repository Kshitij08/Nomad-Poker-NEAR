/**
 * A player's half of a networked table — port of Assets/Scripts/Net/PokerClientGame.cs. It decodes the server's
 * replicated event stream and drives the exact same TableViewPort + TableEventPresenter the single-player game uses.
 * It holds no engine and no other player's cards; when a TurnStarted is for the local seat it shows the existing
 * betting panel and sends the choice back. Pacing lives here (the server replicates instantly), so the animations
 * look identical to single player.
 *
 * DOM-free: the browser gives it the 3D table view; the headless test clients give it a recording view.
 */
import { PlayerAction, type ActionType, type LegalActions } from '../core/actions/actions';
import type {
  BettingRoundChangedEvent, BlindPostedEvent, HandEndedEvent, HandStartedEvent, LobbyStateEvent, PlayerActedEvent,
  PotAwardedEvent, SeatSnapshot, ShowdownEvent, TableEconomyEvent, TableRosterEvent, TurnStartedEvent,
} from '../core/events/pokerEvent';
import { TablePhase } from '../core/events/pokerEvent';
import { PokerEventCodec, type WireEvent } from '../core/events/pokerEventCodec';
import type { TournamentViewEvent } from '../core/events/tournamentEvents';
import { TournamentViewReason } from '../core/events/tournamentEvents';
import { HumanActionProvider, type WaitFn } from '../core/orchestration/actionProviders';
import { PokerSound, type AudioPort } from '../core/orchestration/pokerSound';
import { TableEventPresenter } from '../core/orchestration/tableEventPresenter';
import type { TableViewPort } from '../core/orchestration/tableView';
import { AvatarCatalog } from '../core/social/avatarCatalog';
import { BettingRound } from '../core/state/state';
import type { NetConnection } from './netConnection';
import { PokerChatRateLimiter } from './shared/chat';
import type { ServerMessage } from './shared/protocol';
import { ChainTableMode } from './shared/sessions';

/** What PokerClientGame needs from TableView beyond the single-player port. */
export interface NetTableViewPort extends TableViewPort {
  /** Rotates the table so `localSeat` renders at HUD slot `localSlot` (negative = identity). */
  setLocalPerspective(localSeat: number, localSlot: number): void;
  /** Name, picture and bot badge only (a roster tick mid-hand). */
  updateSeatLabel(seat: number, playerName: string, isBot: boolean, avatar: number, avatarName: string | null): void;
  isSeatVisible(seat: number): boolean;
  hideAllSeats(): void;
  clearTable(): void;
  /** The HUD slot the local player is always drawn at (PokerClientGame.localPerspectiveSeat → Name_Canvas = 0). */
  readonly localSlot: number;
}

/** PokerClientIdentity + the hello's buy-in. */
export interface ClientIdentity {
  readonly playerName: string;
  readonly token: string;
  /** The ticket the server's ledger verifies (locally: `local:<playerId>:<coins>`). */
  sessionTicket(): string;
  /** PlayerAvatar.Current (AvatarCatalog id, 0 = none). */
  readonly avatar: number;
  /** StakeSelection.SelectedBuyInChips for Quick Play. */
  selectedBuyInChips(): number;
}

/** The HUD wallet cache (PlayFabWallet.Adopt / VirtualEconomy). */
export interface WalletPort {
  readonly coins: number;
  /** The server's authoritative balance. */
  adopt(balance: number): void;
}

export interface ClientGameOptions {
  view: NetTableViewPort;
  audio: AudioPort;
  conn: NetConnection;
  identity: ClientIdentity;
  wallet?: WalletPort;
  /** Every pacing pause (tickerWait in the browser: time scale / ?paused apply). */
  wait: WaitFn;
  /** Seconds, monotonic (Time.time). */
  now?: () => number;
  /** PokerClientGame pacing in Test.unity: 0.12 / 4 / 0.4 / 2. */
  pacing?: Partial<{ dealDelay: number; dealSettleDelay: number; actionDelay: number; showdownDelay: number }>;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Every event after it was presented (retention progress, telemetry). */
  onPresented?: (event: WireEvent, catchUp: boolean) => void;
}

interface QueuedEvent {
  event: WireEvent;
  arrivedAt: number;
  catchUp: boolean;
}

export type ClientGameChange = 'lobby' | 'roster' | 'seat' | 'economy' | 'joining' | 'turn' | 'message' | 'closed';

export class ClientGame {
  private readonly view: NetTableViewPort;
  private readonly conn: NetConnection;
  private readonly identity: ClientIdentity;
  private readonly wait: WaitFn;
  private readonly now: () => number;
  private readonly log: NonNullable<ClientGameOptions['log']>;
  private readonly pacing: { dealDelay: number; dealSettleDelay: number; actionDelay: number; showdownDelay: number };
  private presenter: TableEventPresenter;

  private readonly queue: QueuedEvent[] = [];
  private queueWaiter: (() => void) | null = null;
  private expectedSequence = -1;
  private _localSeat = -1;
  private myCurrentBet = 0;
  private turnSeat = -1;
  private promptAbort: AbortController | null = null;
  private _lobby: LobbyStateEvent | null = null;
  private _roster: SeatSnapshot[] | null = null;
  private liveStacks: number[] = [];
  private _tableEconomy: TableEconomyEvent | null = null;
  private _joining = false;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private optimisticBuyInDebit = 0;
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly off: (() => void)[] = [];
  private readonly reactionLimiter = new PokerChatRateLimiter(4, 1.5);
  private readonly listeners = new Set<(what: ClientGameChange) => void>();
  /** The last table-centre message (PotView.messageText is not wired in Unity, so it is never drawn; chrome may read it). */
  lastMessage = '';
  /** Lost-sequence errors seen (tests assert zero). */
  sequenceErrors = 0;
  handsSeen = 0;

  constructor(private readonly opts: ClientGameOptions) {
    this.view = opts.view;
    this.conn = opts.conn;
    this.identity = opts.identity;
    this.wait = opts.wait;
    this.now = opts.now ?? (() => performance.now() / 1000);
    this.log = opts.log ?? ((level, m) => console[level === 'info' ? 'log' : level](m));
    this.pacing = { dealDelay: 0.12, dealSettleDelay: 4, actionDelay: 0.4, showdownDelay: 2, ...opts.pacing };
    this.presenter = new TableEventPresenter(this.view, this._localSeat, opts.audio);
  }

  // ---- State the chrome reads (PokerLobbyView, SeatActionButtons, reaction panel…) -----------------

  get localSeat(): number {
    return this._localSeat;
  }

  get lobby(): LobbyStateEvent | null {
    return this._lobby;
  }

  get roster(): SeatSnapshot[] | null {
    return this._roster;
  }

  get tableEconomy(): TableEconomyEvent | null {
    return this._tableEconomy;
  }

  get isChipTable(): boolean {
    return this._tableEconomy !== null;
  }

  /** Solana escrow tables only — always false for Coins tables. */
  readonly isMoneyTable = false;

  /** Escrow recovery only. Chip-table stacks return via leave. */
  readonly canCashOut = false;

  get isTournament(): boolean {
    return ChainTableMode.isTournamentSession(this.roomCode);
  }

  get isPrivateTable(): boolean {
    if (this.isTournament) return false;
    if (this._lobby && !this._lobby.autoStart) return true;
    return ChainTableMode.isPrivateSession(this.roomCode, this.conn.properties[ChainTableMode.KindProperty]);
  }

  get isTableOwner(): boolean {
    return !!this._lobby?.youAreOwner;
  }

  get phase(): TablePhase {
    return this._lobby?.phase ?? TablePhase.Lobby;
  }

  get canStart(): boolean {
    return !!this._lobby && this._lobby.phase !== TablePhase.Playing && this._lobby.seatedCount >= this._lobby.minToStart;
  }

  get joiningNextHand(): boolean {
    return !!this._lobby?.youJoinNextHand;
  }

  get canBuyIn(): boolean {
    return !!this._lobby?.youCanBuyIn;
  }

  get isJoining(): boolean {
    return this._joining;
  }

  /** The room code players join with — the session name. */
  get roomCode(): string {
    return this.conn.session ?? '';
  }

  /** Pressing Join Table now would be accepted. */
  get canJoinTable(): boolean {
    if (!this.isChipTable || this._tableEconomy!.halted) return false;
    if (this._localSeat < 0 && this.isPrivateTable && this._lobby) return true;
    return this._localSeat < 0 && !!this._lobby && this._lobby.youCanBuyIn;
  }

  get canReact(): boolean {
    return this.conn.isOpen && this._localSeat >= 0 && this.reactionLimiter.secondsUntilNextToken(this.now()) <= 0;
  }

  get reactionCooldownRemaining(): number {
    return this.reactionLimiter.secondsUntilNextToken(this.now());
  }

  /** Chips this player would take home now — the stack the seat HUD shows. */
  localChips(): number {
    if (this._localSeat < 0) return 0;
    if (this._localSeat < this.liveStacks.length) return this.liveStacks[this._localSeat] ?? 0;
    return this._roster?.[this._localSeat]?.stack ?? 0;
  }

  onChange(fn: (what: ClientGameChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(what: ClientGameChange): void {
    for (const fn of [...this.listeners]) fn(what);
  }

  // ---- Commands ------------------------------------------------------------------------------

  sendReaction(reactionId: number): boolean {
    if (!this.conn.isOpen || this._localSeat < 0) return false;
    if (!this.reactionLimiter.tryConsume(this.now())) return false;
    this.conn.send({ t: 'reaction', id: reactionId & 0xff });
    return true;
  }

  sendVoiceState(talking: boolean, muted: boolean): void {
    this.conn.send({ t: 'voiceState', talking, muted });
  }

  requestAddBot(): void {
    this.conn.send({ t: 'addBot' });
  }

  requestRemoveBot(seat = -1): void {
    this.conn.send({ t: 'removeBot', seat });
  }

  requestStartGame(): void {
    this.conn.send({ t: 'startGame' });
  }

  /** Give up this seat on purpose — immediate, unlike simply dropping the connection. */
  requestLeaveTable(): void {
    this.conn.send({ t: 'leaveTable' });
  }

  requestBuyIn(): void {
    if (!this.isChipTable) {
      this.showMessage('This table has no Coins ledger — cannot sit.');
      return;
    }
    if (this._tableEconomy!.halted) {
      this.showMessage('Table halted — leave to return your Coins.');
      this.requestLeaveTable();
      return;
    }
    this.requestJoinTable();
  }

  /** Called with the private-table prompt's amount when the table is private (PrivateBuyInPrompt.Open). */
  privateBuyInPrompt: ((game: ClientGame) => void) | null = null;

  requestJoinTable(): void {
    if (this._joining) return;
    if (!this.isChipTable) {
      this.showMessage('Waiting for Coins table…');
      return;
    }
    if (!this.canJoinTable) return;
    if (this.isPrivateTable) {
      if (this.privateBuyInPrompt) this.privateBuyInPrompt(this);
      else this.confirmPrivateBuyIn(ChainTableMode.PrivateMaxBuyIn);
      return;
    }
    this.sitWithBuyIn(this.tableBuyInChips());
  }

  /** The private-table slider confirmed an amount. */
  confirmPrivateBuyIn(amount: number): void {
    if (this._joining) return;
    const coins = this.opts.wallet?.coins ?? Number.MAX_SAFE_INTEGER;
    let cap = Math.min(coins, ChainTableMode.PrivateMaxBuyIn);
    let buyIn = Math.min(amount, cap);
    if (buyIn < ChainTableMode.PrivateMinBuyIn) buyIn = ChainTableMode.PrivateMinBuyIn;
    if (coins < buyIn) {
      this.showMessage(`Private tables buy in for ${ChainTableMode.PrivateMinBuyIn.toLocaleString('en-US')}–${ChainTableMode.PrivateMaxBuyIn.toLocaleString('en-US')} Coins. You have ${coins.toLocaleString('en-US')}.`);
      cap = 0;
      return;
    }
    this.sitWithBuyIn(buyIn);
  }

  /** Leave with Coins (CashOutPanel confirm is the chrome's): gives the seat up; the server cashes the stack out. */
  requestCashOutAndLeave(): void {
    this.requestLeaveTable();
  }

  private tableBuyInChips(): number {
    if (this.isPrivateTable) return ChainTableMode.PrivateMaxBuyIn;
    return this.identity.selectedBuyInChips();
  }

  private sitWithBuyIn(buyIn: number): void {
    this.applyOptimisticBuyInDebit(buyIn);
    this._joining = true;
    this.changed('joining');
    this.showMessage('Taking a seat…');
    this.conn.send({ t: 'buyIn', name: this.identity.playerName, token: this.identity.token, buyIn });
    // A buy-in the server cannot honour gets no seat back: hand the button back after a few seconds.
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null;
      if (!this._joining || this._localSeat >= 0) return;
      this._joining = false;
      if (this.optimisticBuyInDebit > 0 && this.opts.wallet) {
        this.opts.wallet.adopt(this.opts.wallet.coins + this.optimisticBuyInDebit);
        this.optimisticBuyInDebit = 0;
      }
      this.showMessage('No seat came free — try again in a moment.');
      this.changed('joining');
    }, 6000);
  }

  private applyOptimisticBuyInDebit(buyIn: number): void {
    const w = this.opts.wallet;
    if (!w || buyIn <= 0 || this.optimisticBuyInDebit > 0) return;
    this.optimisticBuyInDebit = buyIn;
    w.adopt(Math.max(0, w.coins - buyIn));
  }

  private applyOptimisticCashOutCredit(stackReturned: number): void {
    const w = this.opts.wallet;
    if (!w) return;
    if (this.optimisticBuyInDebit > 0 && stackReturned <= 0) {
      w.adopt(w.coins + this.optimisticBuyInDebit);
      this.optimisticBuyInDebit = 0;
      return;
    }
    this.optimisticBuyInDebit = 0;
    if (stackReturned > 0) w.adopt(w.coins + stackReturned);
  }

  // ---- Lifecycle -------------------------------------------------------------------------------

  /** Activate: the connection has joined a session. Clears the felt, says hello and starts the pump. */
  start(): void {
    this.view.clearTable();
    this.view.hideAllSeats();
    this.view.betting?.hide();
    this.showMessage('Waiting for players…');
    this.off.push(
      this.conn.onBinary((b) => this.enqueuePayload(b)),
      this.conn.onMessage((m) => this.onControl(m)),
      this.conn.onClose(() => this.changed('closed')),
    );
    // HelloWhenReady: the session is live, so say who we are, then the picture.
    this.conn.send({ t: 'hello', name: this.identity.playerName, token: this.identity.token, ticket: this.identity.sessionTicket(), buyIn: this.tableBuyInChips() });
    if (AvatarCatalog.isValid(this.identity.avatar)) this.conn.send({ t: 'avatar', avatar: this.identity.avatar });
    void this.pump();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.cancelLocalPrompt();
    this.opts.audio.stopTurnTimer();
    this.view.betting?.hide();
    for (const f of this.off.splice(0)) f();
    if (this.joinTimer) clearTimeout(this.joinTimer);
    const w = this.queueWaiter;
    this.queueWaiter = null;
    w?.();
  }

  private onControl(m: ServerMessage): void {
    switch (m.t) {
      case 'assignSeat':
        this.onSeatAssigned(m.seat);
        break;
      case 'walletBalance':
        this.optimisticBuyInDebit = 0;
        this.opts.wallet?.adopt(m.balance);
        break;
      case 'shutdown':
        this.showMessage('The table closed.');
        this.changed('closed');
        break;
      default:
        break;
    }
  }

  onSeatAssigned(seat: number): void {
    if (this.isTournament) {
      this._localSeat = seat;
      this.presenter.localSeat = seat;
      this.changed('seat');
      return;
    }
    const previousSeat = this._localSeat;
    const stackAtRelease = seat < 0 && previousSeat >= 0 ? this.localChips() : 0;

    this._localSeat = seat;
    this.presenter.localSeat = seat;
    // Rotate the table so this player sits at the designated local HUD; negative = raw seats.
    this.view.setLocalPerspective(seat, this.view.localSlot);
    this.applyRosterHud();

    if (seat >= 0) {
      if (this.optimisticBuyInDebit <= 0) this.applyOptimisticBuyInDebit(this.tableBuyInChips());
    } else {
      this.view.betting?.hide(); // a panel left open would submit for a seat we no longer own
      if (this._joining && this.isPrivateTable)
        this.showMessage(`Couldn't take the seat. Private tables need ${ChainTableMode.PrivateMinBuyIn.toLocaleString('en-US')}–${ChainTableMode.PrivateMaxBuyIn.toLocaleString('en-US')} Coins.`);
      else this.showMessage('Watching the table.');
      this.applyOptimisticCashOutCredit(stackAtRelease);
    }
    this._joining = false;
    this.changed('seat');
    this.changed('joining');
  }

  // ---- Event intake (EnqueuePayload) --------------------------------------------------------------

  enqueuePayload(payload: Uint8Array): void {
    let event: WireEvent | null;
    let sequence: number;
    try {
      ({ event, sequence } = PokerEventCodec.decode(payload));
    } catch (ex) {
      this.log('error', `[PokerClient] Undecodable event payload (${payload.length} bytes), dropped: ${(ex as Error)?.message ?? ex}`);
      return;
    }
    if (!event) {
      if (sequence !== PokerEventCodec.OutOfBandSequence) this.expectedSequence = sequence + 1;
      return;
    }
    if (event.type === 'TournamentView') {
      this.queue.length = 0;
      this.expectedSequence = -1;
    }
    if (sequence === PokerEventCodec.OutOfBandSequence) {
      this.push({ event, arrivedAt: this.now(), catchUp: true });
      return;
    }
    if (this.expectedSequence >= 0 && sequence !== this.expectedSequence) {
      this.sequenceErrors++;
      this.log('error', `[PokerClient] Lost event(s): got seq ${sequence}, expected ${this.expectedSequence}. The table may now be a hand behind.`);
    }
    this.expectedSequence = sequence + 1;
    this.push({ event, arrivedAt: this.now(), catchUp: false });
  }

  private push(q: QueuedEvent): void {
    this.queue.push(q);
    const w = this.queueWaiter;
    this.queueWaiter = null;
    w?.();
  }

  // ---- Presentation pump (mirrors PokerGameController's event loop) -------------------------------

  private async pause(seconds: number): Promise<void> {
    if (seconds > 0) await this.wait(seconds, this.abort.signal);
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const q = this.queue.shift();
      if (!q) {
        await new Promise<void>((r) => (this.queueWaiter = r));
        continue;
      }
      // Catch-up paints a hand already on the felt in one go, silently.
      const paced = !q.catchUp;
      this.presenter.silent = q.catchUp;
      try {
        const e = q.event;
        switch (e.type) {
          case 'TableRoster': this.onRoster(e); break;
          case 'LobbyState': this.onLobbyState(e); break;
          case 'TableEconomy': this.onTableEconomy(e); break;
          case 'HandStarted': this.onHandStarted(e); break;
          case 'BlindPosted':
            this.onBlindPosted(e);
            if (paced) await this.pause(this.pacing.dealDelay);
            break;
          case 'HoleCardsDealt':
            this.presenter.onHoleCardsDealt(e);
            if (paced) await this.pause(this.pacing.dealDelay);
            break;
          case 'BettingRoundChanged':
            this.onRoundChanged(e);
            if (paced && e.round === BettingRound.Preflop) await this.pause(this.pacing.dealSettleDelay);
            break;
          case 'CommunityDealt':
            this.presenter.onCommunityDealt(e);
            if (paced) await this.pause(this.pacing.dealSettleDelay);
            break;
          case 'TurnStarted': this.onTurnStarted(e, this.now() - q.arrivedAt); break;
          case 'PlayerActed':
            this.onPlayerActed(e);
            if (paced) await this.pause(this.pacing.actionDelay);
            break;
          case 'Showdown':
            this.onShowdown(e);
            if (paced) await this.pause(this.pacing.showdownDelay);
            break;
          case 'PotAwarded':
            this.onPotAwarded(e);
            if (paced) await this.pause(this.pacing.showdownDelay);
            break;
          case 'HandEnded': this.onHandEnded(e); break;
          case 'GameOver': this.presenter.onGameOver(e); break;
          // Unpaced: a reaction is somebody talking over the hand, not part of it.
          case 'Reaction': this.presenter.onReaction(e); break;
          case 'VoiceState': this.presenter.onVoiceState(e); break;
          case 'TournamentView': this.onTournamentView(e); break;
          default: break; // TournamentStatus / Result: the tournaments module listens on the connection itself
        }
      } catch (ex) {
        this.log('error', `[PokerClient] Presenting ${q.event.type} failed: ${(ex as Error)?.stack ?? ex}`);
      }
      this.presenter.silent = false;
      try {
        this.opts.onPresented?.(q.event, q.catchUp);
      } catch (ex) {
        this.log('error', `[PokerClient] onPresented failed: ${(ex as Error)?.message ?? ex}`);
      }
    }
  }

  private onTableEconomy(e: TableEconomyEvent): void {
    this._tableEconomy = e;
    if (e.halted) {
      this._joining = false;
      this.showMessage('Table halted — leave to return your Coins.');
    }
    this.changed('economy');
  }

  private onRoster(e: TableRosterEvent): void {
    this.announceRosterChange(this._roster, e.seats);
    this._roster = e.seats;
    e.seats.forEach((s, seat) => {
      if (s?.isOccupied) this.rememberStack(seat, s.stack);
    });
    this.applyRosterHud();
    this.changed('roster');
  }

  /** PlayerJoined / BotRemoved from the roster diff (first roster skipped: discovering a table, not it filling). */
  private announceRosterChange(before: SeatSnapshot[] | null, after: SeatSnapshot[]): void {
    if (!before || !after) return;
    let arrived = false;
    let botDismissed = false;
    for (let seat = 0; seat < Math.min(before.length, after.length); seat++) {
      const was = !!before[seat]?.isOccupied;
      const now = !!after[seat]?.isOccupied;
      if (!was && now) arrived = true;
      else if (was && !now && before[seat]!.isBot) botDismissed = true;
    }
    if (arrived) this.opts.audio.play(PokerSound.PlayerJoined);
    if (botDismissed) this.opts.audio.play(PokerSound.BotRemoved);
  }

  /** Only empty↔occupied changes sit or hide a HUD; a label tick covers "(next hand)" / "(leaving)". */
  private applyRosterHud(): void {
    const roster = this._roster;
    if (!roster) return;
    for (let seat = 0; seat < roster.length && seat < this.view.seatCount; seat++) {
      const s = roster[seat];
      if (s && s.isOccupied) {
        let name = s.name ?? '';
        if (s.isPendingNextHand) name = `${name} (next hand)`;
        else if (s.isLeaving) name = `${name} (leaving)`;
        if (s.isPendingNextHand || !this.view.isSeatVisible(seat)) this.view.bindSeat(seat, name, s.stack, s.isBot, s.avatar, s.name);
        else this.view.updateSeatLabel(seat, name, s.isBot, s.avatar, s.name);
      } else this.view.hideSeat(seat);
    }
  }

  private onLobbyState(e: LobbyStateEvent): void {
    if (this.isTournament) return;
    this._lobby = e;
    // Nothing belongs on the felt in the lobby: sweep what a previous game left behind.
    if (e.phase === TablePhase.Lobby) this.view.clearTable();
    if (e.phase === TablePhase.Playing && e.youJoinNextHand) this.showMessage("You're in from the next hand.");
    this.changed('lobby');
  }

  private onHandStarted(e: HandStartedEvent): void {
    e.seats.forEach((s, seat) => {
      if (s?.isOccupied) this.rememberStack(seat, s.stack);
    });
    this.handsSeen++;
    this.presenter.onHandStarted(e);
    this.applyRosterHud(); // pending next-hand joiners (including us) are not in the catch-up hand
  }

  private onBlindPosted(e: BlindPostedEvent): void {
    if (e.seat === this._localSeat) this.myCurrentBet = e.amount;
    this.rememberStack(e.seat, e.stackAfter);
    this.presenter.onBlindPosted(e);
  }

  private onRoundChanged(e: BettingRoundChangedEvent): void {
    this.myCurrentBet = 0; // bets reset every street
    this.presenter.onRoundChanged(e);
  }

  /** The server's clock started when it sent the event: the radial picks up the backlog + one-way latency. */
  private onTurnStarted(e: TurnStartedEvent, backlogSeconds: number): void {
    this.cancelLocalPrompt();
    this.clearTurnIndicator();
    this.turnSeat = e.seat;
    const elapsed = backlogSeconds + this.conn.oneWayLatency;
    this.view.setTurn(e.seat, e.turnSeconds, elapsed);
    this.changed('turn');
    if (!e.forYou) return;
    this.opts.audio.play(PokerSound.YourTurn);
    this.opts.audio.startTurnTimer(e.turnSeconds - elapsed);
    this.promptLocalAction(e.seat, e.legal);
  }

  private onPlayerActed(e: PlayerActedEvent): void {
    if (e.seat === this.turnSeat) this.clearTurnIndicator();
    if (e.seat === this._localSeat) {
      this.myCurrentBet = e.amount;
      this.cancelLocalPrompt(); // the server may have timed us out
      this.view.betting?.hide();
    }
    this.rememberStack(e.seat, e.stackAfter);
    this.presenter.onPlayerActed(e);
  }

  private onShowdown(e: ShowdownEvent): void {
    this.presenter.onShowdown(e);
  }

  private onPotAwarded(e: PotAwardedEvent): void {
    this.rememberStack(e.seat, e.stackAfter);
    this.presenter.onPotAwarded(e);
  }

  private onHandEnded(e: HandEndedEvent): void {
    this.clearTurnIndicator();
    this.cancelLocalPrompt();
    this.myCurrentBet = 0;
    this.presenter.onHandEnded(e);
  }

  private onTournamentView(e: TournamentViewEvent): void {
    this.cancelLocalPrompt();
    this.clearTurnIndicator();
    this.view.betting?.hide();
    this.view.clearTable();
    this.view.hideAllSeats();
    this._roster = null;
    this.liveStacks = [];
    this.myCurrentBet = 0;
    this.turnSeat = -1;
    this._localSeat = e.yourSeat;
    this.presenter = new TableEventPresenter(this.view, this._localSeat, this.opts.audio);
    this.view.setLocalPerspective(e.yourSeat, this.view.localSlot);
    this.showMessage(
      e.reason === TournamentViewReason.BeforeStart ? 'The tournament starts soon.'
      : e.reason === TournamentViewReason.Waiting ? 'Waiting for the next round.'
      : e.reason === TournamentViewReason.Watching ? `Watching table ${e.tableId + 1}.`
      : e.countdownSeconds > 0 ? `${e.isFinal ? 'Final table' : `Round ${e.round}`} · first hand in ${e.countdownSeconds}s` : '',
    );
    this.changed('seat');
  }

  private rememberStack(seat: number, stack: number): void {
    if (seat < 0) return;
    this.liveStacks[seat] = stack;
    const r = this._roster?.[seat];
    if (r) r.stack = stack;
  }

  private clearTurnIndicator(): void {
    if (this.turnSeat >= 0) this.view.clearTurn(this.turnSeat);
    this.turnSeat = -1;
    this.opts.audio.stopTurnTimer();
  }

  private cancelLocalPrompt(): void {
    this.promptAbort?.abort();
    this.promptAbort = null;
  }

  /** Reuses the single-player panel flow verbatim; only the submit target changes. */
  private promptLocalAction(seat: number, legal: LegalActions): void {
    const panel = this.view.betting;
    if (!panel) return;
    const ac = new AbortController();
    this.promptAbort = ac;
    const provider = new HumanActionProvider(panel);
    void provider.requestAction(
      { seat, legal, context: { seatIndex: seat, holeCards: [], community: [], round: BettingRound.None, pot: 0, myStack: 0, myCurrentBet: this.myCurrentBet, bigBlind: 0, opponentsInHand: 0, position: 0, legal } },
      (action) => {
        if (ac.signal.aborted) return;
        this.promptAbort = null;
        this.submitAction(seat, action);
      },
      ac.signal,
    );
  }

  /** PokerTableNet.SendAction. Exposed for headless clients and tests. */
  submitAction(seat: number, action: PlayerAction): void {
    this.conn.send({ t: 'action', seat, actionType: action.type, amount: action.amount });
  }

  private showMessage(message: string): void {
    this.lastMessage = message;
    this.view.showMessage(message);
    this.changed('message');
  }
}

export { PlayerAction, type ActionType };
