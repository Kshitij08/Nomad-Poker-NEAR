import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorCode } from '@nomad/contract';

/** A failure the client should see: becomes `{ error: { code, message } }` with `status`. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function fail(status: ContentfulStatusCode, code: ErrorCode, message: string): never {
  throw new ApiError(status, code, message);
}

export const iso = (ms: number): string => new Date(ms).toISOString();

const encoder = new TextEncoder();
export const utf8 = (s: string): Uint8Array => encoder.encode(s);

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A random opaque id or token: `prefix` + base64url of `bytes` random bytes. */
export const randomId = (prefix: string, bytes = 16): string => prefix + base64url(randomBytes(bytes));

export async function sha256Hex(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = new Map([...B58].map((ch, i) => [ch, i]));

/** Bitcoin-alphabet base58 (Solana addresses and signatures). Returns null on a bad character. */
export function base58Decode(s: string): Uint8Array | null {
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58_INDEX.get(ch);
    if (carry === undefined) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const b of bytes) {
    if (b !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** Reads a JSON body, failing with bad_request instead of throwing a SyntaxError. */
export async function readJson<T>(req: Request): Promise<Partial<T>> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === 'object' ? (body as Partial<T>) : {};
  } catch {
    return fail(400, 'bad_request', 'Expected a JSON body.');
  }
}

export function requireString(v: unknown, name: string, max = 2048): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) fail(400, 'bad_request', `"${name}" is required.`);
  return v;
}
