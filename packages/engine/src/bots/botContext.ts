import type { Card } from '../cards/card';
import type { LegalActions } from '../actions/actions';
import type { BettingRound } from '../state/state';
import type { PlayerAction } from '../actions/actions';

/**
 * The read-only view a bot is given to make a decision. Exposes ONLY the bot's own hole cards.
 * Port of Bots/BotContext.cs.
 */
export interface BotContext {
  seatIndex: number;
  holeCards: readonly Card[];
  community: readonly Card[];
  round: BettingRound;
  pot: number;
  myStack: number;
  myCurrentBet: number;
  bigBlind: number;
  /** live opponents still contesting the pot */
  opponentsInHand: number;
  /** seats before the button (0 = button); -1 = unknown */
  position: number;
  legal: LegalActions;
}

/** `ctx.ToCall` in C#: the call amount from the legal actions. */
export const toCall = (ctx: BotContext): number => ctx.legal.callAmount;

/** Seats before the button, counting every seat at the table. */
export function positionOf(buttonSeat: number, seat: number, seatCount: number): number {
  return buttonSeat < 0 || seatCount <= 0 ? -1 : (((buttonSeat - seat) % seatCount) + seatCount) % seatCount;
}

/** A bot decision policy: pure and synchronous. Port of Bots/IPokerBot.cs. */
export interface IPokerBot {
  decide(context: BotContext): PlayerAction;
}
