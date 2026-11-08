import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import * as b58 from './base58';

/** A 32-byte Solana address. */
export type Address = Uint8Array;

export const address = (base58: string): Address => {
  const a = b58.decode(base58);
  if (a.length !== 32) throw new Error(`not a 32-byte address: ${base58}`);
  return a;
};
export const toBase58 = (a: Address): string => b58.encode(a);
export const sameAddress = (a: Address, b: Address): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const utf8 = new TextEncoder();
const PDA_MARKER = utf8.encode('ProgramDerivedAddress');

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/** PublicKey.findProgramAddressSync: the highest bump whose hash is off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: Address): [Address, number] {
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), programId, PDA_MARKER];
    const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      data.set(p, o);
      o += p.length;
    }
    const hash = sha256(data);
    if (!onCurve(hash)) return [hash, bump];
  }
  throw new Error('no program address found');
}

export const seed = (s: string): Uint8Array => utf8.encode(s);
