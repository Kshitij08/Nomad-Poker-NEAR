import { describe, expect, it } from 'vitest';
import { Card } from '../../cards/card';
import { ActionType, legalActions, NO_LEGAL_ACTIONS } from '../../actions/actions';
import { BettingRound } from '../../state/state';
import { TablePhase, type SeatSnapshot } from '../pokerEvent';
import { HIDDEN_CARD, isHiddenCard, PokerEventCodec, pokerTokenHash, type WireEvent } from '../pokerEventCodec';
import { TournamentPhase, TournamentPlayerState, TournamentViewReason } from '../tournamentEvents';
import golden from './golden/codec-golden.json';

const C = (s: string) => Card.parse(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const seat = (o: Partial<SeatSnapshot>): SeatSnapshot => ({
  name: null, stack: 0, isOccupied: false, isBusted: false, isBot: false, isAgent: false, isPendingNextHand: false, isLeaving: false, avatar: 0, ...o,
});

const seats: SeatSnapshot[] = [
  seat({ name: 'You', stack: 5000, isOccupied: true, avatar: 7 }),
  seat({ name: 'LaggingAgain', stack: 2450, isOccupied: true, isBot: true }),
  seat({ name: null, stack: 0 }),
  seat({ name: 'A name that is far longer than twenty-four chars', stack: 123456789012, isOccupied: true, isBusted: true, isPendingNextHand: true, isLeaving: true, isAgent: true, avatar: 19 }),
  seat({ name: 'Ünïcødé ♠', stack: 1, isOccupied: true }),
];
const legal = legalActions(true, false, true, 150, false, true, 300, 4850, true);

/** The same events (and sequence numbers) the C# golden generator encodes. */
const CASES: [keyof typeof golden.payloads, WireEvent, number][] = [
  ['HandStarted', { type: 'HandStarted', handNumber: 42, buttonSeat: 3, smallBlindSeat: 4, bigBlindSeat: 0, seats }, 7],
  ['BlindPosted', { type: 'BlindPosted', seat: 4, amount: 25, isSmallBlind: true, stackAfter: 4975, potAfter: 25 }, 8],
  ['HoleCardsDealt', { type: 'HoleCardsDealt', seat: 1, card0: C('As'), card1: C('Td') }, 9],
  ['HoleCardsHidden', { type: 'HoleCardsDealt', seat: 2, card0: HIDDEN_CARD, card1: HIDDEN_CARD }, 10],
  ['TurnStartedForYou', { type: 'TurnStarted', seat: 0, forYou: true, turnSeconds: 20, legal }, 11],
  ['TurnStartedOther', { type: 'TurnStarted', seat: 5, forYou: false, turnSeconds: 19.25, legal: NO_LEGAL_ACTIONS }, 12],
  ['PlayerActed', { type: 'PlayerActed', seat: 2, action: ActionType.Raise, amount: 300, stackAfter: 4700, potAfter: 375 }, 13],
  ['RoundChanged', { type: 'BettingRoundChanged', round: BettingRound.Turn }, 14],
  ['CommunityDealt', { type: 'CommunityDealt', round: BettingRound.Flop, newCards: [C('2c'), C('Kh'), C('9s')], board: [C('2c'), C('Kh'), C('9s')] }, 15],
  ['Showdown', {
    type: 'Showdown',
    entries: [
      { seat: 1, card0: C('As'), card1: C('Ad'), description: 'Pair of Aces', value: undefined as never },
      { seat: 3, card0: C('7h'), card1: C('7d'), description: 'Three of a Kind, Sevens', value: undefined as never },
    ],
    board: [C('2c'), C('Kh'), C('9s'), C('7c'), C('3d')],
  }, 16],
  ['PotAwarded', { type: 'PotAwarded', seat: 3, seatName: 'Bot 3', amount: 1250, stackAfter: 6250, potAfter: 0, reason: 'Main pot' }, 17],
  ['HandEnded', { type: 'HandEnded', handNumber: 42 }, 18],
  ['GameOver', { type: 'GameOver', winnerSeat: 3, winnerName: 'Bot 3' }, 19],
  ['TableRoster', { type: 'TableRoster', seats }, 20],
  ['LobbyState', { type: 'LobbyState', phase: TablePhase.Playing, youAreOwner: true, youJoinNextHand: false, youCanBuyIn: true, autoStart: true, seatedCount: 5, minToStart: 2, seatCount: 8, readyCount: 4 }, 21],
  ['TableEconomy', { type: 'TableEconomy', tableId: 't-0123456789abcdef0123', buyInChips: 1000, smallBlind: 25, bigBlind: 50, halted: false }, 22],
  ['Reaction', { type: 'Reaction', seat: 6, reactionId: 13 }, 23],
  ['VoiceState', { type: 'VoiceState', seat: 2, isTalking: true, isMuted: true }, 24],
  ['TournamentStatus', {
    type: 'TournamentStatus', name: 'Friday Freeroll', phase: TournamentPhase.Running, myState: TournamentPlayerState.Seated, myTableId: 1,
    entrants: 24, playersRemaining: 11, startsInSeconds: 0, firstPrize: 50000, secondPrize: 20000,
    tables: [
      { tableId: 0, round: 1, isFinal: false, isClosed: false, isDealing: true, isSpedUp: false, playersLeft: 6, level: 3, smallBlind: 50, bigBlind: 100, secondsToNextLevel: 87, dealInSeconds: 0 },
      { tableId: 1, round: 1, isFinal: true, isClosed: true, isDealing: false, isSpedUp: true, playersLeft: 5, level: 2, smallBlind: 25, bigBlind: 50, secondsToNextLevel: 70000, dealInSeconds: 12 },
    ],
  }, -1],
  ['TournamentView', { type: 'TournamentView', tableId: 2, round: 2, isFinal: false, yourSeat: -1, countdownSeconds: 15, reason: TournamentViewReason.Watching }, -1],
  ['TournamentResult', {
    type: 'TournamentResult', finished: true, youWon: false, yourPlace: 2, yourRound: 3, entrants: 24, xpEarned: 350, yourPrize: 20000,
    championName: 'SilentFox901', runnerUpName: 'You', firstPrize: 50000, secondPrize: 20000,
  }, -1],
];

describe('PokerEventCodec (C# wire parity)', () => {
  for (const [name, event, seq] of CASES) {
    it(`encodes ${name} byte-for-byte like the C# codec`, () => {
      expect(hex(PokerEventCodec.encode(event, seq))).toBe(golden.payloads[name]);
    });

    it(`decodes the C# ${name} payload`, () => {
      const bytes = Uint8Array.from(golden.payloads[name].match(/../g)!.map((h) => parseInt(h, 16)));
      const { sequence, event: decoded } = PokerEventCodec.decode(bytes);
      expect(sequence).toBe(seq);
      expect(decoded?.type).toBe(event.type);
      // Re-encoding what we decoded must reproduce the same bytes (names are clipped on the way in).
      expect(hex(PokerEventCodec.encode(decoded!, sequence))).toBe(golden.payloads[name]);
    });
  }

  it('decodes hidden cards to the default card', () => {
    const { event } = PokerEventCodec.decode(PokerEventCodec.encode({ type: 'HoleCardsDealt', seat: 2, card0: HIDDEN_CARD, card1: HIDDEN_CARD }, 1));
    expect(event?.type === 'HoleCardsDealt' && isHiddenCard(event.card0) && isHiddenCard(event.card1)).toBe(true);
  });

  it('re-evaluates showdown values when the cards are known', () => {
    const bytes = Uint8Array.from(golden.payloads.Showdown.match(/../g)!.map((h) => parseInt(h, 16)));
    const { event } = PokerEventCodec.decode(bytes);
    if (event?.type !== 'Showdown') throw new Error('not a showdown');
    expect(event.entries[1]!.value.describe()).toBe('Three of a Kind, Sevens');
  });

  it('returns null for retired wire types and throws on unknown ones', () => {
    expect(PokerEventCodec.decode(Uint8Array.from([5, 0, 0, 0, 14])).event).toBeNull();
    expect(PokerEventCodec.decode(Uint8Array.from([5, 0, 0, 0, 15])).sequence).toBe(5);
    expect(() => PokerEventCodec.decode(Uint8Array.from([5, 0, 0, 0, 99]))).toThrow();
  });

  it('refuses engine-only events', () => {
    expect(PokerEventCodec.canEncode({ type: 'ActionRequested' })).toBe(false);
    expect(PokerEventCodec.canEncode({ type: 'TurnStarted' })).toBe(true);
  });

  it('hashes tokens like PokerTokenHash.Of', () => {
    for (const [token, want] of Object.entries(golden.tokenHash)) expect(pokerTokenHash(token)).toBe(want);
  });
});
