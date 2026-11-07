/**
 * One player's view of a poker-per table in the TEE rollup, as the same PokerEvent stream the Fusion path produces,
 * so TableEventPresenter / TableView render it unchanged. Port of Per/Core/PerTableSession.cs.
 *
 * Each poll() reads the public table, and with the seat's session (reader) key the private ledger, the seat's own
 * hand and the hand's action log. The log is the action stream; the ledger's game gives the board, the turn and the
 * legal actions; the public record at the hand's end gives every card (the whole deck is public once a hand is
 * over). Nothing here can see another seat's live cards: the rollup refuses those reads.
 *
 * The session key also signs the seat's routine transactions (commit a seed, start a hand, act), so play needs no
 * wallet prompt. Money moves (buy-in, cash-out) stay with the wallet / play key.
 */
import { PublicKey } from '@solana/web3.js';
import {
  ActionType, Card, HandEvaluator, NO_LEGAL_ACTIONS, type PokerEvent, type SeatSnapshot, type ShowdownEntry,
} from '../../core';
import { bytesEq, randomBytes, shortKey } from '../lib/bytes';
import { PerTableAddresses } from './addresses';
import { PerIx } from './ix';
import { PerGame } from './legal';
import { PerTxException, type PerRpc, type PerSigner } from './rpc';
import { decode, type Game, type HandLog, type HandRecord, type Ledger, type LogEntry, type Seat, type Table } from './types';
import { board as boardOf, dealOrder, holeCards, SEATS } from './verifier';

/** Placeholder for another seat's face-down card (the C# event carries a default Card). */
const HIDDEN = Card.fromIndex(0);

export class PerTableSession {
  readonly addresses: PerTableAddresses;
  private readonly listeners = new Set<(e: PokerEvent) => void>();
  private readonly wallet: Uint8Array;

  mySeat = -1;
  table: Table | null = null;
  ledger: Ledger | null = null;
  /** The seed this seat committed for the next hand (kept so the player can verify it went in). */
  mySeed: Uint8Array | null = null;
  /** Last finished hand this session saw from start to end, for "Verify this hand". */
  lastRecord: HandRecord | null = null;
  lastLog: HandLog | null = null;
  lastMyCards: number[] | null = null;
  lastMySeed: Uint8Array | null = null;
  lastPrevButton: number | null = null;

  private handNo = 0n; // the hand being shown (0 = none)
  private ended = true;
  private logSeen = 0;
  private street = 0;
  private boardShown = 0;
  private readonly start = new Array<bigint>(SEATS).fill(0n);
  private readonly totals = new Array<bigint>(SEATS).fill(0n);
  private readonly streetStart = new Array<bigint>(SEATS).fill(0n);
  private myCardsShown = false;
  private turnKey = '';
  private rosterKey = '';
  private seedFor = 0n;
  private handSeed: Uint8Array | null = null;
  private myCards: number[] | null = null;
  private prevButton: number | null = null;
  private prevButtonHand = 0n;

  constructor(
    table: PublicKey,
    private readonly publicRpc: PerRpc, // no login: the table and the public record
    private readonly readerRpc: PerRpc, // the session key's login: ledger, own hand, log
    private readonly session: PerSigner,
    wallet: PublicKey,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.wallet = wallet.toBytes();
    this.addresses = new PerTableAddresses(table);
  }

  onEvent(fn: (e: PokerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: PokerEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  private nowSeconds(): bigint {
    return BigInt(Math.floor(this.now() / 1000));
  }

  async poll(): Promise<void> {
    const table = decode.table(await this.publicRpc.getAccount(this.addresses.table));
    if (!table) return;
    this.table = table;
    const ledger = decode.ledger(await this.readerRpc.getAccount(this.addresses.ledger));
    this.ledger = ledger;
    this.mySeat = -1;
    const reader = this.session.publicKey.toBytes();
    if (ledger)
      for (let i = 0; i < ledger.seats.length; i++)
        if (bytesEq(ledger.seats[i]!.reader, reader) && bytesEq(ledger.seats[i]!.player, this.wallet)) this.mySeat = i;
    if (!ledger) return; // not seated: only the lobby's public view

    const log = decode.handLog(await this.readerRpc.getAccount(this.addresses.log));
    const hand = this.mySeat >= 0 ? decode.hand(await this.readerRpc.getAccount(this.addresses.hand(this.mySeat))) : null;
    const game = ledger.game;
    const playing = table.handState === PerGame.HandPlaying;

    // Roster between hands.
    if (!playing && this.ended) {
      const key = rosterKeyOf(ledger);
      if (key !== this.rosterKey) {
        this.rosterKey = key;
        this.emit({ type: 'TableRoster', seats: this.snapshots(ledger, null) });
      }
    }

    // A hand we were showing ended while we weren't polling (a hidden tab) and a newer one has begun or finished:
    // close it without replaying it, so the view and the roster move on.
    if (!this.ended && this.handNo > 0n && (table.lastRecord.handNo > this.handNo || (playing && table.handNo > this.handNo))) {
      this.ended = true;
      this.rosterKey = '';
      this.emit({ type: 'HandEnded', handNumber: Number(this.handNo) });
    }

    // A new hand began.
    if (playing && log && log.handNo === table.handNo && log.handNo !== this.handNo) this.startHand(table, ledger, log.handNo);

    if (this.handNo === 0n) return;

    // Hole cards: ours once the hand account holds this hand.
    if (!this.myCardsShown && this.mySeat >= 0 && hand && hand.handNo === this.handNo && hand.cards[0] !== PerGame.NoCard) {
      this.myCardsShown = true;
      this.myCards = [hand.cards[0]!, hand.cards[1]!];
      this.emit({ type: 'HoleCardsDealt', seat: this.mySeat, card0: PerGame.toCard(hand.cards[0]!), card1: PerGame.toCard(hand.cards[1]!) });
    }

    // New log entries for this hand.
    if (log && log.handNo === this.handNo) {
      const n = Math.min(log.len, log.entries.length);
      for (; this.logSeen < n; this.logSeen++) this.apply(log.entries[this.logSeen]!, game);
    }

    if (!this.ended && playing) {
      if (game.street > this.street && game.street <= 4) this.advanceStreet(game.street, game);
      if (game.toAct !== PerGame.NoSeat) {
        const key = `${this.handNo}/${this.logSeen}/${game.toAct}`;
        if (key !== this.turnKey) {
          this.turnKey = key;
          const mine = game.toAct === this.mySeat;
          const left = table.turnDeadline - this.nowSeconds();
          this.emit({ type: 'TurnStarted', seat: game.toAct, forYou: mine, turnSeconds: Number(left > 0n ? left : 0n), legal: mine ? PerGame.legal(game) : NO_LEGAL_ACTIONS });
        }
      }
    }

    // The hand is over once the table's public record holds it.
    if (!this.ended && table.lastRecord.handNo === this.handNo && !playing) this.endHand(table.lastRecord, ledger, log);
  }

  private startHand(table: Table, ledger: Ledger, handNo: bigint): void {
    this.handNo = handNo;
    this.ended = false;
    this.logSeen = 0;
    this.street = 1;
    this.boardShown = 0;
    this.myCardsShown = false;
    this.turnKey = '';
    this.handSeed = this.seedFor === handNo ? this.mySeed : null;
    this.myCards = null;
    for (let i = 0; i < SEATS; i++) {
      this.start[i] = ledger.seats[i]!.stack;
      this.totals[i] = 0n;
      this.streetStart[i] = 0n;
    }
    const g = ledger.game;
    this.emit({ type: 'HandStarted', handNumber: Number(handNo), buttonSeat: g.button, smallBlindSeat: g.sbSeat, bigBlindSeat: g.bbSeat, seats: this.snapshots(ledger, this.start) });
    // Everyone dealt in gets two cards; values only for our own seat (they arrive with the hand account).
    for (let s = 0; s < SEATS; s++)
      if (table.dealtMask & (1 << s) && s !== this.mySeat) this.emit({ type: 'HoleCardsDealt', seat: s, card0: HIDDEN, card1: HIDDEN });
  }

  private apply(e: LogEntry, game: Game): void {
    if (e.street > this.street && e.street <= 4) this.advanceStreet(e.street, game);
    const seat = e.seat;
    const kind = e.kind & 0x7f;
    this.totals[seat] = e.committed;
    const start = this.start[seat]!;
    const stackAfter = Number(start - (e.committed < start ? e.committed : start));
    const pot = Number(this.totals.reduce((a, t) => a + t, 0n));
    if (kind === PerGame.LogSmallBlind || kind === PerGame.LogBigBlind)
      this.emit({ type: 'BlindPosted', seat, amount: Number(e.committed), isSmallBlind: kind === PerGame.LogSmallBlind, stackAfter, potAfter: pot });
    else
      this.emit({ type: 'PlayerActed', seat, action: kind as ActionType, amount: Number(e.committed - this.streetStart[seat]!), stackAfter, potAfter: pot });
  }

  private advanceStreet(street: number, game: Game): void {
    while (this.street < street) {
      this.street++;
      for (let i = 0; i < SEATS; i++) this.streetStart[i] = this.totals[i]!;
      const round = PerGame.toRound(this.street);
      this.emit({ type: 'BettingRoundChanged', round });
      const upTo = this.street === 2 ? 3 : this.street === 3 ? 4 : 5;
      if (game.boardLen >= upTo && upTo > this.boardShown) {
        const board = Array.from({ length: upTo }, (_, i) => PerGame.toCard(game.board[i]!));
        const fresh = board.slice(this.boardShown);
        this.boardShown = upTo;
        this.emit({ type: 'CommunityDealt', round, newCards: fresh, board });
      }
    }
  }

  private endHand(record: HandRecord, ledger: Ledger, log: HandLog | null): void {
    this.ended = true;
    const deck = Array.from(record.cards);
    const order = dealOrder(record.button, record.dealtMask);
    const holes = holeCards(deck, order);
    const fullBoard = boardOf(deck, order.length);
    const board = Array.from({ length: record.boardLen }, (_, i) => PerGame.toCard(fullBoard[i]!));
    if (record.boardLen > this.boardShown && this.street < 4)
      this.advanceStreet(record.boardLen === 3 ? 2 : record.boardLen === 4 ? 3 : 4, ledger.game);

    // A showdown when more than one seat was still in at the end.
    const inHand: number[] = [];
    for (let s = 0; s < SEATS; s++) if (record.dealtMask & (1 << s) && PerGame.inHand(ledger.game.seats[s]!)) inHand.push(s);
    const showdown = inHand.length > 1;
    if (showdown) {
      const entries: ShowdownEntry[] = inHand.map((s) => {
        const c0 = PerGame.toCard(holes[s]![0]);
        const c1 = PerGame.toCard(holes[s]![1]);
        const value = HandEvaluator.evaluateHand([c0, c1], board);
        return { seat: s, card0: c0, card1: c1, value, description: value.describe() };
      });
      this.emit({ type: 'Showdown', entries, board });
    }
    // Winnings: settled stack minus what was left behind after committing.
    for (let s = 0; s < SEATS; s++) {
      if ((record.dealtMask & (1 << s)) === 0) continue;
      const start = this.start[s]!;
      const total = this.totals[s]!;
      const behind = start - (total < start ? total : start);
      const after = ledger.seats[s]!.stack;
      if (after > behind)
        this.emit({ type: 'PotAwarded', seat: s, seatName: seatName(ledger.seats[s]!), amount: Number(after - behind), stackAfter: Number(after), potAfter: 0, reason: showdown ? 'Main pot' : 'Uncontested' });
    }
    this.emit({ type: 'HandEnded', handNumber: Number(this.handNo) });

    this.lastRecord = record;
    this.lastLog = log && log.handNo === record.handNo ? log : null;
    // What the player was shown, so "your cards came from this deck" can actually fail (M8 review).
    this.lastMyCards = this.myCards;
    this.lastMySeed = this.handSeed;
    // Only the hand right before says where this hand's button must be: a client that missed a hand leaves the
    // button unchecked rather than report a false problem. The backend checks every archived hand's button.
    this.lastPrevButton = this.prevButtonHand + 1n === record.handNo ? this.prevButton : null;
    this.prevButton = record.button;
    this.prevButtonHand = record.handNo;
    this.rosterKey = '';
  }

  // ---- the seat's routine transactions, signed by the session key

  /** Between hands: commit this seat's seed for the next hand (once), then try to start it. "Not yet" answers
   * (others' seeds missing, one player) are expected and swallowed. */
  async prepareNextHand(): Promise<string | null> {
    const t = this.table;
    if (!t || this.mySeat < 0 || t.handState !== PerGame.HandIdle || t.status !== PerGame.StatusOpen) return null;
    if (!this.startRequested) return null; // M10: the host starts the table once (Start round)
    const next = t.handNo + 1n;
    if (this.seedFor !== next) {
      const seed = randomBytes(32);
      try {
        await this.readerRpc.send([PerIx.commitSeed(this.addresses, this.session.publicKey, this.mySeat, seed)], this.session);
      } catch (e) {
        if (e instanceof PerTxException && e.errorName === 'HandInProgress') return null; // another seat just started it
        throw e;
      }
      this.mySeed = seed;
      this.seedFor = next;
    }
    try {
      return await this.readerRpc.send([PerIx.startHand(this.addresses, this.session.publicKey)], this.session);
    } catch (e) {
      if (e instanceof PerTxException && ['MissingSeeds', 'NotEnoughPlayers', 'HandInProgress', 'VrfPending', 'TourneyNeedsSync'].includes(e.errorName ?? '')) return null;
      throw e;
    }
  }

  private tickedAt = 0n;
  private dealtSeenAt = 0n;
  private dealtHand = 0n;
  /** How long the keeper gets before a client steps in (the keeper archives the finished hand's log first). */
  static readonly KEEPER_GRACE_SECONDS = 10n;

  /** M10: keeps the table moving without the backend's keeper: a dealt hand that hasn't begun, or a player who ran
   * out of time, KEEPER_GRACE_SECONDS after the keeper would have acted, gets a `tick` (no signer; the program checks
   * the timing). At most once every 3 s. */
  async keepMoving(): Promise<string | null> {
    const t = this.table;
    if (!t || this.mySeat < 0 || t.status !== PerGame.StatusOpen) return null;
    const now = this.nowSeconds();
    if (t.handState === PerGame.HandDealt && this.dealtHand !== t.handNo) {
      this.dealtHand = t.handNo;
      this.dealtSeenAt = now;
    }
    const dealt = t.handState === PerGame.HandDealt && now - this.dealtSeenAt >= PerTableSession.KEEPER_GRACE_SECONDS;
    const late = t.handState === PerGame.HandPlaying && now > t.turnDeadline + PerTableSession.KEEPER_GRACE_SECONDS;
    if (!(dealt || late) || now - this.tickedAt < 3n) return null;
    this.tickedAt = now;
    try {
      return await this.readerRpc.send([PerIx.computeLimit(PerIx.PLAY_CU), PerIx.tick(this.addresses)], this.session);
    } catch (e) {
      if (e instanceof PerTxException) return null; // the keeper or another seat got there first, or not time yet
      throw e;
    }
  }

  /** M10: sit out between hands (takes back a committed seed). Null if a hand is running. */
  async sitOut(): Promise<string | null> {
    if (!this.table || this.mySeat < 0 || this.table.handState !== PerGame.HandIdle) return null;
    const sig = await this.readerRpc.send([PerIx.sitOut(this.addresses, this.session.publicKey, this.mySeat)], this.session);
    this.seedFor = 0n;
    this.mySeed = null;
    return sig;
  }

  /** M10: sit back in (any time, a hand may be running). */
  sitIn(): Promise<string | null> {
    if (this.mySeat < 0) return Promise.resolve(null);
    return this.readerRpc.send([PerIx.sitIn(this.addresses, this.session.publicKey, this.mySeat)], this.session);
  }

  /** M10: the host pressed Start round (once per table; hands keep starting after it). */
  get startRequested(): boolean {
    return !!this.table && this.table.startRequestedFor !== 0n;
  }

  /** M10: the next hand is the first since Start round (it starts at once; later ones get a pause). */
  get firstRoundNext(): boolean {
    return !!this.table && this.table.startRequestedFor === this.table.handNo + 1n;
  }

  /** M10: seats taken with chips on them (a round needs two). */
  get seatedWithChips(): number {
    if (!this.table || !this.ledger) return 0;
    let n = 0;
    for (let s = 0; s < this.ledger.seats.length && s < 16; s++)
      if (this.table.seatMask & (1 << s) && this.ledger.seats[s]!.stack > 0n) n++;
    return n;
  }

  /** M10: whether this seat may press Start round: it's the host's seat, or the host holds no seat. */
  get mayStartRound(): boolean {
    if (!this.table || !this.ledger || this.mySeat < 0) return false;
    let hostSeated = false;
    for (let s = 0; s < this.ledger.seats.length && s < 16; s++)
      if (this.table.seatMask & (1 << s) && bytesEq(this.ledger.seats[s]!.player, this.table.creator)) hostSeated = true;
    return !hostSeated || bytesEq(this.wallet, this.table.creator);
  }

  /** M10: Start round (the host's seat key signs), then commit this seat's seed and try to start. */
  async requestStart(): Promise<string | null> {
    if (!this.table || this.mySeat < 0 || this.table.handState !== PerGame.HandIdle) return null;
    await this.readerRpc.send([PerIx.requestStart(this.addresses, this.session.publicKey)], this.session);
    await this.poll();
    return this.prepareNextHand();
  }

  /** After a failed action: show the turn again on the next poll while it's still ours. */
  repromptTurn(): void {
    this.turnKey = '';
  }

  /** This seat's action. For Bet/Raise `amount` is the total the seat's bet becomes. */
  act(action: ActionType, amount: number): Promise<string> {
    const amt = action === ActionType.Bet || action === ActionType.Raise ? BigInt(Math.trunc(amount)) : 0n;
    return this.readerRpc.send([PerIx.act(this.addresses, this.session.publicKey, this.mySeat, action, amt)], this.session);
  }

  // ---- helpers

  private snapshots(ledger: Ledger, stacks: bigint[] | null): SeatSnapshot[] {
    const n = this.table?.maxSeats ?? SEATS;
    return Array.from({ length: n }, (_, i) => {
      const s = ledger.seats[i]!;
      const empty = isEmpty(s);
      return {
        name: empty ? '' : seatName(s), stack: Number(stacks?.[i] ?? s.stack), isOccupied: !empty,
        isBusted: false, isBot: false, isAgent: false, isPendingNextHand: false, isLeaving: false, avatar: 0,
      };
    });
  }
}

function rosterKeyOf(l: Ledger): string {
  let k = '';
  for (const s of l.seats) k += isEmpty(s) ? '-' : new PublicKey(s.player).toBase58().slice(0, 6) + s.stack + ',';
  return k;
}

const isEmpty = (s: Seat): boolean => s.player.every((b) => b === 0);

/** "AbCd…WxYz" of the seat's wallet (PerTableSession.Name). */
export const seatName = (s: Seat): string => shortKey(new PublicKey(s.player).toBase58());
