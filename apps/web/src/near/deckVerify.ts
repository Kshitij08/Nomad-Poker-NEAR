/**
 * Checking a NEAR money table's deals (commit-reveal, @nomad/engine cards/deckCommitment). The game server announces
 * a commitment to each hand's deck seed on HandStarted; after the hand it reveals the seed and what was dealt at
 *
 *   GET {gameServer}/v1/near-tables/{session}/hands/{handNumber}/deck   → DeckReveal JSON (404 until settled)
 *
 * The client keeps the commitment it was shown before the deal, its own hole cards and the board it saw, and checks
 * the reveal against all three: the seed hashes to the commitment announced before the deal (so it was fixed before
 * any card), the seed's deck deals exactly the recorded cards (verifyDeck), and those include what this client saw.
 */
import { verifyDeck, type DeckReveal } from '@nomad/engine/cards/deckCommitment';
import type { WireEvent } from '@nomad/engine/events/pokerEventCodec';

export type HandCheckStatus =
  /** Being dealt. */
  | 'playing'
  /** Over; the reveal isn't published yet. */
  | 'waiting'
  | 'checking'
  | 'verified'
  | 'mismatch'
  /** The hand had no commitment (not a committed table, or joined mid-hand without one). */
  | 'none'
  /** The reveal couldn't be fetched (network); try again. */
  | 'error';

export interface HandCheck {
  handNumber: number;
  /** As announced on HandStarted, lowercase hex; null if none was. */
  commitment: string | null;
  /** This client's seat in the hand (-1 watching) and its hole cards ("Ah", "Td"), when dealt. */
  mySeat: number;
  myCards: string[] | null;
  /** The board as this client saw it. */
  board: string[];
  status: HandCheckStatus;
  /** From the reveal. */
  seed?: string;
  reason?: string;
}

/** The reveal for one hand, or null while it isn't published (404). Throws on other failures. */
export async function fetchDeckReveal(base: string, session: string, handNumber: number, fetchImpl: typeof fetch = fetch): Promise<DeckReveal | null> {
  const url = `${base.replace(/\/+$/, '')}/v1/near-tables/${encodeURIComponent(session)}/hands/${handNumber}/deck`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The game server answered ${res.status}.`);
  return (await res.json()) as DeckReveal;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Checks a reveal against what this client recorded for the hand. */
export function checkReveal(hand: HandCheck, reveal: DeckReveal, session: string): { ok: boolean; reason: string | null } {
  const fail = (reason: string) => ({ ok: false, reason });
  if (!hand.commitment) return fail('no commitment was announced before the deal');
  if (reveal.tableId !== session) return fail(`the reveal is for table ${reveal.tableId}`);
  if (reveal.handNumber !== hand.handNumber) return fail(`the reveal is for hand ${reveal.handNumber}`);
  if (!same(reveal.commitment ?? '', hand.commitment)) return fail('the revealed commitment is not the one announced before the deal');
  let v;
  try {
    v = verifyDeck(reveal);
  } catch (e) {
    return fail(`the reveal is malformed (${(e as Error).message})`);
  }
  if (!v.ok) return fail(v.reason ?? 'the deck does not match');
  if (hand.myCards && hand.mySeat >= 0) {
    const mine = reveal.dealt.holeCards.find((h) => h.seat === hand.mySeat)?.cards;
    if (!mine || mine.length !== 2 || !mine.every((c, i) => same(c, hand.myCards![i]!))) return fail('your hole cards are not the ones the reveal deals you');
  }
  const board = reveal.dealt.board;
  if (hand.board.length > board.length || !hand.board.every((c, i) => same(c, board[i]!))) return fail('the board you saw is not the revealed board');
  return { ok: true, reason: null };
}

export interface DeckLogOptions {
  /** The game server's http(s) base. */
  base: string;
  session: string;
  fetchImpl?: typeof fetch;
  /** Waits between fetches of a reveal that isn't published yet (ms). */
  retryDelays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onChange?: () => void;
  /** Hands kept, newest first. */
  keep?: number;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One money table visit's hands and their checks. Feed it every presented event. */
export class DeckLog {
  /** Newest first. */
  readonly hands: HandCheck[] = [];
  private readonly opts: Required<Omit<DeckLogOptions, 'onChange'>> & Pick<DeckLogOptions, 'onChange'>;
  private stopped = false;

  constructor(opts: DeckLogOptions) {
    this.opts = { fetchImpl: (...a) => fetch(...a), retryDelays: [1000, 2000, 4000, 8000, 15000], sleep: sleepMs, keep: 30, ...opts };
  }

  get session(): string {
    return this.opts.session;
  }

  private current(): HandCheck | undefined {
    const h = this.hands[0];
    return h?.status === 'playing' ? h : undefined;
  }

  onEvent(e: WireEvent, localSeat: number): void {
    if (this.stopped) return;
    if (e.type === 'HandStarted') {
      if (this.hands.some((h) => h.handNumber === e.handNumber)) return;
      this.hands.unshift({ handNumber: e.handNumber, commitment: e.deckCommitment?.toLowerCase() ?? null, mySeat: localSeat, myCards: null, board: [], status: 'playing' });
      this.hands.length = Math.min(this.hands.length, this.opts.keep);
      this.opts.onChange?.();
    } else if (e.type === 'HoleCardsDealt') {
      const h = this.current();
      if (h && e.seat === localSeat && localSeat >= 0) {
        h.mySeat = localSeat;
        h.myCards = [e.card0.short, e.card1.short];
      }
    } else if (e.type === 'CommunityDealt') {
      const h = this.current();
      if (h) h.board = e.board.map((c) => c.short);
    } else if (e.type === 'HandEnded') {
      const h = this.current();
      if (!h) return;
      h.status = h.commitment ? 'waiting' : 'none';
      this.opts.onChange?.();
      if (h.commitment) void this.check(h.handNumber);
    }
  }

  /** Fetches and checks a finished hand's reveal, retrying while it isn't published (`retry` false: one try). */
  async check(handNumber: number, retry = true): Promise<HandCheck | undefined> {
    const h = this.hands.find((x) => x.handNumber === handNumber);
    if (!h || !h.commitment || h.status === 'playing' || h.status === 'checking') return h;
    const delays = retry ? this.opts.retryDelays : [0];
    h.status = 'checking';
    this.opts.onChange?.();
    for (const d of delays) {
      if (d) await this.opts.sleep(d);
      if (this.stopped) return h;
      let reveal: DeckReveal | null;
      try {
        reveal = await fetchDeckReveal(this.opts.base, this.opts.session, handNumber, this.opts.fetchImpl);
      } catch (e) {
        h.status = 'error';
        h.reason = (e as Error).message;
        this.opts.onChange?.();
        return h;
      }
      if (!reveal) continue;
      const r = checkReveal(h, reveal, this.opts.session);
      h.seed = reveal.seed;
      h.status = r.ok ? 'verified' : 'mismatch';
      h.reason = r.reason ?? undefined;
      this.opts.onChange?.();
      return h;
    }
    h.status = 'waiting';
    this.opts.onChange?.();
    return h;
  }

  stop(): void {
    this.stopped = true;
  }
}

/** The game server's http(s) base from its connect address (ws:// local server → http://). */
export const httpBase = (serverUrl: string): string => serverUrl.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
