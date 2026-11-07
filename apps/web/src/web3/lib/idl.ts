/**
 * A generic Anchor-IDL coder over the slimmed IDLs in src/data/web3-*-idl.json (tools/extract-web3-idl.mjs).
 * Replaces the generated C# bindings (Per/Core/Generated/PokerPerIdl.cs, per/scripts/gen-csharp.ts) and the
 * hand-written escrow decoder (Chain/AccountDecoder.cs) with one table-driven implementation:
 *  - decodeAccount: discriminator check, then the struct's fields in order; a short (older) layout → null, as the
 *    generated Decode does;
 *  - encodeIx: discriminator + Borsh args;
 *  - ixAccounts: the flattened account list ("group.name" for nested groups, like the C# IxAccount names);
 *  - errorText: the program's error for a numeric code (the rollup returns no logs).
 * Field names come out camelCased (`seat_mask` → `seatMask`); u64/i64 are bigints, pubkeys and byte arrays
 * Uint8Arrays, enums their variant index.
 */
import { BorshReader, BorshWriter } from './borsh';
import { bytesEq } from './bytes';

export type IdlType =
  | string
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { option: IdlType }
  | { defined: { name: string } };

export interface IdlIxAccount {
  name: string;
  w: 0 | 1;
  s: 0 | 1;
  addr?: string;
  opt?: 1;
}

export interface SlimIdl {
  address: string;
  instructions: Record<string, { d: number[]; args: [string, IdlType][]; accounts: IdlIxAccount[] }>;
  accounts: Record<string, number[]>;
  types: Record<string, { kind: 'struct'; fields: [string, IdlType][] } | { kind: 'enum'; variants: string[] }>;
  errors: Record<string, [string, string]>;
}

export const camel = (s: string): string => s.replace(/_(\w)/g, (_m, x: string) => x.toUpperCase());

export class IdlCoder {
  constructor(readonly idl: SlimIdl) {}

  /** Decodes an account (discriminator included); null if absent, another account type, or too short. */
  decodeAccount<T = Record<string, unknown>>(name: string, data: Uint8Array | null | undefined): T | null {
    const disc = this.idl.accounts[name];
    if (!disc) throw new Error(`unknown account ${name}`);
    if (!data || data.length < 8 || !bytesEq(data.subarray(0, 8), disc)) return null;
    try {
      return this.read({ defined: { name } }, new BorshReader(data, 8)) as T;
    } catch (e) {
      if (e instanceof RangeError) return null; // an older, shorter layout
      throw e;
    }
  }

  /** Reads one value of `t` (used by decodeAccount and by return-data readers). */
  read(t: IdlType, r: BorshReader): unknown {
    if (typeof t === 'string') {
      switch (t) {
        case 'u8': return r.u8();
        case 'i8': return r.i8();
        case 'u16': return r.u16();
        case 'u32': return r.u32();
        case 'u64': return r.u64();
        case 'i64': return r.i64();
        case 'bool': return r.bool();
        case 'pubkey': return r.bytes(32);
        case 'string': return r.str();
        case 'bytes': return r.bytes(r.u32());
        default: throw new Error(`idl type ${t}`);
      }
    }
    if ('array' in t) {
      const [inner, n] = t.array;
      if (inner === 'u8') return r.bytes(n);
      return Array.from({ length: n }, () => this.read(inner, r));
    }
    if ('vec' in t) {
      const n = r.u32();
      if (t.vec === 'u8') return r.bytes(n);
      return Array.from({ length: n }, () => this.read(t.vec, r));
    }
    if ('option' in t) return r.bool() ? this.read(t.option, r) : null;
    const def = this.idl.types[t.defined.name];
    if (!def) throw new Error(`idl type ${t.defined.name} missing`);
    if (def.kind === 'enum') return r.u8();
    const v: Record<string, unknown> = {};
    for (const [f, ft] of def.fields) v[camel(f)] = this.read(ft, r);
    return v;
  }

  write(t: IdlType, v: unknown, w: BorshWriter): void {
    if (typeof t === 'string') {
      switch (t) {
        case 'u8': return w.u8(Number(v));
        case 'i8': return w.u8(Number(v) & 0xff);
        case 'u16': return w.u16(Number(v));
        case 'u32': return w.u32(Number(v));
        case 'u64': return w.u64(v as bigint | number);
        case 'i64': return w.i64(v as bigint | number);
        case 'bool': return w.bool(!!v);
        case 'pubkey': return w.fixed(asBytes(v), 32);
        case 'string': return w.str(String(v));
        case 'bytes': return w.bytes(asBytes(v));
        default: throw new Error(`idl write ${t}`);
      }
    }
    if ('array' in t) {
      const [inner, n] = t.array;
      if (inner === 'u8') return w.fixed(asBytes(v), n);
      const arr = v as unknown[];
      if (arr.length !== n) throw new Error(`expected ${n} items`);
      for (const x of arr) this.write(inner, x, w);
      return;
    }
    if ('vec' in t) {
      if (t.vec === 'u8') return w.bytes(asBytes(v));
      const arr = v as unknown[];
      w.u32(arr.length);
      for (const x of arr) this.write(t.vec, x, w);
      return;
    }
    if ('option' in t) {
      const some = v !== null && v !== undefined;
      w.bool(some);
      if (some) this.write(t.option, v, w);
      return;
    }
    const def = this.idl.types[t.defined.name];
    if (!def) throw new Error(`idl type ${t.defined.name} missing`);
    if (def.kind === 'enum') return w.u8(Number(v));
    const obj = v as Record<string, unknown>;
    for (const [f, ft] of def.fields) {
      const key = camel(f);
      if (!(key in obj)) throw new Error(`${t.defined.name}.${key} missing`);
      this.write(ft, obj[key], w);
    }
  }

  /** Encodes an account (discriminator + fields): tests use it to build golden chain data. */
  encodeAccount(name: string, v: Record<string, unknown>): Uint8Array {
    const disc = this.idl.accounts[name];
    if (!disc) throw new Error(`unknown account ${name}`);
    const w = new BorshWriter();
    w.raw(disc);
    this.write({ defined: { name } }, v, w);
    return w.toBytes();
  }

  /** Instruction data: discriminator then args in IDL order (args keyed by camelCase name). */
  encodeIx(name: string, args: Record<string, unknown> = {}): Uint8Array {
    const ix = this.ix(name);
    const w = new BorshWriter();
    w.raw(ix.d);
    for (const [a, t] of ix.args) {
      const key = camel(a);
      if (!(key in args)) throw new Error(`${name}: argument ${key} missing`);
      this.write(t, args[key], w);
    }
    return w.toBytes();
  }

  ixAccounts(name: string): IdlIxAccount[] {
    return this.ix(name).accounts;
  }

  private ix(name: string) {
    const ix = this.idl.instructions[name];
    if (!ix) throw new Error(`unknown instruction ${name}`);
    return ix;
  }

  /** [name, message] for a program error code, or null. */
  error(code: number): [string, string] | null {
    return this.idl.errors[String(code)] ?? null;
  }

  /** PerIx.ErrorText: "Name: message", or "error N". */
  errorText(code: number): string {
    const e = this.error(code);
    return e ? `${e[0]}: ${e[1]}` : `error ${code}`;
  }
}

function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (v && typeof (v as { toBytes?: () => Uint8Array }).toBytes === 'function') return (v as { toBytes: () => Uint8Array }).toBytes();
  throw new Error('expected bytes');
}
