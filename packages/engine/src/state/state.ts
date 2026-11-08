import type { Card } from '../cards/card';

/** Port of Core/State/BettingRound.cs. */
export enum BettingRound {
  None = 0,
  Preflop = 1,
  Flop = 2,
  Turn = 3,
  River = 4,
  Showdown = 5,
}

/** Port of Core/State/PlayerStatus.cs. */
export enum PlayerStatus {
  Empty = 0, // no player seated
  SittingOut = 1, // seated but not dealt into the current hand
  Active = 2, // in the hand and able to act
  Folded = 3, // out of the current hand
  AllIn = 4, // committed entire stack; in the hand but cannot act further
  Busted = 5, // seated but out of chips
}

/** Mutable per-seat state owned by the engine. Port of Core/State/PlayerState.cs. */
export class PlayerState {
  seatIndex = 0;
  id: string | null = null;
  name: string | null = null;
  isBot = false;
  /** Owned AFK agent seat — bot decisions, but survives human disconnect. */
  isAgent = false;

  /** chips behind (not yet committed) */
  stack = 0;
  /** chips committed in the CURRENT betting round */
  currentBet = 0;
  /** chips committed across the whole hand (drives side pots) */
  totalCommitted = 0;

  status: PlayerStatus = PlayerStatus.Empty;
  /** has taken a voluntary action this betting round */
  hasActed = false;

  readonly holeCards: Card[] = [];

  constructor(init?: Partial<Pick<PlayerState, 'seatIndex' | 'id' | 'name' | 'isBot' | 'isAgent' | 'stack' | 'currentBet' | 'totalCommitted' | 'status' | 'hasActed'>>) {
    if (init) Object.assign(this, init);
  }

  /** Still contesting the pot (can win at showdown). */
  get isInHand(): boolean {
    return this.status === PlayerStatus.Active || this.status === PlayerStatus.AllIn;
  }

  /** Able to voluntarily act (has chips and is not folded/all-in). */
  get canAct(): boolean {
    return this.status === PlayerStatus.Active && this.stack > 0;
  }

  get isOccupied(): boolean {
    return this.status !== PlayerStatus.Empty;
  }
}

/** A single (main or side) pot: an amount plus the seats eligible to win it. Port of Core/State/Pot.cs. */
export class Pot {
  amount = 0;
  readonly eligibleSeats: number[] = [];
}

/** The complete, authoritative state of one table. Port of Core/State/TableState.cs. */
export class TableState {
  readonly seats: PlayerState[];
  readonly community: Card[] = [];

  round: BettingRound = BettingRound.None;
  handNumber = 0;

  buttonSeat = -1;
  smallBlindSeat = -1;
  bigBlindSeat = -1;
  /** last/most-recent reference seat for turn ordering */
  currentSeat = -1;

  smallBlind = 0;
  bigBlind = 0;

  /** total chips across all betting rounds this hand */
  pot = 0;
  /** highest CurrentBet anyone has posted this round */
  currentHighBet = 0;
  /** minimum legal raise increment (size of the last full raise) */
  minRaise = 0;

  constructor(seatCount: number) {
    this.seats = Array.from({ length: seatCount }, (_, i) => new PlayerState({ seatIndex: i, status: PlayerStatus.Empty }));
  }

  get seatCount(): number {
    return this.seats.length;
  }
}
