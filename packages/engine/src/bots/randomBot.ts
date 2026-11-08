import { DotNetRandom } from '../cards/random';
import { PlayerAction } from '../actions/actions';
import { toCall, type BotContext, type IPokerBot } from './botContext';

/** Trivial baseline opponent with a check/call bias. Port of Bots/RandomBot.cs. */
export class RandomBot implements IPokerBot {
  private readonly rng: DotNetRandom;

  constructor(seed?: number) {
    this.rng = new DotNetRandom(seed === undefined ? Date.now() & 0x7fffffff : seed);
  }

  decide(ctx: BotContext): PlayerAction {
    const legal = ctx.legal;
    const roll = this.rng.nextDouble();
    if (toCall(ctx) <= 0) {
      if (legal.canBet && roll < 0.30) return PlayerAction.bet(legal.minRaiseTo);
      return PlayerAction.check();
    }
    if (legal.canRaise && roll < 0.15) return PlayerAction.raise(legal.minRaiseTo);
    if (legal.canCall && roll < 0.70) return PlayerAction.call();
    return PlayerAction.fold();
  }
}
