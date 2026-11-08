/**
 * Port of Assets/Scripts/Core/Agents/AgentHandReplay.cs: one Agent hand, step by step, for the Session History replay
 * viewer; the recorder that builds it from the engine's events; and the pure playback / wording over it.
 *
 * The JSON is byte-identical to the C# (Newtonsoft, NullValueHandling.Ignore, declaration order, short keys), so a replay
 * written here reads in Unity and the backend's agent_hands.replay_json, and the other way round
 * (__tests__/agentsParity.test.ts checks it against replays recorded by the real C#).
 *
 * PRIVACY: an opponent's hole cards are recorded only when they were shown at showdown. Folded and mucked hands never
 * reach this object. The Agent's own cards are always in it: the owner's Agent played them.
 */
import { ActionType } from '../actions/actions';
import type { Card } from '../cards/card';
import type { PokerEvent } from '../events/pokerEvent';
import { BettingRound } from '../state/state';
import { formatN0 } from '../util/dotnetMath';

export const REPLAY_CURRENT_VERSION = 1;
/** Kept under the backend's 32 KB cap so a replay is never the reason a hand report is altered. */
export const REPLAY_MAX_JSON_BYTES = 30 * 1024;

export class ReplaySeat {
  seat = 0;
  name: string | null = null;
  /** Stack as the hand started (before the blinds). */
  startStack = 0;
  /** The owner's Agent: the seat whose cards are always shown. */
  isAgent = false;
  isBot = false;
  /** Another owner's Agent at the table (Agents play each other since 20 Oct); older replays leave it false. */
  isOtherAgent = false;
  /** The Agent's cards, or an opponent's shown at showdown. Null: never shown. */
  cards: (string | null)[] | null = null;
  endStack = 0;
  net = 0;
}

export type ReplayStepType = 'street' | 'blind' | 'act' | 'show' | 'award';

export class ReplayStep {
  static readonly Street = 'street';
  static readonly Blind = 'blind';
  static readonly Act = 'act';
  static readonly Show = 'show';
  static readonly Award = 'award';

  /** street | blind | act | show | award. */
  type: string | null = null;
  seat: number | null = null;
  /** small_blind / big_blind, or the action: Fold, Check, Call, Bet, Raise, AllIn. */
  action: string | null = null;
  /** Blind: posted. Action: the seat's total bet on this street after it. Award: amount won. */
  amount: number | null = null;
  /** Pot after the step (award: what is still left to award). */
  pot: number | null = null;
  /** The seat's stack after the step. */
  stack: number | null = null;
  /** street: Preflop / Flop / Turn / River. */
  streetName: string | null = null;
  /** street: the whole board so far. */
  board: (string | null)[] | null = null;
  /** show: the hole cards shown. */
  cards: (string | null)[] | null = null;
  /** show: the hand ("Two Pair, Kings and Sevens"). award: the pot ("Pot", "Side pot", "Uncontested"). */
  description: string | null = null;

  static of(init: Partial<ReplayStep>): ReplayStep {
    return Object.assign(new ReplayStep(), init);
  }
}

export class AgentHandReplay {
  version = REPLAY_CURRENT_VERSION;
  handNumber = 0;
  smallBlind = 0;
  bigBlind = 0;
  buttonSeat = -1;
  agentSeat = -1;
  agentCards: (string | null)[] | null = null;
  seats: ReplaySeat[] = [];
  steps: ReplayStep[] = [];

  /** Newtonsoft with NullValueHandling.Ignore: nulls dropped, keys in declaration order, compact. */
  toJson(): string {
    const o: Record<string, unknown> = {
      v: this.version, hand: this.handNumber, sb: this.smallBlind, bb: this.bigBlind, button: this.buttonSeat,
      agentSeat: this.agentSeat,
    };
    if (this.agentCards != null) o.agentCards = this.agentCards;
    o.seats = this.seats.map((s) => {
      const j: Record<string, unknown> = { seat: s.seat };
      if (s.name != null) j.name = s.name;
      j.stack = s.startStack;
      j.agent = s.isAgent;
      j.bot = s.isBot;
      j.otherAgent = s.isOtherAgent;
      if (s.cards != null) j.cards = s.cards;
      j.end = s.endStack;
      j.net = s.net;
      return j;
    });
    o.steps = this.steps.map((st) => {
      const j: Record<string, unknown> = {};
      if (st.type != null) j.t = st.type;
      if (st.seat != null) j.seat = st.seat;
      if (st.action != null) j.a = st.action;
      if (st.amount != null) j.amt = st.amount;
      if (st.pot != null) j.pot = st.pot;
      if (st.stack != null) j.stack = st.stack;
      if (st.streetName != null) j.street = st.streetName;
      if (st.board != null) j.board = st.board;
      if (st.cards != null) j.cards = st.cards;
      if (st.description != null) j.desc = st.description;
      return j;
    });
    return newtonsoftEscape(JSON.stringify(o));
  }

  /** Null for empty, malformed or unknown-version text (the viewer then falls back to the summary). */
  static fromJson(json: string | null | undefined): AgentHandReplay | null {
    if (json == null || json.trim().length === 0) return null;
    try {
      const raw: unknown = JSON.parse(json);
      if (!isObject(raw)) return null;
      const r = new AgentHandReplay();
      readInto(raw, {
        v: (x) => (r.version = toInt(x)),
        hand: (x) => (r.handNumber = toInt(x)),
        sb: (x) => (r.smallBlind = toInt(x)),
        bb: (x) => (r.bigBlind = toInt(x)),
        button: (x) => (r.buttonSeat = toInt(x)),
        agentSeat: (x) => (r.agentSeat = toInt(x)),
        agentCards: (x) => (r.agentCards = toStrings(x)),
        seats: (x) => (r.seats = toList(x, readSeat).filter((e): e is ReplaySeat => e != null)),
        steps: (x) => (r.steps = toList(x, readStep).filter((e): e is ReplayStep => e != null)),
      });
      if (r.version < 1 || r.version > REPLAY_CURRENT_VERSION) return null;
      return r;
    } catch {
      return null;
    }
  }

  seat(seat: number): ReplaySeat | null {
    for (const s of this.seats) if (s.seat === seat) return s;
    return null;
  }

  nameOf(seat: number): string {
    const s = this.seat(seat);
    return s == null ? `Seat ${seat + 1}` : !s.name ? `Seat ${seat + 1}` : s.name;
  }

  get wentToShowdown(): boolean {
    return this.steps.some((s) => s.type === ReplayStep.Show);
  }
}

// ---- Newtonsoft-compatible reading ---------------------------------------------------------------------------------

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Calls the handler of each known key; nulls are skipped (NullValueHandling.Ignore applies when reading too). */
function readInto(o: Record<string, unknown>, handlers: Record<string, (x: unknown) => void>): void {
  for (const [k, v] of Object.entries(o)) {
    const h = handlers[k];
    if (h && v !== null) h(v);
  }
}

class JsonConvertError extends Error {}

/** JSON integer → int/long (Newtonsoft also takes an integer string; a fraction, a bool or an object throws). */
function toInt(x: unknown): number {
  if (typeof x === 'number' && Number.isInteger(x)) return x;
  if (typeof x === 'string' && /^\s*[-+]?\d+\s*$/.test(x)) return Number.parseInt(x, 10);
  throw new JsonConvertError('not an integer');
}

function toStr(x: unknown): string {
  if (typeof x === 'string') return x;
  if (typeof x === 'number') return String(x);
  if (typeof x === 'boolean') return x ? 'True' : 'False';
  throw new JsonConvertError('not a string');
}

function toBool(x: unknown): boolean {
  if (typeof x === 'boolean') return x;
  if (typeof x === 'number') return x !== 0;
  if (typeof x === 'string' && /^(true|false)$/i.test(x.trim())) return x.trim().toLowerCase() === 'true';
  throw new JsonConvertError('not a bool');
}

function toStrings(x: unknown): (string | null)[] {
  if (!Array.isArray(x)) throw new JsonConvertError('not an array');
  return x.map((e) => (e === null ? null : toStr(e)));
}

function toList<T>(x: unknown, read: (o: Record<string, unknown>) => T): (T | null)[] {
  if (!Array.isArray(x)) throw new JsonConvertError('not an array');
  return x.map((e) => {
    if (e === null) return null;
    if (!isObject(e)) throw new JsonConvertError('not an object');
    return read(e);
  });
}

function readSeat(o: Record<string, unknown>): ReplaySeat {
  const s = new ReplaySeat();
  readInto(o, {
    seat: (x) => (s.seat = toInt(x)),
    name: (x) => (s.name = toStr(x)),
    stack: (x) => (s.startStack = toInt(x)),
    agent: (x) => (s.isAgent = toBool(x)),
    bot: (x) => (s.isBot = toBool(x)),
    otherAgent: (x) => (s.isOtherAgent = toBool(x)),
    cards: (x) => (s.cards = toStrings(x)),
    end: (x) => (s.endStack = toInt(x)),
    net: (x) => (s.net = toInt(x)),
  });
  return s;
}

function readStep(o: Record<string, unknown>): ReplayStep {
  const s = new ReplayStep();
  readInto(o, {
    t: (x) => (s.type = toStr(x)),
    seat: (x) => (s.seat = toInt(x)),
    a: (x) => (s.action = toStr(x)),
    amt: (x) => (s.amount = toInt(x)),
    pot: (x) => (s.pot = toInt(x)),
    stack: (x) => (s.stack = toInt(x)),
    street: (x) => (s.streetName = toStr(x)),
    board: (x) => (s.board = toStrings(x)),
    cards: (x) => (s.cards = toStrings(x)),
    desc: (x) => (s.description = toStr(x)),
  });
  return s;
}

/** Newtonsoft's default escaping also escapes U+0085, U+2028 and U+2029, which JSON.stringify leaves raw. */
const NEWTONSOFT_EXTRA = new RegExp('[' + String.fromCharCode(0x85, 0x2028, 0x2029) + ']', 'g');
function newtonsoftEscape(json: string): string {
  return json.replace(NEWTONSOFT_EXTRA, (c) => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** UTF-8 byte count (Encoding.UTF8.GetByteCount). */
export function utf8ByteCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// ---- Recorder ------------------------------------------------------------------------------------------------------

const shorts = (cards: readonly Card[] | null | undefined): string[] => (cards ? cards.map((c) => c.short) : []);

/**
 * Builds an AgentHandReplay from the engine's events, in order. Pure: the table server feeds it the same events it
 * broadcasts, and tests feed it whole hands from PokerEngine. Port of AgentHandReplayRecorder.
 */
export class AgentHandReplayRecorder {
  private replay: AgentHandReplay | null = null;
  private started = false;
  private readonly stacks = new Map<number, number>();

  /** A hand has started since begin(). */
  get hasHand(): boolean {
    return this.replay != null && this.started;
  }

  begin(agentSeat: number, smallBlind = 0, bigBlind = 0): void {
    const r = new AgentHandReplay();
    r.agentSeat = agentSeat;
    r.smallBlind = smallBlind;
    r.bigBlind = bigBlind;
    this.replay = r;
    this.started = false;
    this.stacks.clear();
  }

  /** The hand's blinds (the engine's table holds them once the hand has started). */
  setBlinds(smallBlind: number, bigBlind: number): void {
    if (!this.replay) return;
    this.replay.smallBlind = smallBlind;
    this.replay.bigBlind = bigBlind;
  }

  clear(): void {
    this.replay = null;
    this.started = false;
    this.stacks.clear();
  }

  observe(e: PokerEvent | null | undefined): void {
    const r = this.replay;
    if (!r || !e) return;
    switch (e.type) {
      case 'HandStarted': {
        r.handNumber = e.handNumber;
        r.buttonSeat = e.buttonSeat;
        r.seats = [];
        r.steps = [];
        r.agentCards = null;
        this.stacks.clear();
        if (e.seats) {
          for (let i = 0; i < e.seats.length; i++) {
            const s = e.seats[i];
            if (!s || !s.isOccupied || s.isBusted || s.stack <= 0) continue;
            const agent = i === r.agentSeat;
            const seat = new ReplaySeat();
            seat.seat = i;
            seat.name = !s.name ? `Seat ${i + 1}` : s.name;
            seat.startStack = s.stack;
            seat.isAgent = agent;
            seat.isBot = s.isBot && !agent && !s.isAgent;
            seat.isOtherAgent = s.isAgent && !agent;
            seat.endStack = s.stack;
            r.seats.push(seat);
            this.stacks.set(i, s.stack);
          }
        }
        r.steps.push(ReplayStep.of({ type: ReplayStep.Street, streetName: BettingRound[BettingRound.Preflop], board: [] }));
        this.started = true;
        break;
      }
      case 'BlindPosted':
        if (!this.started) return;
        this.stacks.set(e.seat, e.stackAfter);
        r.steps.push(ReplayStep.of({
          type: ReplayStep.Blind, seat: e.seat, action: e.isSmallBlind ? 'small_blind' : 'big_blind',
          amount: e.amount, pot: e.potAfter, stack: e.stackAfter,
        }));
        break;
      case 'HoleCardsDealt': {
        // PRIVACY: only the Agent's own cards. Everyone else's stay unknown unless shown at showdown.
        if (!this.started || e.seat !== r.agentSeat) return;
        r.agentCards = [e.card0.short, e.card1.short];
        const agentSeat = r.seat(e.seat);
        if (agentSeat) agentSeat.cards = r.agentCards;
        break;
      }
      case 'BettingRoundChanged':
        // Preflop's street opened at HandStarted (the blinds belong to it). Post-flop this event comes just before
        // CommunityDealt, which fills the board in.
        if (!this.started || e.round === BettingRound.Preflop || e.round === BettingRound.None || e.round === BettingRound.Showdown) return;
        r.steps.push(ReplayStep.of({ type: ReplayStep.Street, streetName: BettingRound[e.round] ?? String(e.round) }));
        break;
      case 'CommunityDealt': {
        if (!this.started) return;
        const board = shorts(e.board);
        const name = BettingRound[e.round] ?? String(e.round);
        let street: ReplayStep | null = null;
        for (let i = r.steps.length - 1; i >= 0; i--) {
          if (r.steps[i]!.type === ReplayStep.Street) {
            street = r.steps[i]!;
            break;
          }
        }
        if (street && street.streetName === name && street.board == null) street.board = board;
        else r.steps.push(ReplayStep.of({ type: ReplayStep.Street, streetName: name, board }));
        break;
      }
      case 'PlayerActed':
        if (!this.started) return;
        this.stacks.set(e.seat, e.stackAfter);
        r.steps.push(ReplayStep.of({
          type: ReplayStep.Act, seat: e.seat, action: ActionType[e.action] ?? String(e.action),
          amount: e.amount, pot: e.potAfter, stack: e.stackAfter,
        }));
        break;
      case 'Showdown':
        if (!this.started || !e.entries) return;
        // Everyone in this event is still in the hand and turned their cards face up at the table.
        for (const entry of e.entries) {
          if (!entry) continue;
          const cards = [entry.card0.short, entry.card1.short];
          r.steps.push(ReplayStep.of({ type: ReplayStep.Show, seat: entry.seat, cards, description: entry.description }));
          const seat = r.seat(entry.seat);
          if (seat) seat.cards = cards;
        }
        break;
      case 'PotAwarded':
        if (!this.started) return;
        this.stacks.set(e.seat, e.stackAfter);
        r.steps.push(ReplayStep.of({
          type: ReplayStep.Award, seat: e.seat, amount: e.amount, pot: e.potAfter, stack: e.stackAfter, description: e.reason,
        }));
        break;
      default:
        break;
    }
  }

  /** The finished replay with every seat's end stack and net, or null when no hand was seen. */
  finish(): AgentHandReplay | null {
    if (!this.hasHand) return null;
    const r = this.replay!;
    for (const s of r.seats) {
      s.endStack = this.stacks.get(s.seat) ?? s.startStack;
      s.net = s.endStack - s.startStack;
    }
    return r;
  }

  /** The finished replay as JSON, or null when there is none or it would exceed `maxBytes`. */
  finishJson(maxBytes = REPLAY_MAX_JSON_BYTES): string | null {
    const r = this.finish();
    if (!r) return null;
    const json = r.toJson();
    return utf8ByteCount(json) <= maxBytes ? json : null;
  }
}

// ---- Playback and wording ------------------------------------------------------------------------------------------

/** The table at one point of a replay: what the viewer draws after the first N steps. */
export class ReplaySeatFrame {
  stack = 0;
  /** Chips in front of the seat on this street. */
  bet = 0;
  folded = false;
  allIn = false;
  /** Face-up cards: the Agent's from the start, an opponent's once shown at showdown. Null: hidden. */
  cards: (string | null)[] | null = null;
  /** Short label of the seat's last move ("Raise 400", "Fold", "Wins 1,250"). */
  label = '';
  handDescription: string | null = null;
  won = 0;
}

export class ReplayFrame {
  pot = 0;
  street = 'Preflop';
  board: (string | null)[] = [];
  /** The seat the last step was about (-1: none). */
  activeSeat = -1;
  /** What the last step was, in words ("Bot Ada raises to 400"). Empty before the first step. */
  caption = '';
  readonly seats = new Map<number, ReplaySeatFrame>();
}

/** One round of a replay for the per-round summary. */
export class ReplayRound {
  /** Preflop, Flop, Turn, River, Showdown or Result. */
  name = '';
  /** The name and the board so far ("Flop  9h 2s 3c"). */
  title = '';
  /** Index of the street step that opened the round (-1: Showdown / Result). */
  streetStep = -1;
  isEnd = false;
  readonly steps: number[] = [];
}

export type CardFormat = (card: string) => string;
const identity: CardFormat = (c) => c;

const containsAgent = (s: string): boolean => s.toLowerCase().includes('agent');

/** Pure playback and wording over an AgentHandReplay (the UI only draws what this returns). Port of AgentHandReplayText. */
export const AgentHandReplayText = {
  coins(v: number): string {
    return formatN0(v);
  },

  signed(v: number): string {
    return (v > 0 ? '+' : v < 0 ? '−' : '') + formatN0(Math.abs(v));
  },

  /** The table after the first `stepCount` steps (0: as dealt, before the blinds). */
  frameAt(r: AgentHandReplay | null, stepCount: number, card?: CardFormat): ReplayFrame {
    const f = new ReplayFrame();
    if (!r) return f;
    for (const s of r.seats) {
      const sf = new ReplaySeatFrame();
      sf.stack = s.startStack;
      sf.cards = s.isAgent ? s.cards ?? r.agentCards : null;
      f.seats.set(s.seat, sf);
    }
    const n = Math.max(0, Math.min(stepCount, r.steps.length));
    for (let i = 0; i < n; i++) {
      const st = r.steps[i]!;
      let seat: ReplaySeatFrame | null = null;
      if (st.seat != null) {
        seat = f.seats.get(st.seat) ?? null;
        if (!seat) f.seats.set(st.seat, (seat = new ReplaySeatFrame()));
      }
      switch (st.type) {
        case ReplayStep.Street:
          f.street = st.streetName ?? f.street;
          if (st.board != null) f.board = st.board;
          if (st.streetName !== 'Preflop')
            for (const s of f.seats.values()) {
              s.bet = 0;
              if (!s.folded && !s.allIn) s.label = '';
            }
          break;
        case ReplayStep.Blind:
          seat!.bet = st.amount ?? 0;
          if (st.stack != null) seat!.stack = st.stack;
          if (st.pot != null) f.pot = st.pot;
          if (seat!.stack === 0) seat!.allIn = true;
          seat!.label = (st.action === 'small_blind' ? 'SB ' : 'BB ') + formatN0(st.amount ?? 0);
          break;
        case ReplayStep.Act:
          if (st.stack != null) seat!.stack = st.stack;
          if (st.pot != null) f.pot = st.pot;
          if (st.action === 'Fold') {
            seat!.folded = true;
            seat!.label = 'Fold';
          } else {
            seat!.bet = st.amount ?? seat!.bet;
            if (seat!.stack === 0 || st.action === 'AllIn') seat!.allIn = true;
            seat!.label = shortAction(st);
          }
          break;
        case ReplayStep.Show:
          f.street = 'Showdown';
          seat!.cards = st.cards;
          seat!.handDescription = st.description;
          seat!.label = st.description ?? 'Shows';
          for (const s of f.seats.values()) s.bet = 0;
          break;
        case ReplayStep.Award:
          for (const s of f.seats.values()) s.bet = 0;
          if (st.stack != null) seat!.stack = st.stack;
          if (st.pot != null) f.pot = st.pot;
          seat!.won += st.amount ?? 0;
          seat!.label = 'Wins ' + formatN0(seat!.won);
          break;
      }
    }
    if (n > 0) {
      f.activeSeat = r.steps[n - 1]!.seat ?? -1;
      f.caption = AgentHandReplayText.describe(r, r.steps[n - 1]!, card);
    }
    return f;
  },

  /** One step in words, e.g. "Bot Ada raises to 400 · pot 650". */
  describe(r: AgentHandReplay, st: ReplayStep, card: CardFormat = identity): string {
    const who = st.seat != null ? nameWithRole(r, st.seat) : '';
    const amt = st.amount ?? 0;
    const pot = st.pot != null ? ' · pot ' + formatN0(st.pot) : '';
    switch (st.type) {
      case ReplayStep.Street:
        return st.streetName === 'Preflop' || st.board == null || st.board.length === 0
          ? (st.streetName ?? '') + (st.streetName === 'Preflop' ? ': cards dealt' : '')
          : `${st.streetName}: ${AgentHandReplayText.cards(st.board, card)}`;
      case ReplayStep.Blind:
        return `${who} posts the ${st.action === 'small_blind' ? 'small' : 'big'} blind ${formatN0(amt)}${pot}`;
      case ReplayStep.Act:
        switch (st.action) {
          case 'Fold': return `${who} folds`;
          case 'Check': return `${who} checks`;
          case 'Call': return `${who} calls ${formatN0(amt)}${pot}`;
          case 'Bet': return `${who} bets ${formatN0(amt)}${pot}`;
          case 'Raise': return `${who} raises to ${formatN0(amt)}${pot}`;
          case 'AllIn': return `${who} goes all-in to ${formatN0(amt)}${pot}`;
          default: return `${who} ${st.action ?? ''}${pot}`;
        }
      case ReplayStep.Show:
        return `${who} shows ${AgentHandReplayText.cards(st.cards, card)}` + (!st.description ? '' : ': ' + st.description);
      case ReplayStep.Award: {
        const reason = !st.description || st.description === 'Pot' ? ''
          : st.description === 'Uncontested' ? ' (uncontested)' : ` (${st.description.toLowerCase()})`;
        return `${who} wins ${formatN0(amt)}${reason}`;
      }
    }
    return '';
  },

  cards(cards: readonly (string | null)[] | null | undefined, card: CardFormat = identity): string {
    if (!cards || cards.length === 0) return '';
    return cards.map((c) => card(c as string)).join(' ');
  },

  /**
   * The steps grouped by round: Preflop, Flop, Turn, River, then Showdown (or Result, for a hand won uncontested). Each
   * round lists the indices of its steps in `steps`; describe them with describe(). The street steps are the titles.
   */
  rounds(r: AgentHandReplay | null, card: CardFormat = identity): ReplayRound[] {
    const rounds: ReplayRound[] = [];
    if (!r) return rounds;
    let current: ReplayRound | null = null;
    for (let i = 0; i < r.steps.length; i++) {
      const st = r.steps[i]!;
      if (st.type === ReplayStep.Street) {
        current = new ReplayRound();
        current.name = st.streetName ?? '';
        current.title = st.board != null && st.board.length > 0 ? `${st.streetName}  ${AgentHandReplayText.cards(st.board, card)}` : st.streetName ?? '';
        current.streetStep = i;
        rounds.push(current);
        continue;
      }
      if ((st.type === ReplayStep.Show || st.type === ReplayStep.Award) && (current == null || !current.isEnd)) {
        const name = r.wentToShowdown ? 'Showdown' : 'Result';
        current = new ReplayRound();
        current.name = name;
        current.title = name;
        current.streetStep = -1;
        current.isEnd = true;
        rounds.push(current);
      }
      if (current == null) {
        current = new ReplayRound();
        current.name = 'Preflop';
        current.title = 'Preflop';
        current.streetStep = -1;
        rounds.push(current);
      }
      current.steps.push(i);
    }
    return rounds;
  },

  /** "Agent had As Kh, raised preflop to 400, won 1,250 at showdown with Two Pair, Kings and Sevens." */
  summary(r: AgentHandReplay | null, card: CardFormat = identity): string {
    if (!r) return '';
    const me = r.seat(r.agentSeat);
    const name = me != null && containsAgent(r.nameOf(r.agentSeat)) ? r.nameOf(r.agentSeat) : 'Your Agent';
    const parts: string[] = [];
    const cards = me?.cards ?? r.agentCards;
    parts.push(cards != null && cards.length > 0 ? `${name} had ${AgentHandReplayText.cards(cards, card)}` : `${name} played`);

    // The Agent's last move on each street (a check is only worth saying if that's all it did).
    let street = 'Preflop';
    let lastOnStreet: ReplayStep | null = null;
    let lastStreet: string | null = null;
    const flush = () => {
      if (!lastOnStreet) return;
      const phrase = phraseOf(lastOnStreet, lastStreet);
      if (phrase != null) parts.push(phrase);
      lastOnStreet = null;
    };
    for (const st of r.steps) {
      if (st.type === ReplayStep.Street) {
        flush();
        street = st.streetName ?? street;
        continue;
      }
      if (st.type !== ReplayStep.Act || st.seat !== r.agentSeat) continue;
      if (lastOnStreet == null || st.action !== 'Check') {
        lastOnStreet = st;
        lastStreet = street;
      }
    }
    flush();

    let won = 0;
    let winningHand: string | null = null;
    const showdown = r.wentToShowdown;
    for (const st of r.steps) {
      if (st.type === ReplayStep.Award && st.seat === r.agentSeat) won += st.amount ?? 0;
      if (st.type === ReplayStep.Show && st.seat === r.agentSeat) winningHand = st.description;
    }
    const net = me?.net ?? 0;
    if (won > 0)
      parts.push(showdown ? `won ${formatN0(won)} at showdown` + (!winningHand ? '' : ` with ${winningHand}`) : `won ${formatN0(won)} uncontested`);
    else if (net < 0) {
      let winner: string | null = null;
      for (const st of r.steps)
        if (st.type === ReplayStep.Award && st.seat != null && st.seat !== r.agentSeat) {
          winner = r.nameOf(st.seat);
          break;
        }
      parts.push(`lost ${formatN0(-net)}` + (winner != null ? ` to ${winner}` : ''));
    } else parts.push('broke even');
    if (won > 0 && net !== won) parts.push(`net ${AgentHandReplayText.signed(net)}`);
    return parts.join(', ') + '.';
  },
};

function shortAction(st: ReplayStep): string {
  const amt = st.amount ?? 0;
  switch (st.action) {
    case 'Check': return 'Check';
    case 'Call': return 'Call ' + formatN0(amt);
    case 'Bet': return 'Bet ' + formatN0(amt);
    case 'Raise': return 'Raise ' + formatN0(amt);
    case 'AllIn': return 'All-in ' + formatN0(amt);
    default: return st.action ?? '';
  }
}

function nameWithRole(r: AgentHandReplay, seat: number): string {
  const s = r.seat(seat);
  if (!s) return `Seat ${seat + 1}`;
  const name = r.nameOf(seat);
  return s.isAgent && !containsAgent(name) ? `${name} (your Agent)` : name;
}

function phraseOf(st: ReplayStep, street: string | null): string | null {
  const on = street === 'Preflop' ? 'preflop' : 'on the ' + (street ?? '').toLowerCase();
  const amt = st.amount ?? 0;
  switch (st.action) {
    case 'Raise': return `raised ${on} to ${formatN0(amt)}`;
    case 'Bet': return `bet ${formatN0(amt)} ${on}`;
    case 'Call': return `called ${on}`;
    case 'AllIn': return `went all-in ${on}`;
    case 'Fold': return `folded ${on}`;
    default: return null; // a check isn't worth a phrase
  }
}
