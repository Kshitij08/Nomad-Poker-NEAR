/** Helpers for tests that play real engine hands with bots. */
import type { IPokerBot } from '../../bots/botContext';
import { positionOf } from '../../bots/botContext';
import type { PokerEngine } from '../../engine/pokerEngine';

/**
 * Plays one hand to the end with every seat's bot (keyed by player id). `withPosition` matches the golden
 * generator (BotContext.Position set); TournamentSimulationTests.PlayHand leaves Position at its default 0.
 */
export function playBotHand(engine: PokerEngine, bots: ReadonlyMap<string, IPokerBot>, withPosition: boolean): void {
  engine.startHand();
  let guard = 0;
  while (engine.handInProgress) {
    const seat = engine.awaitingActionSeat;
    if (seat < 0) throw new Error('A hand in progress must be awaiting a seat.');
    const t = engine.table;
    const p = t.seats[seat]!;
    const action = bots.get(p.id!)!.decide({
      seatIndex: seat,
      holeCards: p.holeCards,
      community: t.community,
      round: t.round,
      pot: t.pot,
      myStack: p.stack,
      myCurrentBet: p.currentBet,
      bigBlind: t.bigBlind,
      opponentsInHand: engine.countInHand() - 1,
      position: withPosition ? positionOf(t.buttonSeat, seat, t.seatCount) : 0,
      legal: engine.currentLegalActions,
    });
    engine.submitAction(seat, action);
    if (++guard >= 100_000) throw new Error('Hand failed to terminate.');
  }
}
