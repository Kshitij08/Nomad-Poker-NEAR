import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';

/**
 * Randomness abstraction so the engine never touches a global RNG. Port of Core/Cards/IRandom.cs,
 * SeededRandom.cs and CryptoRandom.cs, plus {@link DotNetRandom}: a bit-exact port of .NET's seeded
 * System.Random (Knuth subtractive generator, the algorithm both Mono/Unity and .NET use for `new Random(seed)`),
 * so a fixed seed deals the same deck — and seeded bots draw the same personalities — as the Unity build.
 */
export interface IRandom {
  /** Returns an int in [0, maxExclusive). */
  next(maxExclusive: number): number;
}

const MBIG = 2147483647; // int.MaxValue
const MSEED = 161803398;
const INT_MIN = -2147483648;

/** Bit-exact port of .NET's legacy seeded System.Random. */
export class DotNetRandom {
  private readonly seedArray = new Int32Array(56);
  private inext = 0;
  private inextp = 21;

  /** Seeded like `new System.Random(seed)`. With no seed, seeds from crypto (non-reproducible, like `new Random()`). */
  constructor(seed?: number) {
    const s = seed === undefined ? randomInt32() : seed | 0;
    const subtraction = s === INT_MIN ? MBIG : Math.abs(s);
    let mj = MSEED - subtraction;
    const a = this.seedArray;
    a[55] = mj;
    let mk = 1;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      a[ii] = mk;
      mk = (mj - mk) | 0; // C# int arithmetic wraps
      if (mk < 0) mk += MBIG;
      mj = a[ii]!;
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        let v = (a[i]! - a[1 + ((i + 30) % 55)]!) | 0;
        if (v < 0) v += MBIG;
        a[i] = v;
      }
    }
    this.inext = 0;
    this.inextp = 21;
  }

  private internalSample(): number {
    let locINext = this.inext + 1;
    if (locINext >= 56) locINext = 1;
    let locINextp = this.inextp + 1;
    if (locINextp >= 56) locINextp = 1;
    let ret = (this.seedArray[locINext]! - this.seedArray[locINextp]!) | 0;
    if (ret === MBIG) ret--;
    if (ret < 0) ret += MBIG;
    this.seedArray[locINext] = ret;
    this.inext = locINext;
    this.inextp = locINextp;
    return ret;
  }

  private sample(): number {
    return this.internalSample() * (1.0 / MBIG);
  }

  /** `Next()` with no argument: [0, int.MaxValue). `Next(max)`: [0, max). */
  next(maxExclusive?: number): number {
    if (maxExclusive === undefined) return this.internalSample();
    if (maxExclusive < 0) throw new RangeError('maxValue must be non-negative.');
    return Math.trunc(this.sample() * maxExclusive);
  }

  /** `Next(min, max)`: [min, max). */
  nextRange(minValue: number, maxExclusive: number): number {
    if (minValue > maxExclusive) throw new RangeError('minValue must be <= maxValue.');
    const range = maxExclusive - minValue;
    if (range <= MBIG) return Math.trunc(this.sample() * range) + minValue;
    // GetSampleForLargeRange
    let result = this.internalSample();
    if (this.internalSample() % 2 === 0) result = -result;
    let d = result;
    d += MBIG - 1;
    d /= 2 * MBIG - 1;
    return Math.trunc(d * range) + minValue;
  }

  /** [0, 1). */
  nextDouble(): number {
    return this.sample();
  }
}

/** Default IRandom backed by (a port of) System.Random. Seedable for reproducibility. */
export class SeededRandom implements IRandom {
  private readonly random: DotNetRandom;

  /** No seed: like C#'s `new SeededRandom()` (seeded from the tick count — here, the clock). */
  constructor(seed?: number) {
    this.random = new DotNetRandom(seed === undefined ? Date.now() & 0x7fffffff : seed);
  }

  next(maxExclusive: number): number {
    return this.random.next(maxExclusive);
  }
}

/** Unpredictable IRandom for live tables, backed by crypto.getRandomValues (uniform via rejection sampling). */
export class CryptoRandom implements IRandom {
  next(maxExclusive: number): number {
    if (!(maxExclusive > 0)) throw new RangeError(`maxExclusive must be positive, got ${maxExclusive}.`);
    if (maxExclusive === 1) return 0;
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      const v = buf[0]!;
      if (v < limit) return v % maxExclusive;
    }
  }
}

/**
 * A seedable, cryptographically secure IRandom: HMAC-DRBG over SHA-256 (NIST SP 800-90A, no prediction resistance,
 * no additional input). The same seed always yields the same stream, so a deck shuffled with it can be replayed from
 * the seed alone — the basis of deck commitments (see deckCommitment.ts). Draws are uniform via rejection sampling
 * on 32-bit big-endian words, exactly like {@link CryptoRandom}.
 *
 * Seed it with at least 32 bytes of real entropy, and {@link reseed} it before every hand: one seed, one deck.
 */
export class HmacDrbgRandom implements IRandom {
  /** Bytes pulled from the generator per refill (two SHA-256 blocks). */
  private static readonly BlockBytes = 64;
  private k = new Uint8Array(32);
  private v = new Uint8Array(32);
  private buf = new Uint8Array(0);
  private pos = 0;

  constructor(seed: Uint8Array) {
    this.reseed(seed);
  }

  /** Starts a fresh stream from `seed` (a full re-instantiation: nothing of the previous stream carries over). */
  reseed(seed: Uint8Array): void {
    if (!(seed instanceof Uint8Array) || seed.length < 16) throw new RangeError('HmacDrbgRandom needs a seed of at least 16 bytes.');
    this.k = new Uint8Array(32);
    this.v = new Uint8Array(32).fill(0x01);
    this.update(seed);
    this.buf = new Uint8Array(0);
    this.pos = 0;
  }

  next(maxExclusive: number): number {
    if (!(maxExclusive > 0)) throw new RangeError(`maxExclusive must be positive, got ${maxExclusive}.`);
    if (maxExclusive === 1) return 0;
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    for (;;) {
      const v = this.nextUint32();
      if (v < limit) return v % maxExclusive;
    }
  }

  private nextUint32(): number {
    if (this.pos + 4 > this.buf.length) {
      this.buf = this.generate(HmacDrbgRandom.BlockBytes);
      this.pos = 0;
    }
    const b = this.buf;
    const p = this.pos;
    this.pos += 4;
    return ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
  }

  /** HMAC_DRBG_Update. */
  private update(data: Uint8Array | null): void {
    this.k = hmac(sha256, this.k, concat(this.v, [0x00], data));
    this.v = hmac(sha256, this.k, this.v);
    if (!data || data.length === 0) return;
    this.k = hmac(sha256, this.k, concat(this.v, [0x01], data));
    this.v = hmac(sha256, this.k, this.v);
  }

  /** HMAC_DRBG_Generate. */
  private generate(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      this.v = hmac(sha256, this.k, this.v);
      const take = Math.min(this.v.length, n - off);
      out.set(this.v.subarray(0, take), off);
      off += take;
    }
    this.update(null);
    return out;
  }
}

function concat(a: Uint8Array, sep: number[], b: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(a.length + sep.length + (b?.length ?? 0));
  out.set(a, 0);
  out.set(sep, a.length);
  if (b) out.set(b, a.length + sep.length);
  return out;
}

function randomInt32(): number {
  const buf = new Int32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!;
}
