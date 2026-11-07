import { CryptoRandom, SeededRandom, type IRandom } from '../cards/random';
import { PlayerAction, type LegalActions } from '../actions/actions';
import { HeuristicBot } from '../bots/heuristicBot';
import { positionOf, type BotContext, type IPokerBot } from '../bots/botContext';
import { PokerEngine } from '../engine/pokerEngine';
import { BettingRound } from '../state/state';
import type { ActionRequestedEvent, EngineEvent } from '../events/pokerEvent';
import { AvatarCatalog } from '../social/avatarCatalog';
import {
  ActionRouter, BotActionProvider, HumanActionProvider, realWait, type ActionRequest, type WaitFn,
} from './actionProviders';
import { PokerSound, type AudioPort } from './pokerSound';
import { TableEventPresenter } from './tableEventPresenter';
import { DEFAULT_TABLE_SETTINGS, type TableSettings } from './tableSettings';
import type { TableViewPort } from './tableView';

export const HUMAN_SEAT = 0;

export interface PokerGameControllerOptions {
  /** Every pause goes through this (default: setTimeout). Tests pass a virtual clock. */
  wait?: WaitFn;
  /** Uniform [0,1) source for bot think time (Unity's UnityEngine.Random). Default Math.random. */
  thinkRandom?: () => number;
  /**
   * Deck RNG when useFixedSeed is false. Unity uses `new SeededRandom()` (tick-count seeded System.Random);
   * default here is CryptoRandom. Ignored when useFixedSeed is true (then SeededRandom(seed), bit-exact with Unity).
   */
  random?: IRandom;
  /**
   * Unity quirk: PokerGameController stops pumping at HandEnded, so the GameOver event emitted right after it is
   * never presented ("X wins the game!" never shows offline). Default false = faithful. Set true to present it.
   */
  presentGameOver?: boolean;
}

/**
 * The single-player table: owns the engine, seats one human (seat 0) plus HeuristicBots, and pumps the engine's
 * event stream through a paced loop. Port of Game/PokerGameController.cs (MonoBehaviour → async loop).
 *
 * Usage: `const c = new PokerGameController(settings, view, audio); c.start();` — `stop()` abandons the loop
 * (Unity has no equivalent; the scene unloads instead).
 */
export class PokerGameController {
  readonly settings: TableSettings;
  readonly engine: PokerEngine;
  readonly presenter: TableEventPresenter;
  readonly router = new ActionRouter();
  readonly bots = new Map<number, IPokerBot>();

  private readonly queue: EngineEvent[] = [];
  private readonly wait: WaitFn;
  private readonly presentGameOver: boolean;
  private readonly abort = new AbortController();
  private gameOver = false;
  private queueWaiter: (() => void) | null = null;
  private running: Promise<void> | null = null;

  constructor(settings: Partial<TableSettings>, private readonly view: TableViewPort, private readonly audio: AudioPort, opts: PokerGameControllerOptions = {}) {
    this.settings = { ...DEFAULT_TABLE_SETTINGS, ...settings };
    this.wait = opts.wait ?? realWait;
    this.presentGameOver = opts.presentGameOver ?? false;

    if (this.settings.seatCount > view.seatCount) {
      console.warn(`[Poker] seatCount (${this.settings.seatCount}) exceeds the wired seat views (${view.seatCount}); clamping.`);
      this.settings.seatCount = view.seatCount;
    }

    // ---- BuildEngine ----
    const s = this.settings;
    const rng: IRandom = s.useFixedSeed ? new SeededRandom(s.seed) : (opts.random ?? new CryptoRandom());
    this.engine = new PokerEngine({ seatCount: s.seatCount, smallBlind: s.smallBlind, bigBlind: s.bigBlind, startingStack: s.startingStack }, rng);
    this.engine.onEvent((e) => this.onEngineEvent(e));
    this.presenter = new TableEventPresenter(view, HUMAN_SEAT, audio);

    // Human takes seat 0.
    this.engine.seatPlayer(HUMAN_SEAT, 'human', s.playerName, false, s.startingStack);
    if (view.betting) this.router.set(HUMAN_SEAT, new HumanActionProvider(view.betting));

    // Bots fill the remaining seats, up to botCount: ids "bot{seat}", names "Bot 1".."Bot N".
    let botsSeated = 0;
    let botLabel = 1;
    for (let seat = 0; seat < s.seatCount && botsSeated < s.botCount; seat++) {
      if (seat === HUMAN_SEAT) continue;
      const botSeed = s.useFixedSeed ? s.seed + seat * 101 : null;
      const bot = new HeuristicBot(botSeed);
      this.engine.seatPlayer(seat, `bot${seat}`, `Bot ${botLabel}`, true, s.startingStack);
      this.bots.set(seat, bot);
      this.router.set(seat, new BotActionProvider(bot, s.botThinkMin, s.botThinkMax, this.wait, opts.thinkRandom ?? Math.random));
      botsSeated++;
      botLabel++;
    }

    // Bind seat HUDs to occupants; hide unused seats. (Avatar None → the name's default face.)
    for (let seat = 0; seat < s.seatCount; seat++) {
      const p = this.engine.table.seats[seat]!;
      if (p.isOccupied) view.bindSeat(seat, p.name ?? '', p.stack, p.isBot, AvatarCatalog.None, p.name);
      else view.hideSeat(seat);
    }
  }

  /** Starts the game loop (Unity: Start → StartCoroutine(GameLoop)). Resolves when the game ends or stop() is called. */
  start(): Promise<void> {
    this.running ??= this.gameLoop();
    return this.running;
  }

  stop(): void {
    this.abort.abort();
    this.view.betting?.hide();
    this.audio.stopTurnTimer();
    this.wakeQueue();
  }

  get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  private onEngineEvent(e: EngineEvent): void {
    this.queue.push(e);
    this.wakeQueue();
  }

  private wakeQueue(): void {
    const w = this.queueWaiter;
    this.queueWaiter = null;
    w?.();
  }

  private async pause(seconds: number): Promise<void> {
    // Unity: Wait(0) returns null = one frame.
    await this.wait(seconds > 0 ? seconds : 0, this.abort.signal);
  }

  // ---- Main loop -----------------------------------------------------

  private async gameLoop(): Promise<void> {
    await this.pause(0); // let the HUD initialize

    while (!this.gameOver && !this.stopped && this.engine.countFundedPlayers() >= 2) {
      this.engine.startHand();
      await this.processEventsUntilHandEnds();
      if (this.gameOver || this.stopped) break;
      await this.pause(this.settings.betweenHands);
    }

    if (this.presentGameOver && !this.stopped) {
      const go = this.queue.find((e) => e.type === 'GameOver');
      if (go && go.type === 'GameOver') this.presenter.onGameOver(go);
    }
  }

  private async processEventsUntilHandEnds(): Promise<void> {
    const s = this.settings;
    let handEnded = false;
    while (!handEnded && !this.stopped) {
      const e = this.queue.shift();
      if (!e) {
        await new Promise<void>((r) => (this.queueWaiter = r));
        continue;
      }
      switch (e.type) {
        case 'HandStarted': this.presenter.onHandStarted(e); break;
        case 'BlindPosted': this.presenter.onBlindPosted(e); await this.pause(s.dealDelay); break;
        case 'HoleCardsDealt': this.presenter.onHoleCardsDealt(e); await this.pause(s.dealDelay); break;
        case 'BettingRoundChanged':
          this.presenter.onRoundChanged(e);
          // Preflop opens straight after the hole cards fly in; hold betting until the deal settles.
          if (e.round === BettingRound.Preflop) await this.pause(s.dealSettleDelay);
          break;
        case 'CommunityDealt': this.presenter.onCommunityDealt(e); await this.pause(s.dealSettleDelay); break;
        case 'ActionRequested': await this.onActionRequested(e); break;
        case 'PlayerActed': this.presenter.onPlayerActed(e); await this.pause(s.actionDelay); break;
        case 'Showdown': this.presenter.onShowdown(e); await this.pause(s.showdownDelay); break;
        case 'PotAwarded': this.presenter.onPotAwarded(e); await this.pause(s.showdownDelay); break;
        case 'HandEnded': this.presenter.onHandEnded(e); handEnded = true; break;
        case 'GameOver': this.presenter.onGameOver(e); this.gameOver = true; handEnded = true; break;
      }
    }
  }

  // ---- Action requests -------------------------------------------------

  private async onActionRequested(e: ActionRequestedEvent): Promise<void> {
    const s = this.settings;
    this.view.setTurn(e.seat, s.turnTimer);

    // Only the human is announced and ticked.
    const isHuman = e.seat === HUMAN_SEAT;
    if (isHuman) {
      this.audio.play(PokerSound.YourTurn);
      this.audio.startTurnTimer(s.turnTimer);
    }

    const request = this.buildRequest(e);
    let submitted = false;
    let wake: () => void = () => {};
    const answered = new Promise<void>((r) => (wake = r));
    const submit = (a: PlayerAction) => {
      if (submitted) return; // first response wins (the provider, or the timeout)
      submitted = true;
      this.engine.submitAction(e.seat, a);
      wake();
    };

    const provider = this.router.get(e.seat);
    if (!provider) {
      submit(PlayerAction.fold()); // no provider (shouldn't happen): fold to keep the game moving
    } else {
      const turn = new AbortController();
      const onStop = () => turn.abort();
      this.abort.signal.addEventListener('abort', onStop, { once: true });
      void provider.requestAction(request, submit, turn.signal);
      const deadline = new AbortController();
      await Promise.race([answered, this.wait(s.turnTimer, deadline.signal)]);
      deadline.abort(); // release the deadline timer if the provider answered first
      this.abort.signal.removeEventListener('abort', onStop);

      if (!submitted && !this.stopped) {
        // Time's up: abandon the pending request and take the safe default.
        turn.abort();
        this.view.betting?.hide();
        submit(timeoutAction(request.legal));
      }
    }

    if (isHuman) this.audio.stopTurnTimer();
    this.view.clearTurn(e.seat);
  }

  private buildRequest(e: ActionRequestedEvent): ActionRequest {
    const t = this.engine.table;
    const p = t.seats[e.seat]!;
    const context: BotContext = {
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
    return { seat: e.seat, legal: e.legal, context };
  }
}

/** When a seat's turn timer expires: check for free if possible, otherwise fold. */
export function timeoutAction(legal: LegalActions): PlayerAction {
  return legal.canCheck ? PlayerAction.check() : PlayerAction.fold();
}
