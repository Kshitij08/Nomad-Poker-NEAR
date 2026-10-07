// Off-chain hand verifier: recomputes a hand's deck from its public record, independently of the
// program. Mirrors programs/poker-per/src/deal.rs; keep the two in step (the domain strings carry a
// version). Run directly for the fixed-vector self-test: npx tsx tests/verifier.ts
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

export const SEATS = 9;
export const NO_CARD = 255;
const sha = (...parts: Buffer[]) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

export const entropyOf = (vrf: Buffer) => sha(Buffer.from("poker-per/entropy/v1"), vrf);

export function shuffleSeed(table: PublicKey, handNo: bigint, entropy: Buffer, seedMask: number, seeds: Buffer[]): Buffer {
  return sha(Buffer.from("poker-per/shuffle/v1"), table.toBuffer(), u64le(handNo), entropy, u16le(seedMask), ...seeds.map((s) => Buffer.from(s)));
}

class Stream {
  private counter = 0; private block = Buffer.alloc(32); private used = 32;
  constructor(private seed: Buffer) {}
  nextU64(): bigint {
    if (this.used === 32) { this.block = sha(this.seed, u32le(this.counter++)); this.used = 0; }
    const v = this.block.readBigUInt64LE(this.used); this.used += 8; return v;
  }
  below(n: bigint): bigint {
    const MAX = (1n << 64n) - 1n;
    const zone = (MAX / n) * n;
    for (;;) { const x = this.nextU64(); if (x < zone) return x % n; }
  }
}

export function shuffle(seed: Buffer): number[] {
  const cards = Array.from({ length: 52 }, (_, i) => i);
  const s = new Stream(seed);
  for (let i = 51; i >= 1; i--) { const j = Number(s.below(BigInt(i + 1))); [cards[i], cards[j]] = [cards[j], cards[i]]; }
  return cards;
}

export const seatsIn = (mask: number) => Array.from({ length: SEATS }, (_, i) => i).filter((i) => mask & (1 << i));
export function firstButton(seed: Buffer, mask: number): number {
  const seats = seatsIn(mask);
  return seats[Number(new Stream(sha(Buffer.from("poker-per/button/v1"), seed)).below(BigInt(seats.length)))];
}
export function nextButton(prev: number, mask: number): number {
  for (let step = 1; step <= SEATS; step++) { const s = (prev + step) % SEATS; if (mask & (1 << s)) return s; }
  return prev;
}
export function dealOrder(button: number, mask: number): number[] {
  const out: number[] = [];
  for (let step = 1; step <= SEATS; step++) { const s = (button + step) % SEATS; if (mask & (1 << s)) out.push(s); }
  return out;
}
export function holeCards(deck: number[], order: number[]): number[][] {
  const out = Array.from({ length: SEATS }, () => [NO_CARD, NO_CARD]);
  order.forEach((seat, k) => { out[seat] = [deck[k], deck[k + order.length]]; });
  return out;
}

const RANKS = "23456789TJQKA", SUITS = "cdhs";
export const cardName = (c: number) => (c === NO_CARD ? "--" : RANKS[c % 13] + SUITS[Math.floor(c / 13)]);

/** A published hand record, as decoded from the program's `HandRecord` account. */
export type Record = { table: PublicKey; handNo: bigint; button: number; dealtMask: number; seedMask: number; seeds: Buffer[]; entropy: Buffer; shuffleSeed: Buffer; cards: number[] };

/**
 * Checks a record end to end: seeds only from dealt seats, the shuffle seed, the deck, and the
 * button (recomputed for hand 1; for later hands pass the previous hand's button). `mine` lets a
 * player confirm their own seed went in and their hole cards came from this deck.
 */
export function verify(r: Record, mine?: { seat: number; seed: Buffer; cards?: number[] }, prevButton?: number) {
  const problems: string[] = [];
  if ((r.seedMask & ~r.dealtMask) !== 0) problems.push("a seat that wasn't dealt in has a seed");
  r.seeds.forEach((s, i) => { if (!(r.seedMask & (1 << i)) && !s.equals(Buffer.alloc(32))) problems.push(`seat ${i} has a seed but isn't marked as committed`); });
  if (!(r.dealtMask & (1 << r.button))) problems.push("the button isn't on a dealt seat");
  const expectedButton = r.handNo === 1n ? firstButton(r.shuffleSeed, r.dealtMask) : prevButton === undefined ? undefined : nextButton(prevButton, r.dealtMask);
  if (expectedButton !== undefined && expectedButton !== r.button) problems.push(`button should be seat ${expectedButton}, record says ${r.button}`);
  const seedOk = shuffleSeed(r.table, r.handNo, r.entropy, r.seedMask, r.seeds).equals(r.shuffleSeed);
  if (!seedOk) problems.push("shuffle seed doesn't match entropy + seeds");
  const deck = shuffle(r.shuffleSeed);
  if (deck.some((c, i) => c !== r.cards[i])) problems.push("deck doesn't match the shuffle seed");
  if (mine) {
    if (!(r.seedMask & (1 << mine.seat)) || !r.seeds[mine.seat].equals(mine.seed)) problems.push(`seat ${mine.seat}'s seed is missing or different`);
    if (mine.cards) {
      const got = holeCards(deck, dealOrder(r.button, r.dealtMask))[mine.seat];
      if (got[0] !== mine.cards[0] || got[1] !== mine.cards[1]) problems.push(`seat ${mine.seat}'s hole cards don't match the deck`);
    }
  }
  return { ok: problems.length === 0, problems, deck };
}

// Self-test against the fixed vector in deal.rs (known_vector).
if (require.main === module) {
  const table = new PublicKey(Buffer.alloc(32, 7));
  const seeds = Array.from({ length: SEATS }, () => Buffer.alloc(32));
  seeds[0] = Buffer.alloc(32, 1); seeds[3] = Buffer.alloc(32, 2);
  const s = shuffleSeed(table, 5n, entropyOf(Buffer.alloc(32, 9)), 0b1001, seeds);
  const d = shuffle(s);
  const KNOWN_SEED = "d12346b4bf0787f377276f2df1ed63464de16f3a0352a6a3e956f59b299fc540";
  const KNOWN_DECK = [14, 22, 24, 23, 15, 17, 13, 49, 35, 11, 34, 10, 25, 39, 42, 33, 6, 40, 26, 21, 20, 28, 31, 32, 27, 48, 47, 38, 41, 46, 45, 4, 36, 18, 43, 44, 9, 30, 19, 37, 7, 0, 8, 16, 50, 3, 29, 51, 2, 5, 12, 1];
  const ok = s.toString("hex") === KNOWN_SEED && d.join() === KNOWN_DECK.join() && firstButton(s, 0b1001) === 3;
  console.log(JSON.stringify({ seed: s.toString("hex"), deck: d, button: firstButton(s, 0b1001), matchesRustVector: ok }));
  if (!ok) process.exit(1);
}
