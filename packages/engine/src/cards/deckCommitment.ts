import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { Card } from './card';
import { Deck } from './deck';
import { HmacDrbgRandom } from './random';

/**
 * Deck commitments: commit-reveal for a table whose server sees the cards (NEAR-stake tables). Before each deal the
 * server draws a fresh 32-byte seed, publishes
 *
 *   commitment = SHA-256( "NomadPoker/deck/v1" ‖ 0x00 ‖ seed[32] ‖ u16be(len(tableId)) ‖ utf8(tableId) ‖ u32be(handNumber) )
 *
 * when the hand starts, and shuffles with {@link HmacDrbgRandom}(seed) through the engine's own Fisher-Yates
 * ({@link Deck.shuffle}). After the hand it reveals the seed. Anyone can then recompute the commitment (the seed was
 * fixed before the deal, for this table and this hand) and the deck (the cards dealt were the seed's cards).
 *
 * Seeds, commitments and cards travel as lowercase hex / short card strings ("Ah", "Td") so the reveal is plain JSON.
 */

export const DECK_SEED_BYTES = 32;
export const DECK_COMMITMENT_BYTES = 32;
const DOMAIN = new TextEncoder().encode('NomadPoker/deck/v1');

/** A fresh, unpredictable 32-byte deck seed. */
export function newDeckSeed(): Uint8Array {
  const seed = new Uint8Array(DECK_SEED_BYTES);
  crypto.getRandomValues(seed);
  return seed;
}

/** The commitment to `seed` for hand `handNumber` of table `tableId`, as lowercase hex (64 chars). */
export function deckCommitment(seed: Uint8Array | string, tableId: string, handNumber: number): string {
  const s = typeof seed === 'string' ? hexToBytes(seed) : seed;
  if (s.length !== DECK_SEED_BYTES) throw new RangeError(`A deck seed is ${DECK_SEED_BYTES} bytes, got ${s.length}.`);
  if (!Number.isInteger(handNumber) || handNumber < 0 || handNumber > 0xffffffff) throw new RangeError(`Bad hand number ${handNumber}.`);
  const id = new TextEncoder().encode(tableId);
  if (id.length > 0xffff) throw new RangeError('Table id too long.');
  const msg = new Uint8Array(DOMAIN.length + 1 + DECK_SEED_BYTES + 2 + id.length + 4);
  const view = new DataView(msg.buffer);
  let o = 0;
  msg.set(DOMAIN, o);
  o += DOMAIN.length;
  msg[o++] = 0x00;
  msg.set(s, o);
  o += DECK_SEED_BYTES;
  view.setUint16(o, id.length);
  o += 2;
  msg.set(id, o);
  o += id.length;
  view.setUint32(o, handNumber);
  return bytesToHex(sha256(msg));
}

/** The full 52-card order `seed` shuffles to (what PokerEngine deals from, top first). */
export function deckFromSeed(seed: Uint8Array | string): Card[] {
  const deck = new Deck();
  deck.shuffle(new HmacDrbgRandom(typeof seed === 'string' ? hexToBytes(seed) : seed));
  const cards: Card[] = [];
  while (deck.remaining > 0) cards.push(deck.deal());
  return cards;
}

/** The cards a hand dealt, as the table recorded them. */
export interface DealtHand {
  /**
   * Every seat dealt into the hand. PokerEngine deals two cards to each in seat order, so the full list fixes which
   * deck positions belong to whom. Cards may be omitted (a player checking only their own hand knows only theirs).
   */
  holeCards: { seat: number; cards?: readonly string[] | null }[];
  /** The board as far as it was dealt (0, 3, 4 or 5 cards). A burn precedes each street. */
  board: readonly string[];
}

/** Everything a table reveals after a committed hand (SettledHand.deck, and the R2 hand record). */
export interface DeckReveal {
  tableId: string;
  handNumber: number;
  /** The 32-byte seed, hex. */
  seed: string;
  /** The commitment announced at HandStarted, hex. */
  commitment: string;
  /** What was dealt (all hole cards and the board), to check against the seed. */
  dealt: DealtHand;
}

export interface DeckVerification {
  ok: boolean;
  /** Why it failed; null when ok. */
  reason: string | null;
}

/**
 * Checks a revealed hand: the seed must hash to the commitment for this table and hand, and every recorded hole card
 * and board card must sit where the seed's deck puts it. Card strings use {@link Card.short} ("Ah", "Td", "2c").
 */
export function verifyDeck(reveal: Omit<DeckReveal, 'dealt'> & { dealt: DealtHand }): DeckVerification {
  const fail = (reason: string): DeckVerification => ({ ok: false, reason });
  let seed: Uint8Array;
  try {
    seed = hexToBytes(reveal.seed);
  } catch {
    return fail('seed is not hex');
  }
  if (seed.length !== DECK_SEED_BYTES) return fail(`seed is ${seed.length} bytes, expected ${DECK_SEED_BYTES}`);
  let expected: string;
  try {
    expected = deckCommitment(seed, reveal.tableId, reveal.handNumber);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (expected !== reveal.commitment.toLowerCase()) return fail('seed does not match the commitment');

  const deck = deckFromSeed(seed);
  const seats = [...reveal.dealt.holeCards].sort((a, b) => a.seat - b.seat);
  for (let i = 1; i < seats.length; i++) if (seats[i]!.seat === seats[i - 1]!.seat) return fail(`seat ${seats[i]!.seat} listed twice`);
  for (let i = 0; i < seats.length; i++) {
    const cards = seats[i]!.cards;
    if (!cards) continue;
    if (cards.length !== 2) return fail(`seat ${seats[i]!.seat} has ${cards.length} hole cards`);
    for (let j = 0; j < 2; j++) {
      const want = deck[2 * i + j]!;
      if (!sameCard(cards[j]!, want)) return fail(`seat ${seats[i]!.seat} hole card ${j + 1} is ${cards[j]}, the deck has ${want.short}`);
    }
  }
  const board = reveal.dealt.board;
  if (board.length > 5 || board.length === 1 || board.length === 2) return fail(`a board of ${board.length} cards`);
  // burn, flop×3, burn, turn, burn, river
  const positions = [1, 2, 3, 5, 7];
  const base = 2 * seats.length;
  for (let i = 0; i < board.length; i++) {
    const want = deck[base + positions[i]!]!;
    if (!sameCard(board[i]!, want)) return fail(`board card ${i + 1} is ${board[i]}, the deck has ${want.short}`);
  }
  return { ok: true, reason: null };
}

function sameCard(s: string, c: Card): boolean {
  try {
    return Card.parse(s).equals(c);
  } catch {
    return false;
  }
}
