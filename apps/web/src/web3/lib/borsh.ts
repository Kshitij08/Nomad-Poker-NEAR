/**
 * Little-endian Borsh reader/writer. Port of Per/Core/Borsh.cs. u64/i64 are bigints (lamports overflow a JS
 * number's 53 bits only in theory, but seat masks and nonces are compared exactly against chain data).
 */
export class BorshReader {
  private at: number;
  private readonly view: DataView;
  constructor(private readonly b: Uint8Array, offset = 0) {
    this.at = offset;
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get position(): number {
    return this.at;
  }
  private need(n: number): void {
    if (n < 0 || this.at + n > this.b.length) throw new RangeError(`read ${n} bytes at ${this.at} of ${this.b.length}`);
  }
  u8(): number {
    this.need(1);
    return this.b[this.at++]!;
  }
  i8(): number {
    const v = this.u8();
    return v > 127 ? v - 256 : v;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.at, true);
    this.at += 8;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.at, true);
    this.at += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.b.slice(this.at, this.at + n);
    this.at += n;
    return v;
  }
  str(): string {
    return new TextDecoder().decode(this.bytes(this.u32()));
  }
}

export class BorshWriter {
  private readonly out: number[] = [];
  toBytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
  raw(v: ArrayLike<number>): void {
    for (let i = 0; i < v.length; i++) this.out.push(v[i]! & 0xff);
  }
  u8(v: number): void {
    this.out.push(v & 0xff);
  }
  bool(v: boolean): void {
    this.out.push(v ? 1 : 0);
  }
  u16(v: number): void {
    this.out.push(v & 0xff, (v >>> 8) & 0xff);
  }
  u32(v: number): void {
    for (let i = 0; i < 4; i++) this.out.push((v >>> (8 * i)) & 0xff);
  }
  u64(v: bigint | number): void {
    let x = BigInt.asUintN(64, BigInt(v));
    for (let i = 0; i < 8; i++) {
      this.out.push(Number(x & 0xffn));
      x >>= 8n;
    }
  }
  i64(v: bigint | number): void {
    this.u64(BigInt.asUintN(64, BigInt(v)));
  }
  fixed(v: ArrayLike<number>, n: number): void {
    if (!v || v.length !== n) throw new Error(`expected ${n} bytes, got ${v?.length ?? 0}`);
    this.raw(v);
  }
  bytes(v: ArrayLike<number>): void {
    this.u32(v.length);
    this.raw(v);
  }
  str(v: string): void {
    this.bytes(new TextEncoder().encode(v));
  }
}
