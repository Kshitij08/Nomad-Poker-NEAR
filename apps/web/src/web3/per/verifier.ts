/**
 * "Verify this hand" in the client: recomputes a finished hand's deck from its public record and checks a downloaded
 * action log against the record's hash. Port of Per/Core/PerVerifier.cs (itself a port of per/tests/verifier.ts,
 * which mirrors the program's dealing.rs). Checked against the program's fixed vector in __tests__/verifier.test.ts.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesEq, concat, u16le, u32le, u64le, utf8 } from '../lib/bytes';
import { PerGame } from './legal';
import type { HandLog, HandRecord, LogEntry } from './types';

export const SEATS = 9;
const SHUFFLE_DOMAIN = utf8('poker-per/shuffle/v1');
const BUTTON_DOMAIN = utf8('poker-per/button/v1');
const U64_MAX = (1n << 64n) - 1n;

const sha = (...parts: Uint8Array[]): Uint8Array => sha256(concat(...parts));

export function shuffleSeed(table: Uint8Array, handNo: bigint, entropy: Uint8Array, seedMask: number, seeds: Uint8Array[]): Uint8Array {
  return sha(SHUFFLE_DOMAIN, table, u64le(handNo), entropy, u16le(seedMask), ...seeds);
}

/** sha256(seed ‖ counter) blocks read as u64s, with rejection sampling (no modulo bias). */
class Stream {
  private counter = 0;
  private block = new Uint8Array(32);
  private used = 32;
  constructor(private readonly seed: Uint8Array) {}
  private next(): bigint {
    if (this.used === 32) {
      this.block = sha(this.seed, u32le(this.counter++));
      this.used = 0;
    }
    const v = new DataView(this.block.buffer, this.block.byteOffset + this.used, 8).getBigUint64(0, true);
    this.used += 8;
    return v;
  }
  below(n: bigint): bigint {
    const zone = (U64_MAX / n) * n;
    for (;;) {
      const x = this.next();
      if (x < zone) return x % n;
    }
  }
}

export function shuffle(seed: Uint8Array): number[] {
  const cards = Array.from({ length: 52 }, (_, i) => i);
  const s = new Stream(seed);
  for (let i = 51; i >= 1; i--) {
    const j = Number(s.below(BigInt(i + 1)));
    [cards[i], cards[j]] = [cards[j]!, cards[i]!];
  }
  return cards;
}

export function seatsIn(mask: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < SEATS; i++) if (mask & (1 << i)) v.push(i);
  return v;
}

export function firstButton(seed: Uint8Array, mask: number): number {
  const s = seatsIn(mask);
  return s[Number(new Stream(sha(BUTTON_DOMAIN, seed)).below(BigInt(s.length)))]!;
}

export function nextButton(prev: number, mask: number): number {
  for (let step = 1; step <= SEATS; step++) {
    const s = (prev + step) % SEATS;
    if (mask & (1 << s)) return s;
  }
  return prev;
}

export function dealOrder(button: number, mask: number): number[] {
  const v: number[] = [];
  for (let step = 1; step <= SEATS; step++) {
    const s = (button + step) % SEATS;
    if (mask & (1 << s)) v.push(s);
  }
  return v;
}

/** Each dealt seat's two cards (NoCard for seats not dealt in). */
export function holeCards(deck: ArrayLike<number>, order: number[]): [number, number][] {
  const v: [number, number][] = Array.from({ length: SEATS }, () => [PerGame.NoCard, PerGame.NoCard]);
  for (let k = 0; k < order.length; k++) v[order[k]!] = [deck[k]!, deck[k + order.length]!];
  return v;
}

/** Burn, flop 3, burn, turn, burn, river after the hole cards (dealing.rs `board`). */
export function board(deck: ArrayLike<number>, dealt: number): number[] {
  const b = 2 * dealt;
  return [deck[b + 1]!, deck[b + 2]!, deck[b + 3]!, deck[b + 5]!, deck[b + 7]!];
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly problems: string[];
  readonly notes: string[];
  deck: number[];
}

function result(): VerifyResult {
  const r = { problems: [] as string[], notes: [] as string[], deck: [] as number[] };
  return Object.defineProperty(r, 'ok', { get: () => r.problems.length === 0, enumerable: true }) as VerifyResult;
}

/** Checks a record end to end (verifier.ts `verify`). Pass the previous hand's button to check this hand's. */
export function verify(r: HandRecord, prevButton?: number | null, mySeat?: number | null, mySeed?: Uint8Array | null, myCards?: number[] | null): VerifyResult {
  const res = result();
  if ((r.seedMask & ~r.dealtMask) !== 0) res.problems.push("a seat that wasn't dealt in has a seed");
  for (let i = 0; i < SEATS; i++)
    if ((r.seedMask & (1 << i)) === 0 && r.seeds[i]!.some((b) => b !== 0)) res.problems.push(`seat ${i} has a seed but isn't marked as committed`);
  if ((r.dealtMask & (1 << r.button)) === 0) res.problems.push("the button isn't on a dealt seat");
  const expected = r.handNo === 1n ? firstButton(r.shuffleSeed, r.dealtMask) : prevButton != null ? nextButton(prevButton, r.dealtMask) : null;
  if (expected !== null && expected !== r.button) res.problems.push(`button should be seat ${expected}, record says ${r.button}`);
  else if (expected === null) res.notes.push("the button wasn't checked: this client didn't see the hand before (the archive checks it)");
  if (!bytesEq(shuffleSeed(r.table, r.handNo, r.entropy, r.seedMask, r.seeds), r.shuffleSeed)) res.problems.push("shuffle seed doesn't match entropy + seeds");
  res.deck = shuffle(r.shuffleSeed);
  for (let i = 0; i < 52; i++)
    if (res.deck[i] !== r.cards[i]) {
      res.problems.push("deck doesn't match the shuffle seed");
      break;
    }
  if (mySeat != null) {
    const s = mySeat;
    // A seat can be dealt in without a seed (it hadn't committed when the seed window closed); that's a note,
    // not a failure. A seed it did commit must be the one used.
    if (mySeed && ((r.seedMask & (1 << s)) === 0 || !bytesEq(r.seeds[s], mySeed))) res.problems.push(`seat ${s}'s seed is missing or different`);
    if (!mySeed && (r.seedMask & (1 << s)) !== 0) res.notes.push(`seat ${s} has a seed in the record but this client didn't commit one`);
    if (!mySeed && (r.seedMask & (1 << s)) === 0) res.notes.push(`seat ${s} was dealt in without a seed (none committed before the hand started)`);
    if (myCards) {
      const got = holeCards(res.deck, dealOrder(r.button, r.dealtMask))[s]!;
      if (got[0] !== myCards[0] || got[1] !== myCards[1]) res.problems.push(`seat ${s}'s hole cards don't match the deck`);
    }
  }
  return res;
}

/** The action log's hash chain (table.rs `log_start` / `log_step`). */
export function logHash(table: Uint8Array, handNo: bigint, secret: Uint8Array, entries: LogEntry[]): Uint8Array {
  let h = sha(table, u64le(handNo), secret);
  for (const e of entries) h = sha(h, Uint8Array.of(e.street, e.seat, e.kind), u64le(e.committed));
  return h;
}

export function verifyLog(r: HandRecord, log: HandLog): VerifyResult {
  const res = result();
  if (!bytesEq(log.table, r.table) || log.handNo !== r.handNo) res.problems.push('the log belongs to another table or hand');
  if (log.len !== r.logLen) res.problems.push(`the log has ${log.len} entries, the record says ${r.logLen}`);
  const n = Math.min(log.len, log.entries.length);
  if (n < log.len) res.problems.push("the log overflowed its capacity; its tail can't be checked");
  if (!bytesEq(logHash(log.table, log.handNo, log.secret, log.entries.slice(0, n)), r.logHash)) res.problems.push("the log doesn't hash to the record's log hash");
  return res;
}
