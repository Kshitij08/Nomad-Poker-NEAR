/** Bitcoin-alphabet base58 (Solana addresses, signatures). */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const b of bytes) {
    if (b) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

export function decode(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const c of s) {
    let carry = INDEX.get(c);
    if (carry === undefined) throw new Error(`base58: bad character '${c}'`);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}
