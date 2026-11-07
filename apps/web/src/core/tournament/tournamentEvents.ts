/**
 * The tournament's out-of-band events (server → one player): port of Core/Events/TournamentEvents.cs. The types live
 * next to the event codec (core/events/tournamentEvents.ts, wire types 19–21) so the codec, the server and every
 * client share one definition; this module re-exports them and adds the C# field-initialiser constructors.
 */
import {
  TournamentPhase, TournamentPlayerState, TournamentViewReason,
  type TournamentEvent, type TournamentResultEvent, type TournamentStatusEvent, type TournamentTableLine, type TournamentViewEvent,
} from '../events/tournamentEvents';

export { TournamentPhase, TournamentPlayerState, TournamentViewReason };
export type { TournamentEvent, TournamentResultEvent, TournamentStatusEvent, TournamentTableLine, TournamentViewEvent };

/** `new TournamentViewEvent { Reason = r }` with the C# field initialisers (TableId = -1, YourSeat = -1). */
export function tournamentView(reason: TournamentViewReason, init: Partial<Omit<TournamentViewEvent, 'type' | 'reason'>> = {}): TournamentViewEvent {
  return { type: 'TournamentView', tableId: -1, round: 0, isFinal: false, yourSeat: -1, countdownSeconds: 0, ...init, reason };
}

/** `new TournamentResultEvent { … }` (strings default to empty, as the codec decodes a null string). */
export function tournamentResult(init: Partial<Omit<TournamentResultEvent, 'type'>>): TournamentResultEvent {
  return {
    type: 'TournamentResult', finished: false, youWon: false, yourPlace: 0, yourRound: 0, entrants: 0, xpEarned: 0,
    yourPrize: 0, championName: '', runnerUpName: '', firstPrize: 0, secondPrize: 0, ...init,
  };
}

/** PokerEventCodec.MaxTournamentTables: the status event carries at most this many table lines. */
export const MAX_TOURNAMENT_TABLES = 8;
