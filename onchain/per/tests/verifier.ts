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

/** Checks a record end to end. `mySeed`/`mySeat` let a player confirm their own seed went in. */
export function verify(r: Record, mine?: { seat: number; seed: Buffer; cards?: number[] }) {
  const problems: string[] = [];
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
  console.log(JSON.stringify({ seed: s.toString("hex"), deck: d, button: firstButton(s, 0b1001) }));
}
