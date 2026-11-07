import type { Card } from '../cards/card';
import type { ActionType, LegalActions } from '../actions/actions';
import type { HandValue } from '../evaluation/handValue';
import type { BettingRound } from '../state/state';

/**
 * Everything the engine emits, as a discriminated union on `type`. Port of Core/Events/PokerEvent.cs.
 * Presentation reacts to this single ordered stream instead of reading table state directly.
 * Network-only events (LobbyState, TurnStarted, TableRoster, TableEconomy, Reaction, VoiceState) are typed here for
 * completeness but are never emitted by the engine.
 */

/** One seat's public standing at a moment in time. */
export interface SeatSnapshot {
  name: string | null;
  stack: number;
  isOccupied: boolean;
  isBusted: boolean;
  isBot: boolean;
  /** Owned AFK agent — labeled separately from filler bots. */
  isAgent: boolean;
  /** Network-only: claimed by someone dealt in from the next hand. Always false from the engine. */
  isPendingNextHand: boolean;
  /** Network-only: seat on its way out. Always false from the engine. */
  isLeaving: boolean;
  /** Network-only: AvatarCatalog value, 0 = None. The engine never sets it. */
  avatar: number;
}

export interface HandStartedEvent {
  readonly type: 'HandStarted';
  handNumber: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  /** indexed by seat, one entry per seat at the table */
  seats: SeatSnapshot[];
}

export interface BlindPostedEvent {
  readonly type: 'BlindPosted';
  seat: number;
  amount: number;
  isSmallBlind: boolean;
  stackAfter: number;
  potAfter: number;
}

/** Hole cards dealt to one seat (single player: every event carries the real cards). */
export interface HoleCardsDealtEvent {
  readonly type: 'HoleCardsDealt';
  seat: number;
  card0: Card;
  card1: Card;
}

/** The engine is now waiting for this seat to submit an action. */
export interface ActionRequestedEvent {
  readonly type: 'ActionRequested';
  seat: number;
  legal: LegalActions;
}

export interface PlayerActedEvent {
  readonly type: 'PlayerActed';
  seat: number;
  action: ActionType;
  /** resulting total CurrentBet this round (for every action type) */
  amount: number;
  stackAfter: number;
  potAfter: number;
}

export interface BettingRoundChangedEvent {
  readonly type: 'BettingRoundChanged';
  round: BettingRound;
}

export interface CommunityDealtEvent {
  readonly type: 'CommunityDealt';
  round: BettingRound;
  /** just the cards revealed on this street */
  newCards: Card[];
  /** the full community board so far */
  board: Card[];
}

export interface ShowdownEntry {
  seat: number;
  card0: Card;
  card1: Card;
  value: HandValue;
  description: string;
}

export interface ShowdownEvent {
  readonly type: 'Showdown';
  entries: ShowdownEntry[];
  board: Card[];
}

export interface PotAwardedEvent {
  readonly type: 'PotAwarded';
  seat: number;
  seatName: string | null;
  amount: number;
  stackAfter: number;
  /** chips still to be awarded (side pots), 0 once the pot is empty */
  potAfter: number;
  /** "Pot", "Main pot", "Side pot", "Uncontested" */
  reason: string;
}

export interface HandEndedEvent {
  readonly type: 'HandEnded';
  handNumber: number;
}

/** Raised when fewer than two funded players remain — there is no next hand to deal. */
export interface GameOverEvent {
  readonly type: 'GameOver';
  winnerSeat: number;
  winnerName: string | null;
}

// ---- Network-only (never emitted by the engine; kept so a later multiplayer port has the shapes) ----

export enum TablePhase { Lobby = 0, Playing = 1, GameOver = 2 }

export interface LobbyStateEvent {
  readonly type: 'LobbyState';
  phase: TablePhase;
  youAreOwner: boolean;
  youJoinNextHand: boolean;
  autoStart: boolean;
  youCanBuyIn: boolean;
  seatedCount: number;
  minToStart: number;
  seatCount: number;
  readyCount: number;
}

export interface TurnStartedEvent {
  readonly type: 'TurnStarted';
  seat: number;
  forYou: boolean;
  turnSeconds: number;
  legal: LegalActions;
}

export interface TableRosterEvent {
  readonly type: 'TableRoster';
  seats: SeatSnapshot[];
}

export interface TableEconomyEvent {
  readonly type: 'TableEconomy';
  tableId: string;
  buyInChips: number;
  smallBlind: number;
  bigBlind: number;
  halted: boolean;
}

export interface ReactionEvent {
  readonly type: 'Reaction';
  seat: number;
  reactionId: number;
}

export interface VoiceStateEvent {
  readonly type: 'VoiceState';
  seat: number;
  isTalking: boolean;
  isMuted: boolean;
}

/** Events the engine itself emits. */
export type EngineEvent =
  | HandStartedEvent
  | BlindPostedEvent
  | HoleCardsDealtEvent
  | ActionRequestedEvent
  | PlayerActedEvent
  | BettingRoundChangedEvent
  | CommunityDealtEvent
  | ShowdownEvent
  | PotAwardedEvent
  | HandEndedEvent
  | GameOverEvent;

export type NetworkEvent =
  | LobbyStateEvent
  | TurnStartedEvent
  | TableRosterEvent
  | TableEconomyEvent
  | ReactionEvent
  | VoiceStateEvent;

export type PokerEvent = EngineEvent | NetworkEvent;
