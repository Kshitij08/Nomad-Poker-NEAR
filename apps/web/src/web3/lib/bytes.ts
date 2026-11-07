/** Small byte helpers shared by the web3 module (no Buffer: these run in the browser bundle). */

export function bytesEq(a: ArrayLike<number> | null | undefined, b: ArrayLike<number> | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const isZero = (a: ArrayLike<number>): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) return false;
  return true;
};

export function hex(b: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i]! & 0xff).toString(16).padStart(2, '0');
  return s;
}

export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function u64le(v: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(v)), true);
  return out;
}

export function u32le(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v >>> 0, true);
  return out;
}

export function u16le(v: number): Uint8Array {
  return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff);
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** "AbCd…WxYz" (PerTableSession.Name / WalletLoginUI.Truncate style). */
export function shortKey(k: string, head = 4, tail = 4, sep = '…'): string {
  return k.length <= head + tail ? k : k.slice(0, head) + sep + k.slice(-tail);
}
