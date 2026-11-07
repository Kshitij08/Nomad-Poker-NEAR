/**
 * Port of Core/Actions/ActionType.cs, LegalActions.cs and PlayerAction.cs.
 */

/**
 * A player's intent. Fold/Check/Call/Bet/Raise/AllIn are the things a client can submit; blinds are posted by the
 * engine itself and surface only on events, never as submitted actions.
 */
export enum ActionType {
  Fold = 0,
  Check = 1,
  Call = 2,
  Bet = 3, // opening wager when no bet exists yet this round
  Raise = 4, // increase over an existing bet
  AllIn = 5, // commit entire remaining stack
  PostSmallBlind = 6,
  PostBigBlind = 7,
}

/**
 * What the seat to act is allowed to do right now, with exact chip amounts. The engine computes this; the UI uses it
 * to enable/disable buttons and bound the raise slider; bots use it to stay legal. The engine re-validates every
 * submission against a freshly computed copy.
 */
export interface LegalActions {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly canCall: boolean;
  /** chips needed to call (the delta, capped at the stack) */
  readonly callAmount: number;
  /** open a bet (no wager yet this round) */
  readonly canBet: boolean;
  /** raise over an existing wager */
  readonly canRaise: boolean;
  /** minimum legal TOTAL for a bet/raise */
  readonly minRaiseTo: number;
  /** maximum TOTAL (i.e. all-in) */
  readonly maxRaiseTo: number;
  readonly canAllIn: boolean;
}

/** The C# `default(LegalActions)`: everything false / zero. */
export const NO_LEGAL_ACTIONS: LegalActions = Object.freeze({
  canFold: false, canCheck: false, canCall: false, callAmount: 0,
  canBet: false, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0, canAllIn: false,
});

/** Positional constructor mirroring the C# LegalActions constructor argument order. */
export function legalActions(
  canFold: boolean, canCheck: boolean, canCall: boolean, callAmount: number,
  canBet: boolean, canRaise: boolean, minRaiseTo: number, maxRaiseTo: number, canAllIn: boolean,
): LegalActions {
  return Object.freeze({ canFold, canCheck, canCall, callAmount, canBet, canRaise, minRaiseTo, maxRaiseTo, canAllIn });
}

/**
 * A command submitted to the engine. For Bet/Raise, `amount` is the TOTAL the player's bet becomes this round
 * (a raise "to" amount). Ignored for Fold/Check/Call/AllIn.
 */
export interface PlayerAction {
  readonly type: ActionType;
  readonly amount: number;
}

export const PlayerAction = {
  of: (type: ActionType, amount = 0): PlayerAction => Object.freeze({ type, amount }),
  fold: (): PlayerAction => PlayerAction.of(ActionType.Fold),
  check: (): PlayerAction => PlayerAction.of(ActionType.Check),
  call: (): PlayerAction => PlayerAction.of(ActionType.Call),
  bet: (totalTo: number): PlayerAction => PlayerAction.of(ActionType.Bet, totalTo),
  raise: (totalTo: number): PlayerAction => PlayerAction.of(ActionType.Raise, totalTo),
  allIn: (): PlayerAction => PlayerAction.of(ActionType.AllIn),
  /** "Raise to 200" / "Fold" — same as the C# ToString. */
  toString: (a: PlayerAction): string => (a.amount > 0 ? `${ActionType[a.type]} to ${a.amount}` : ActionType[a.type]!),
};
