import { ActionType, PlayerAction, type LegalActions } from '@nomad/engine/actions/actions';

/**
 * An Agent's stop loss as a hard limit, not just a check after the hand: the chips it may still put in this hand are
 * `remaining` (its stack at hand start minus the stop-loss floor, minus what it already committed). The bot's choice
 * is kept when it fits; a bet or raise that doesn't fit is cut down to fit (or becomes a call / check when the
 * smallest legal raise is already too big); a call that doesn't fit becomes a check, or a fold. Never an all-in past
 * the floor. The only way past it is a forced blind, which is why an Agent stops before a hand whose big blind it
 * could not cover (see PokerServerGame.evaluateAgentLimitsAfterHand).
 *
 * `currentBet` is what the seat has in front of it this betting round; Bet / Raise amounts are "raise to" totals for
 * the round, as in PokerEngine.
 */
export function capToBudget(action: PlayerAction, legal: LegalActions, currentBet: number, stack: number, remaining: number): PlayerAction {
  const budget = Math.max(0, Math.floor(remaining));
  const fallback = (): PlayerAction => {
    if (legal.canCheck) return PlayerAction.of(ActionType.Check, 0);
    if (legal.canCall && legal.callAmount <= budget) return PlayerAction.of(ActionType.Call, legal.callAmount);
    return PlayerAction.of(ActionType.Fold, 0);
  };
  const raiseWithin = (wantTo: number, type: ActionType): PlayerAction => {
    const capTo = currentBet + budget;
    const to = Math.min(wantTo, capTo, legal.maxRaiseTo);
    if (to >= legal.minRaiseTo && to > currentBet) return PlayerAction.of(type, to);
    return fallback();
  };
  switch (action.type) {
    case ActionType.Fold:
    case ActionType.Check:
      return action;
    case ActionType.Call:
      return legal.callAmount <= budget ? action : fallback();
    case ActionType.Bet:
    case ActionType.Raise:
      return action.amount - currentBet <= budget ? action : raiseWithin(action.amount, action.type);
    case ActionType.AllIn:
      if (stack <= budget) return action;
      return raiseWithin(currentBet + stack, legal.canBet ? ActionType.Bet : ActionType.Raise);
    default:
      return action;
  }
}
