/**
 * A headless table client for the multi-client tests: the real ClientGame (port of PokerClientGame) over the real
 * NetConnection (Node 22's global WebSocket), with a recording view instead of the 3D table and a betting panel that
 * answers instantly with a scripted policy.
 */
import { PlayerAction, type LegalActions } from '@nomad/engine/actions/actions';
import type { Card } from '@nomad/engine/cards/card';
import { isHiddenCard } from '@nomad/engine/events/pokerEventCodec';
import { realWait, type WaitFn } from '@nomad/engine/orchestration/actionProviders';
import type { AudioPort } from '@nomad/engine/orchestration/pokerSound';
import type { BettingPanelPort, SeatRole } from '@nomad/engine/orchestration/tableView';
import { ClientGame, type NetTableViewPort } from '../../src/net/clientGame';
import type { NetConnection } from '../../src/net/netConnection';

export interface SeatState {
  visible: boolean;
  name: string;
  stack: number;
  status: string;
  isBot: boolean;
  reaction: number;
  talking: boolean;
}

export class RecordingView implements NetTableViewPort {
  readonly seatCount = 8;
  readonly localSlot = 0;
  readonly seats: SeatState[] = Array.from({ length: 8 }, () => ({ visible: false, name: '', stack: 0, status: '', isBot: false, reaction: 0, talking: false }));
  readonly log: string[] = [];
  /** Hole cards each logical seat was shown with, this hand (hidden = '??'). */
  holeCards = new Map<number, string>();
  board: string[] = [];
  pot = 0;
  perspective: { localSeat: number; localSlot: number } = { localSeat: -1, localSlot: -1 };
  turn = -1;
  handNumber = 0;

  /** "Show cards" offered after a hand (null when not offered). */
  showOffer: (() => void) | null = null;

  constructor(readonly betting: BettingPanelPort) {}

  offerShowCards(onShow: (() => void) | null): void {
    this.showOffer = onShow;
  }

  bindSeat(seat: number, name: string, stack: number, isBot: boolean): void {
    Object.assign(this.seats[seat]!, { visible: true, name, stack, isBot, status: '' });
  }
  hideSeat(seat: number): void {
    this.seats[seat]!.visible = false;
  }
  beginHand(n: number): void {
    this.handNumber = n;
    this.holeCards.clear();
    this.board = [];
    this.pot = 0;
    this.log.push(`hand ${n}`);
  }
  resetSeatForHand(seat: number, stack: number, _role: SeatRole, busted: boolean): void {
    Object.assign(this.seats[seat]!, { visible: true, stack, status: busted ? 'Busted' : '' });
  }
  showBlind(seat: number, stackAfter: number, _bet: number, potAfter: number): void {
    this.seats[seat]!.stack = stackAfter;
    this.pot = potAfter;
  }
  showHoleCards(seat: number, c0: Card, c1: Card): void {
    this.holeCards.set(seat, isHiddenCard(c0) || isHiddenCard(c1) ? '??' : c0.short + c1.short);
  }
  showBoard(_n: Card[], board: Card[]): void {
    this.board = board.map((c) => c.short);
  }
  showAction(seat: number, stackAfter: number, _bet: number, description: string, potAfter: number): void {
    Object.assign(this.seats[seat]!, { stack: stackAfter, status: description });
    this.pot = potAfter;
    this.log.push(`act ${seat} ${description}`);
  }
  showShowdown(seat: number, c0: Card, c1: Card, description: string): void {
    this.holeCards.set(seat, c0.short + c1.short);
    this.seats[seat]!.status = description;
  }
  showPotAward(seat: number, stackAfter: number, message: string, pot: number): void {
    this.seats[seat]!.stack = stackAfter;
    this.pot = pot;
    this.log.push(`award ${seat} ${message}`);
  }
  endHand(): void {
    this.log.push('end');
  }
  showMessage(): void {}
  showGameOver(m: string): void {
    this.log.push(`gameover ${m}`);
  }
  setTurn(seat: number): void {
    this.turn = seat;
  }
  clearTurn(): void {
    this.turn = -1;
  }
  showReaction(seat: number, id: number): void {
    this.seats[seat]!.reaction = id;
  }
  setVoiceState(seat: number, talking: boolean): void {
    this.seats[seat]!.talking = talking;
  }
  setLocalPerspective(localSeat: number, localSlot: number): void {
    this.perspective = { localSeat, localSlot };
  }
  updateSeatLabel(seat: number, name: string, isBot: boolean): void {
    Object.assign(this.seats[seat]!, { visible: true, name, isBot });
  }
  isSeatVisible(seat: number): boolean {
    return this.seats[seat]!.visible;
  }
  hideAllSeats(): void {
    for (const s of this.seats) s.visible = false;
  }
  clearTable(): void {
    this.holeCards.clear();
    this.board = [];
  }
}

/** Check when free, else call; folds only when neither is legal. */
export function passivePolicy(legal: LegalActions): PlayerAction {
  if (legal.canCheck) return PlayerAction.check();
  if (legal.canCall) return PlayerAction.call();
  return PlayerAction.fold();
}

export class InstantPanel implements BettingPanelPort {
  shown = 0;
  constructor(public policy: ((legal: LegalActions) => PlayerAction) | null = passivePolicy) {}
  show(legal: LegalActions, _bet: number, onChosen: (a: PlayerAction) => void): void {
    this.shown++;
    const p = this.policy;
    if (p) queueMicrotask(() => onChosen(p(legal)));
  }
  hide(): void {}
}

export const silentAudio: AudioPort = { play() {}, startTurnTimer() {}, stopTurnTimer() {} } as unknown as AudioPort;

export interface Headless {
  game: ClientGame;
  view: RecordingView;
  panel: InstantPanel;
  conn: NetConnection;
  wallet: { coins: number; adopt(b: number): void };
}

export function headlessClient(
  conn: NetConnection,
  opts: { name: string; token: string; playerId: string; coins: number; speed: number; buyIn?: number; /** The hello ticket (game server: a Nomad session token); default a local ticket. */ ticket?: () => string },
): Headless {
  const panel = new InstantPanel();
  const view = new RecordingView(panel);
  const wallet = {
    coins: opts.coins,
    adopt(b: number) {
      this.coins = b;
    },
  };
  const wait: WaitFn = (s, signal) => realWait(s / opts.speed, signal);
  const game = new ClientGame({
    view,
    audio: silentAudio,
    conn,
    wait,
    wallet,
    now: () => (performance.now() / 1000) * opts.speed,
    identity: {
      playerName: opts.name,
      token: opts.token,
      avatar: 0,
      sessionTicket: opts.ticket ?? (() => `local:${opts.playerId}:${wallet.coins}`),
      selectedBuyInChips: () => opts.buyIn ?? 1000,
    },
    log: (level, m) => {
      if (level === 'error') console.error(`[${opts.name}] ${m}`);
    },
  });
  return { game, view, panel, conn, wallet };
}

/** Polls until `cond` holds (real time), or throws after `ms`. */
export async function until(cond: () => boolean, ms = 10000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
