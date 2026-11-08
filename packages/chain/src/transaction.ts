import { address, sameAddress, toBase58, type Address } from './pubkey';
import * as b58 from './base58';

/** One account an instruction touches. */
export interface AccountMeta {
  pubkey: Address;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: Address;
  keys: AccountMeta[];
  data: Uint8Array;
}

/**
 * A signer whose secret never leaves WebCrypto: the key is imported non-extractable, and signing is
 * `crypto.subtle.sign('Ed25519', …)`, which Workers and Node both provide.
 */
export interface Signer {
  publicKey: Address;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/**
 * A signer from a Solana secret key: 64 bytes (seed + public key, the CLI's JSON array) or its base58 form, as stored
 * in a Worker secret. The public half is checked against what WebCrypto derives, so a corrupted secret fails loudly.
 */
export async function signerFromSecret(secret: Uint8Array | string | number[]): Promise<Signer> {
  const bytes = typeof secret === 'string' ? (secret.trim().startsWith('[') ? Uint8Array.from(JSON.parse(secret) as number[]) : b58.decode(secret.trim())) : Uint8Array.from(secret);
  if (bytes.length !== 64) throw new Error('a Solana secret key is 64 bytes');
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(bytes.subarray(0, 32), 16);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const publicKey = bytes.slice(32, 64);
  const signer: Signer = { publicKey, sign: async (m) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, m)) };
  const probe = Uint8Array.of(1, 2, 3);
  const pub = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
  if (!(await crypto.subtle.verify('Ed25519', pub, await signer.sign(probe), probe))) throw new Error('secret key and public key do not match');
  return signer;
}

function compactU16(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

const SORT_OPTIONS: Intl.CollatorOptions = { localeMatcher: 'best fit', usage: 'sort', sensitivity: 'variant', ignorePunctuation: false, numeric: false, caseFirst: 'lower' };

/**
 * A legacy transaction message, compiled the way @solana/web3.js 1.x compiles one (fee payer first, then signers,
 * then writable accounts, ties by base58), so its bytes match byte for byte.
 */
export function compileMessage(feePayer: Address, recentBlockhash: string, instructions: Instruction[]): { message: Uint8Array; signers: Address[] } {
  const metas: AccountMeta[] = [];
  const add = (m: AccountMeta) => {
    const found = metas.find((x) => sameAddress(x.pubkey, m.pubkey));
    if (found) {
      found.isSigner ||= m.isSigner;
      found.isWritable ||= m.isWritable;
    } else metas.push({ ...m });
  };
  for (const ix of instructions) {
    for (const k of ix.keys) add(k);
    add({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }
  metas.sort((x, y) => {
    if (x.isSigner !== y.isSigner) return x.isSigner ? -1 : 1;
    if (x.isWritable !== y.isWritable) return x.isWritable ? -1 : 1;
    return toBase58(x.pubkey).localeCompare(toBase58(y.pubkey), 'en', SORT_OPTIONS);
  });
  const payerAt = metas.findIndex((m) => sameAddress(m.pubkey, feePayer));
  if (payerAt >= 0) {
    const [payer] = metas.splice(payerAt, 1);
    payer!.isSigner = true;
    payer!.isWritable = true;
    metas.unshift(payer!);
  } else metas.unshift({ pubkey: feePayer, isSigner: true, isWritable: true });

  const signed = metas.filter((m) => m.isSigner);
  const unsigned = metas.filter((m) => !m.isSigner);
  const header = [signed.length, signed.filter((m) => !m.isWritable).length, unsigned.filter((m) => !m.isWritable).length];
  const ordered = [...signed, ...unsigned];
  const indexOf = (a: Address) => ordered.findIndex((m) => sameAddress(m.pubkey, a));

  const out: number[] = [...header, ...compactU16(ordered.length)];
  for (const m of ordered) out.push(...m.pubkey);
  out.push(...address(recentBlockhash));
  out.push(...compactU16(instructions.length));
  for (const ix of instructions) {
    out.push(indexOf(ix.programId));
    out.push(...compactU16(ix.keys.length), ...ix.keys.map((k) => indexOf(k.pubkey)));
    out.push(...compactU16(ix.data.length), ...ix.data);
  }
  return { message: Uint8Array.from(out), signers: signed.map((m) => m.pubkey) };
}

/** Signs a compiled message with every required signer (in the message's order) and returns the wire bytes. */
export async function signTransaction(compiled: { message: Uint8Array; signers: Address[] }, signers: Signer[]): Promise<Uint8Array> {
  const sigs: Uint8Array[] = [];
  for (const need of compiled.signers) {
    const s = signers.find((x) => sameAddress(x.publicKey, need));
    if (!s) throw new Error(`missing signer ${toBase58(need)}`);
    sigs.push(await s.sign(compiled.message));
  }
  const out = new Uint8Array(compactU16(sigs.length).length + sigs.length * 64 + compiled.message.length);
  let o = 0;
  for (const b of compactU16(sigs.length)) out[o++] = b;
  for (const s of sigs) {
    out.set(s, o);
    o += 64;
  }
  out.set(compiled.message, o);
  return out;
}

export function base64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
