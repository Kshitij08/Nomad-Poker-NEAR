/**
 * System.IO.BinaryWriter / BinaryReader, byte-compatible with .NET: little-endian integers and floats, bool as one
 * byte, strings as a 7-bit-encoded UTF-8 byte length followed by the bytes. The poker event codec is written against
 * these so a payload encoded here decodes in the C# PokerEventCodec and vice versa.
 *
 * Int64 values travel as JS numbers: every long the codec carries (chips, pot, stacks) is far inside 2^53.
 */
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

export class BinaryWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initialCapacity = 64) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  writeByte(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.len, v & 0xff);
    this.len += 1;
  }

  writeSByte(v: number): void {
    this.ensure(1);
    this.view.setInt8(this.len, v);
    this.len += 1;
  }

  writeBool(v: boolean): void {
    this.writeByte(v ? 1 : 0);
  }

  writeUInt16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.len, v & 0xffff, true);
    this.len += 2;
  }

  writeInt32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.len, v | 0, true);
    this.len += 4;
  }

  writeInt64(v: number): void {
    this.ensure(8);
    this.view.setBigInt64(this.len, BigInt(Math.trunc(v)), true);
    this.len += 8;
  }

  writeSingle(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.len, v, true);
    this.len += 4;
  }

  /** BinaryWriter.Write(string): 7-bit encoded byte count, then UTF-8. */
  writeString(s: string): void {
    const bytes = utf8Encoder.encode(s ?? '');
    let n = bytes.length;
    while (n >= 0x80) {
      this.writeByte((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    this.writeByte(n);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  toArray(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class EndOfStreamError extends Error {
  constructor() {
    super('Unable to read beyond the end of the stream.');
    this.name = 'EndOfStreamException';
  }
}

export class BinaryReader {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private need(n: number): void {
    if (this.pos + n > this.data.byteLength) throw new EndOfStreamError();
  }

  readByte(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  readSByte(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }

  /** .NET ReadBoolean: any non-zero byte is true. */
  readBool(): boolean {
    return this.readByte() !== 0;
  }

  readUInt16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readInt32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readInt64(): number {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return Number(v);
  }

  readSingle(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readString(): string {
    let n = 0;
    let shift = 0;
    for (;;) {
      if (shift >= 35) throw new Error('Bad 7-bit encoded string length.');
      const b = this.readByte();
      n |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    this.need(n);
    const s = utf8Decoder.decode(this.data.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
}
