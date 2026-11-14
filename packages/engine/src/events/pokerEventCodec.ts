import { Card } from '../cards/card';
import type { Rank } from '../cards/rank';
import type { Suit } from '../cards/suit';
import { legalActions, NO_LEGAL_ACTIONS, type ActionType, type LegalActions } from '../actions/actions';
import { HandEvaluator } from '../evaluation/handEvaluator';
import { HandValue } from '../evaluation/handValue';
import type { BettingRound } from '../state/state';
import type {
  HandStartedEvent, PokerEvent, SeatSnapshot, ShowdownEntry, TablePhase,
} from './pokerEvent';
import { BinaryReader, BinaryWriter } from './binaryIO';
import type {
  TournamentEvent, TournamentPhase, TournamentPlayerState, TournamentTableLine, TournamentViewReason,
} from './tournamentEvents';

/**
 * Binary wire format for poker events — port of Core/Events/PokerEventCodec.cs, byte for byte, so the web server, the
 * web client and (through a future bridge) the Unity C# peers all read the same payloads.
 *
 * Every payload starts [seq:int32][type:byte]; the sequence number lets a client assert it is applying events in
 * emission order. Hole-card privacy is the sender's job: encode with {@link HIDDEN_CARD} in place of a card the
 * recipient must not see.
 */

/** Everything that can go on the wire: the engine/network events plus the tournament payloads. */
export type WireEvent = PokerEvent | TournamentEvent;

const TypeHandStarted = 1;
const TypeBlindPosted = 2;
const TypeHoleCardsDealt = 3;
const TypeTurnStarted = 4;
const TypePlayerActed = 5;
const TypeRoundChanged = 6;
const TypeCommunityDealt = 7;
const TypeShowdown = 8;
const TypePotAwarded = 9;
const TypeHandEnded = 10;
const TypeGameOver = 11;
const TypeTableRoster = 12;
const TypeLobbyState = 13;
/** Retired (was TypeTableSnapshot). Decoded as nothing; the number is never reused. */
const TypeRetiredTableSnapshot = 14;
/** Retired (was TypeChainTable). Decoded as nothing; the number is never reused. */
const TypeRetiredChainTable = 15;
const TypeReaction = 16;
const TypeVoiceState = 17;
const TypeTableEconomy = 18;
const TypeTournamentStatus = 19;
const TypeTournamentView = 20;
const TypeTournamentResult = 21;

/** HandStarted's optional trailing field: a deck commitment follows (committed tables only). */
const HandStartedTagDeckCommitment = 1;

/** Card.HiddenWire: "a card exists but its value is hidden from you". */
export const HIDDEN_WIRE = 255;

/**
 * The C# `default(Card)` (Rank 0) that a hidden card decodes to. It has no valid index, so it re-encodes as
 * {@link HIDDEN_WIRE}; the view draws it face down.
 */
export const HIDDEN_CARD: Card = new Card(0 as Rank, 0 as Suit);

export function isHiddenCard(c: Card | null | undefined): boolean {
  return !c || c.rank < 2 || c.rank > 14;
}

/** Card.ToWire: dense index 0..51, or HiddenWire for anything else (the default card included). */
export function cardToWire(c: Card | null | undefined): number {
  if (!c || isHiddenCard(c)) return HIDDEN_WIRE;
  const index = c.index;
  return index >= 0 && index <= 51 ? index : HIDDEN_WIRE;
}

export const PokerEventCodec = {
  /** A status lists at most this many tables (4 + 2 + 1 is the most a tournament has). */
  MaxTournamentTables: 8,

  /**
   * Sequence for a payload sent to one peer only (late-join catch-up). It is not part of the table-wide stream, so
   * the recipient must not advance its expected sequence from it.
   */
  OutOfBandSequence: -1,

  /** Longest display name on the wire (seat snapshots). */
  MaxNameLength: 24,

  /** Engine-only events (ActionRequested) never go on the wire — the host turns them into TurnStarted first. */
  canEncode(e: { type: string }): boolean {
    switch (e.type) {
      case 'HandStarted': case 'BlindPosted': case 'HoleCardsDealt': case 'TurnStarted': case 'PlayerActed':
      case 'BettingRoundChanged': case 'CommunityDealt': case 'Showdown': case 'PotAwarded': case 'HandEnded':
      case 'GameOver': case 'TableRoster': case 'LobbyState': case 'TableEconomy': case 'Reaction': case 'VoiceState':
      case 'TournamentStatus': case 'TournamentView': case 'TournamentResult':
        return true;
      default:
        return false;
    }
  },

  encode(e: WireEvent, sequence: number): Uint8Array {
    const w = new BinaryWriter(64);
    w.writeInt32(sequence);
    switch (e.type) {
      case 'HandStarted':
        w.writeByte(TypeHandStarted);
        w.writeInt32(e.handNumber);
        w.writeByte(e.buttonSeat);
        w.writeByte(e.smallBlindSeat);
        w.writeByte(e.bigBlindSeat);
        writeSeats(w, e.seats);
        // Optional tail (older peers stop reading after the seats): [tag 1][32-byte deck commitment].
        if (e.deckCommitment) {
          w.writeByte(HandStartedTagDeckCommitment);
          for (const b of hexToBytes32(e.deckCommitment)) w.writeByte(b);
        }
        break;
      case 'BlindPosted':
        w.writeByte(TypeBlindPosted);
        w.writeByte(e.seat);
        w.writeInt64(e.amount);
        w.writeBool(e.isSmallBlind);
        w.writeInt64(e.stackAfter);
        w.writeInt64(e.potAfter);
        break;
      case 'HoleCardsDealt':
        w.writeByte(TypeHoleCardsDealt);
        w.writeByte(e.seat);
        w.writeByte(cardToWire(e.card0));
        w.writeByte(cardToWire(e.card1));
        break;
      case 'TurnStarted':
        w.writeByte(TypeTurnStarted);
        w.writeByte(e.seat);
        w.writeBool(e.forYou);
        w.writeSingle(e.turnSeconds);
        if (e.forYou) writeLegal(w, e.legal);
        break;
      case 'PlayerActed':
        w.writeByte(TypePlayerActed);
        w.writeByte(e.seat);
        w.writeByte(e.action);
        w.writeInt64(e.amount);
        w.writeInt64(e.stackAfter);
        w.writeInt64(e.potAfter);
        break;
      case 'BettingRoundChanged':
        w.writeByte(TypeRoundChanged);
        w.writeByte(e.round);
        break;
      case 'CommunityDealt':
        w.writeByte(TypeCommunityDealt);
        w.writeByte(e.round);
        writeCards(w, e.newCards);
        writeCards(w, e.board);
        break;
      case 'Showdown':
        w.writeByte(TypeShowdown);
        w.writeByte(e.entries.length);
        for (const entry of e.entries) {
          w.writeByte(entry.seat);
          w.writeByte(cardToWire(entry.card0));
          w.writeByte(cardToWire(entry.card1));
          w.writeString(entry.description ?? '');
        }
        writeCards(w, e.board);
        break;
      case 'PotAwarded':
        w.writeByte(TypePotAwarded);
        w.writeByte(e.seat);
        w.writeString(e.seatName ?? '');
        w.writeInt64(e.amount);
        w.writeInt64(e.stackAfter);
        w.writeInt64(e.potAfter);
        w.writeString(e.reason ?? '');
        break;
      case 'HandEnded':
        w.writeByte(TypeHandEnded);
        w.writeInt32(e.handNumber);
        break;
      case 'GameOver':
        w.writeByte(TypeGameOver);
        w.writeInt32(e.winnerSeat);
        w.writeString(e.winnerName ?? '');
        break;
      case 'TableRoster':
        w.writeByte(TypeTableRoster);
        writeSeats(w, e.seats);
        break;
      case 'LobbyState': {
        w.writeByte(TypeLobbyState);
        w.writeByte(e.phase);
        let flags = 0;
        if (e.youAreOwner) flags |= 1;
        if (e.youJoinNextHand) flags |= 2;
        if (e.youCanBuyIn) flags |= 4;
        if (e.autoStart) flags |= 8;
        w.writeByte(flags);
        w.writeByte(e.seatedCount);
        w.writeByte(e.minToStart);
        w.writeByte(e.seatCount);
        w.writeByte(e.readyCount);
        break;
      }
      case 'TableEconomy':
        w.writeByte(TypeTableEconomy);
        w.writeString(e.tableId ?? '');
        w.writeInt64(e.buyInChips);
        w.writeInt64(e.smallBlind);
        w.writeInt64(e.bigBlind);
        w.writeBool(e.halted);
        break;
      case 'Reaction':
        w.writeByte(TypeReaction);
        w.writeByte(e.seat);
        w.writeByte(e.reactionId);
        break;
      case 'VoiceState': {
        w.writeByte(TypeVoiceState);
        w.writeByte(e.seat);
        let flags = 0;
        if (e.isTalking) flags |= 1;
        if (e.isMuted) flags |= 2;
        w.writeByte(flags);
        break;
      }
      case 'TournamentStatus': {
        w.writeByte(TypeTournamentStatus);
        w.writeString(clip(e.name, 40));
        w.writeByte(e.phase);
        w.writeByte(e.myState);
        w.writeSByte(Math.max(-1, Math.min(127, e.myTableId)));
        w.writeByte(e.entrants);
        w.writeByte(e.playersRemaining);
        w.writeInt32(e.startsInSeconds);
        w.writeInt64(e.firstPrize);
        w.writeInt64(e.secondPrize);
        const tables = e.tables ?? [];
        const count = Math.min(tables.length, PokerEventCodec.MaxTournamentTables);
        w.writeByte(count);
        for (let i = 0; i < count; i++) {
          const t = tables[i]!;
          w.writeByte(t.tableId);
          w.writeByte(t.round);
          let f = 0;
          if (t.isFinal) f |= 1;
          if (t.isClosed) f |= 2;
          if (t.isDealing) f |= 4;
          if (t.isSpedUp) f |= 8;
          w.writeByte(f);
          w.writeByte(t.playersLeft);
          w.writeByte(t.level);
          w.writeInt64(t.smallBlind);
          w.writeInt64(t.bigBlind);
          w.writeUInt16(Math.max(0, Math.min(0xffff, t.secondsToNextLevel)));
          w.writeUInt16(Math.max(0, Math.min(0xffff, t.dealInSeconds)));
        }
        break;
      }
      case 'TournamentView':
        w.writeByte(TypeTournamentView);
        w.writeSByte(Math.max(-1, Math.min(127, e.tableId)));
        w.writeByte(e.round);
        w.writeBool(e.isFinal);
        w.writeSByte(Math.max(-1, Math.min(127, e.yourSeat)));
        w.writeUInt16(Math.max(0, Math.min(0xffff, e.countdownSeconds)));
        w.writeByte(e.reason);
        break;
      case 'TournamentResult': {
        w.writeByte(TypeTournamentResult);
        let f = 0;
        if (e.finished) f |= 1;
        if (e.youWon) f |= 2;
        w.writeByte(f);
        w.writeByte(e.yourPlace);
        w.writeByte(e.yourRound);
        w.writeByte(e.entrants);
        w.writeInt32(e.xpEarned);
        w.writeInt64(e.yourPrize);
        w.writeString(clip(e.championName, 40));
        w.writeString(clip(e.runnerUpName, 40));
        w.writeInt64(e.firstPrize);
        w.writeInt64(e.secondPrize);
        break;
      }
      default:
        throw new Error(`No wire encoding for ${(e as { type: string }).type}.`);
    }
    return w.toArray();
  },

  /**
   * Reads one payload. `sequence` is always returned. Returns event null for a retired wire type (a peer running an
   * older build) — callers must still count the sequence. Throws for a genuinely unknown type.
   */
  decode(data: Uint8Array): { sequence: number; event: WireEvent | null } {
    const r = new BinaryReader(data);
    const sequence = r.readInt32();
    const type = r.readByte();
    const event = decodeBody(r, type);
    return { sequence, event };
  },
};

function decodeBody(r: BinaryReader, type: number): WireEvent | null {
  switch (type) {
    case TypeHandStarted: {
      const e: HandStartedEvent = {
        type: 'HandStarted',
        handNumber: r.readInt32(),
        buttonSeat: r.readByte(),
        smallBlindSeat: r.readByte(),
        bigBlindSeat: r.readByte(),
        seats: readSeats(r),
      };
      if (r.remaining >= 33 && r.readByte() === HandStartedTagDeckCommitment) e.deckCommitment = readHex32(r);
      return e;
    }
    case TypeBlindPosted:
      return {
        type: 'BlindPosted',
        seat: r.readByte(),
        amount: r.readInt64(),
        isSmallBlind: r.readBool(),
        stackAfter: r.readInt64(),
        potAfter: r.readInt64(),
      };
    case TypeHoleCardsDealt:
      return { type: 'HoleCardsDealt', seat: r.readByte(), card0: readCard(r), card1: readCard(r) };
    case TypeTurnStarted: {
      const seat = r.readByte();
      const forYou = r.readBool();
      const turnSeconds = r.readSingle();
      const legal = forYou ? readLegal(r) : NO_LEGAL_ACTIONS;
      return { type: 'TurnStarted', seat, forYou, turnSeconds, legal };
    }
    case TypePlayerActed:
      return {
        type: 'PlayerActed',
        seat: r.readByte(),
        action: r.readByte() as ActionType,
        amount: r.readInt64(),
        stackAfter: r.readInt64(),
        potAfter: r.readInt64(),
      };
    case TypeRoundChanged:
      return { type: 'BettingRoundChanged', round: r.readByte() as BettingRound };
    case TypeCommunityDealt:
      return { type: 'CommunityDealt', round: r.readByte() as BettingRound, newCards: readCards(r), board: readCards(r) };
    case TypeShowdown: {
      const count = r.readByte();
      const raw: { seat: number; card0: Card; card1: Card; description: string }[] = [];
      for (let i = 0; i < count; i++) raw.push({ seat: r.readByte(), card0: readCard(r), card1: readCard(r), description: r.readString() });
      const board = readCards(r);
      // The C# decode leaves Value at default; the description is what the view shows. Re-evaluate when the cards
      // are known so client-side readers (progression) get the same value the server saw.
      const entries: ShowdownEntry[] = raw.map((e) => ({ ...e, value: valueOf(e.card0, e.card1, board) }));
      return { type: 'Showdown', entries, board };
    }
    case TypePotAwarded:
      return {
        type: 'PotAwarded',
        seat: r.readByte(),
        seatName: r.readString(),
        amount: r.readInt64(),
        stackAfter: r.readInt64(),
        potAfter: r.readInt64(),
        reason: r.readString(),
      };
    case TypeHandEnded:
      return { type: 'HandEnded', handNumber: r.readInt32() };
    case TypeGameOver:
      return { type: 'GameOver', winnerSeat: r.readInt32(), winnerName: r.readString() };
    case TypeTableRoster:
      return { type: 'TableRoster', seats: readSeats(r) };
    case TypeLobbyState: {
      const phase = r.readByte() as TablePhase;
      const f = r.readByte();
      return {
        type: 'LobbyState',
        phase,
        youAreOwner: (f & 1) !== 0,
        youJoinNextHand: (f & 2) !== 0,
        youCanBuyIn: (f & 4) !== 0,
        autoStart: (f & 8) !== 0,
        seatedCount: r.readByte(),
        minToStart: r.readByte(),
        seatCount: r.readByte(),
        readyCount: r.readByte(),
      };
    }
    case TypeTableEconomy:
      return {
        type: 'TableEconomy',
        tableId: r.readString(),
        buyInChips: r.readInt64(),
        smallBlind: r.readInt64(),
        bigBlind: r.readInt64(),
        halted: r.readBool(),
      };
    case TypeReaction:
      return { type: 'Reaction', seat: r.readByte(), reactionId: r.readByte() };
    case TypeVoiceState: {
      const seat = r.readByte();
      const f = r.readByte();
      return { type: 'VoiceState', seat, isTalking: (f & 1) !== 0, isMuted: (f & 2) !== 0 };
    }
    case TypeTournamentStatus: {
      const head = {
        name: r.readString(),
        phase: r.readByte() as TournamentPhase,
        myState: r.readByte() as TournamentPlayerState,
        myTableId: r.readSByte(),
        entrants: r.readByte(),
        playersRemaining: r.readByte(),
        startsInSeconds: r.readInt32(),
        firstPrize: r.readInt64(),
        secondPrize: r.readInt64(),
      };
      const count = r.readByte();
      const tables: TournamentTableLine[] = [];
      for (let i = 0; i < count; i++) {
        const tableId = r.readByte();
        const round = r.readByte();
        const f = r.readByte();
        tables.push({
          tableId,
          round,
          isFinal: (f & 1) !== 0,
          isClosed: (f & 2) !== 0,
          isDealing: (f & 4) !== 0,
          isSpedUp: (f & 8) !== 0,
          playersLeft: r.readByte(),
          level: r.readByte(),
          smallBlind: r.readInt64(),
          bigBlind: r.readInt64(),
          secondsToNextLevel: r.readUInt16(),
          dealInSeconds: r.readUInt16(),
        });
      }
      return { type: 'TournamentStatus', ...head, tables };
    }
    case TypeTournamentView:
      return {
        type: 'TournamentView',
        tableId: r.readSByte(),
        round: r.readByte(),
        isFinal: r.readBool(),
        yourSeat: r.readSByte(),
        countdownSeconds: r.readUInt16(),
        reason: r.readByte() as TournamentViewReason,
      };
    case TypeTournamentResult: {
      const f = r.readByte();
      return {
        type: 'TournamentResult',
        finished: (f & 1) !== 0,
        youWon: (f & 2) !== 0,
        yourPlace: r.readByte(),
        yourRound: r.readByte(),
        entrants: r.readByte(),
        xpEarned: r.readInt32(),
        yourPrize: r.readInt64(),
        championName: r.readString(),
        runnerUpName: r.readString(),
        firstPrize: r.readInt64(),
        secondPrize: r.readInt64(),
      };
    }
    case TypeRetiredChainTable:
    case TypeRetiredTableSnapshot:
      return null;
    default:
      throw new Error(`Unknown poker event wire type ${type}.`);
  }
}

function valueOf(c0: Card, c1: Card, board: Card[]): HandValue {
  if (isHiddenCard(c0) || isHiddenCard(c1) || board.length < 3 || board.some(isHiddenCard)) return HandValue.Default;
  try {
    return HandEvaluator.evaluateHand([c0, c1], board);
  } catch {
    return HandValue.Default;
  }
}

/** A hidden card decodes as the default card; the view renders it face down. */
function readCard(r: BinaryReader): Card {
  const wire = r.readByte();
  return wire === HIDDEN_WIRE ? HIDDEN_CARD : Card.fromIndex(wire);
}

function writeCards(w: BinaryWriter, cards: readonly Card[] | null | undefined): void {
  w.writeByte(cards?.length ?? 0);
  if (!cards) return;
  for (const c of cards) w.writeByte(cardToWire(c));
}

function readCards(r: BinaryReader): Card[] {
  const count = r.readByte();
  const out: Card[] = [];
  for (let i = 0; i < count; i++) out.push(readCard(r));
  return out;
}

function clip(text: string | null | undefined, max: number = PokerEventCodec.MaxNameLength): string {
  if (!text) return '';
  return text.length <= max ? text : text.substring(0, max);
}

function writeSeats(w: BinaryWriter, seats: readonly (SeatSnapshot | null)[] | null | undefined): void {
  w.writeByte(seats?.length ?? 0);
  if (!seats) return;
  for (const s of seats) {
    // C# would throw on a null snapshot; every producer fills every seat, so treat null as an empty chair.
    w.writeString(clip(s?.name));
    w.writeInt64(s?.stack ?? 0);
    let f = 0;
    if (s?.isOccupied) f |= 1;
    if (s?.isBusted) f |= 2;
    if (s?.isBot) f |= 4;
    if (s?.isPendingNextHand) f |= 8;
    if (s?.isLeaving) f |= 16;
    if (s?.isAgent) f |= 32;
    w.writeByte(f);
    w.writeByte(s?.avatar ?? 0);
  }
}

function readSeats(r: BinaryReader): SeatSnapshot[] {
  const count = r.readByte();
  const seats: SeatSnapshot[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.readString();
    const stack = r.readInt64();
    const f = r.readByte();
    const avatar = r.readByte();
    seats.push({
      name,
      stack,
      isOccupied: (f & 1) !== 0,
      isBusted: (f & 2) !== 0,
      isBot: (f & 4) !== 0,
      isPendingNextHand: (f & 8) !== 0,
      isLeaving: (f & 16) !== 0,
      avatar,
      isAgent: (f & 32) !== 0,
    });
  }
  return seats;
}

function writeLegal(w: BinaryWriter, legal: LegalActions): void {
  let f = 0;
  if (legal.canFold) f |= 1;
  if (legal.canCheck) f |= 2;
  if (legal.canCall) f |= 4;
  if (legal.canBet) f |= 8;
  if (legal.canRaise) f |= 16;
  if (legal.canAllIn) f |= 32;
  w.writeByte(f);
  w.writeInt64(legal.callAmount);
  w.writeInt64(legal.minRaiseTo);
  w.writeInt64(legal.maxRaiseTo);
}

function readLegal(r: BinaryReader): LegalActions {
  const f = r.readByte();
  const callAmount = r.readInt64();
  const minRaiseTo = r.readInt64();
  const maxRaiseTo = r.readInt64();
  return legalActions((f & 1) !== 0, (f & 2) !== 0, (f & 4) !== 0, callAmount, (f & 8) !== 0, (f & 16) !== 0, minRaiseTo, maxRaiseTo, (f & 32) !== 0);
}

/**
 * Port of Core/Events/PokerTokenHash.cs: stable 64-bit FNV-1a of a reconnect token (over UTF-16 code units, like the
 * C# `foreach (char c in token)`), returned as a decimal string because a signed 64-bit value does not fit a JS number.
 * "0" for a missing token; never "0" otherwise.
 */
export function pokerTokenHash(token: string | null | undefined): string {
  if (!token) return '0';
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < token.length; i++) {
    hash ^= BigInt(token.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  const signed = BigInt.asIntN(64, hash);
  return signed === 0n ? '1' : signed.toString();
}

/** A 32-byte value given as 64 hex chars (a deck commitment). */
function hexToBytes32(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new RangeError('A deck commitment is 64 hex characters.');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substring(2 * i, 2 * i + 2), 16);
  return out;
}

function readHex32(r: BinaryReader): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += r.readByte().toString(16).padStart(2, '0');
  return s;
}
