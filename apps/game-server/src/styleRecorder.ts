import { ActionType } from '@nomad/engine/actions/actions';
import { positionOf } from '@nomad/engine/bots/botContext';
import { HandStrength } from '@nomad/engine/bots/handStrength';
import type { Card } from '@nomad/engine/cards/card';
import type { EngineEvent } from '@nomad/engine/events/pokerEvent';
import type { SettledHand } from '@nomad/table-server/pokerServerGame';
import type { Action } from '@nomad/db/style/style';
import type { DecisionRow, StyleHandRow } from '@nomad/db/strategies';

/** What the recorder needs from its table (PokerServerGame's engine): who sits where, and the blinds. */
export interface StyleTable {
  seatCount(): number;
  bigBlind(): number;
  /** The engine's player id at a seat ('p_…' for a Nomad player), or null. */
  playerAt(seat: number): string | null;
  isBotAt(seat: number): boolean;
}

/**
 * StyleRecorder (Unity's dedicated-server recorder, not ported until now): every decision a Nomad player makes at a
 * Coins table, with what they could see (strength, pot, price, position) — the input for My Twin and the coach — and
 * each hand's outcome. The server alone sees every hole card, so only it can write these. Bots and Agents are skipped.
 */
export class StyleRecorder {
  private hand = 0;
  private button = -1;
  private players: (string | null)[] = [];
  private readonly holes = new Map<number, Card[]>();
  private board: Card[] = [];
  private readonly live = new Set<number>();
  private readonly stacks = new Map<number, number>();
  private readonly bets = new Map<number, number>();
  private pot = 0;
  private pending = new Map<number, { toCall: number; minRaiseTo: number; askedAt: number }>();
  private decisions: DecisionRow[] = [];

  constructor(
    private readonly table: StyleTable,
    private readonly tableName: string,
    /** Wall-clock milliseconds, for think times (Workers' clock moves with I/O: an action arriving is I/O). */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Every engine event, in order. */
  observe(e: EngineEvent): void {
    switch (e.type) {
      case 'HandStarted':
        this.hand = e.handNumber;
        this.button = e.buttonSeat;
        this.holes.clear();
        this.board = [];
        this.live.clear();
        this.stacks.clear();
        this.bets.clear();
        this.pending.clear();
        this.pot = 0;
        this.decisions = [];
        this.players = [];
        e.seats.forEach((s, seat) => {
          const human = s.isOccupied && !s.isBusted && !this.table.isBotAt(seat);
          this.players[seat] = human ? this.table.playerAt(seat) : null;
          if (s.isOccupied && !s.isBusted) {
            this.live.add(seat);
            this.stacks.set(seat, s.stack);
          }
        });
        break;
      case 'BlindPosted':
        this.stacks.set(e.seat, e.stackAfter);
        this.bets.set(e.seat, (this.bets.get(e.seat) ?? 0) + e.amount);
        this.pot = e.potAfter;
        break;
      case 'HoleCardsDealt':
        this.holes.set(e.seat, [e.card0, e.card1]);
        break;
      case 'CommunityDealt':
        this.board = [...e.board];
        this.bets.clear();
        break;
      case 'ActionRequested':
        this.pending.set(e.seat, { toCall: e.legal.callAmount, minRaiseTo: e.legal.minRaiseTo, askedAt: this.now() });
        break;
      case 'PlayerActed':
        this.acted(e.seat, e.action, e.amount, e.stackAfter, e.potAfter);
        break;
      default:
        break;
    }
  }

  private acted(seat: number, type: ActionType, amount: number, stackAfter: number, potAfter: number): void {
    const req = this.pending.get(seat);
    this.pending.delete(seat);
    const player = this.players[seat];
    const stackBefore = this.stacks.get(seat) ?? 0;
    const potBefore = this.pot;
    this.stacks.set(seat, stackAfter);
    this.pot = potAfter;
    if (type === ActionType.Fold) this.live.delete(seat);
    const hole = this.holes.get(seat);
    if (!player || !player.startsWith('p_') || !req || !hole) return;
    const opponents = Math.max(0, this.live.size - (type === ActionType.Fold ? 0 : 1));
    let strength = HandStrength.estimate(hole, this.board);
    strength = Math.max(0, Math.min(1, strength - 0.03 * Math.max(0, opponents - 1)));
    const action = actionName(type, req.toCall, amount, stackBefore);
    if (!action) return;
    this.decisions.push({
      playerId: player,
      table: this.tableName,
      handNo: this.hand,
      street: streetOf(this.board.length),
      position: positionOf(this.button, seat, this.table.seatCount()),
      opponents,
      strength,
      pot: potBefore,
      toCall: req.toCall,
      minRaiseTo: req.minRaiseTo,
      bigBlind: this.table.bigBlind(),
      stack: stackBefore,
      action,
      amount: action === 'bet' || action === 'raise' ? amount : 0,
      thinkMs: this.now() - req.askedAt,
    });
  }

  /** This hand's decisions (taken: the next call returns the next hand's). */
  takeDecisions(): DecisionRow[] {
    const d = this.decisions;
    this.decisions = [];
    return d;
  }

  /** The finished hand's outcome for every Nomad player dealt in. */
  handsOf(h: SettledHand): StyleHandRow[] {
    return h.stacks
      .filter((s) => !s.bot && s.id.startsWith('p_'))
      .map((s) => ({
        playerId: s.id,
        table: this.tableName,
        handNo: h.handNumber,
        position: positionOf(this.button, s.seat, this.table.seatCount()),
        bigBlind: this.table.bigBlind(),
        net: s.stack - s.startStack,
        showdown: s.showdownCategory != null,
        won: s.won,
      }));
  }
}

function streetOf(boardCards: number): number {
  return boardCards >= 5 ? 3 : boardCards === 4 ? 2 : boardCards === 3 ? 1 : 0;
}

/** The engine's action as the style records name it (an all-in is a bet, a raise or a call, by what it did). */
function actionName(type: ActionType, toCall: number, totalTo: number, stackBefore: number): Action | null {
  switch (type) {
    case ActionType.Fold:
      return 'fold';
    case ActionType.Check:
      return 'check';
    case ActionType.Call:
      return 'call';
    case ActionType.Bet:
      return 'bet';
    case ActionType.Raise:
      return 'raise';
    case ActionType.AllIn:
      if (toCall <= 0) return 'bet';
      return stackBefore > toCall ? 'raise' : 'call';
    default:
      return null;
  }
  void totalTo;
}
