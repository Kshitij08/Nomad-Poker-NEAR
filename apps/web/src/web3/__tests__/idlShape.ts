/** Test helpers: an instruction against the slim IDL's account list and discriminator. */
import type { TransactionInstruction } from '@solana/web3.js';
import { expect } from 'vitest';
import idl from '../../data/web3-per-idl.json';
import { PerIds } from '../per/addresses';

type IdlIx = { d: number[]; args: unknown[]; accounts: { name: string; w: number; s: number; addr?: string; opt?: number }[] };
export const IX = (idl as unknown as { instructions: Record<string, IdlIx> }).instructions;

/** The instruction has the IDL's account list (fixed addresses, flags) and starts with its discriminator. */
export function expectIdlShape(ix: TransactionInstruction, name: string, extraKeys = 0): void {
  const spec = IX[name]!;
  expect(ix.programId.equals(PerIds.program)).toBe(true);
  expect(ix.keys.length).toBe(spec.accounts.length + extraKeys);
  spec.accounts.forEach((a, i) => {
    const k = ix.keys[i]!;
    if (a.addr) expect(k.pubkey.toBase58(), `${name}.${a.name}`).toBe(a.addr);
    // An absent optional account is passed read-only as the program id.
    if (a.opt && k.pubkey.equals(PerIds.program)) return;
    expect(k.isSigner, `${name}.${a.name} signer`).toBe(!!a.s);
    expect(k.isWritable, `${name}.${a.name} writable`).toBe(!!a.w);
  });
  expect([...ix.data.subarray(0, 8)]).toEqual(spec.d);
}

/** The key passed for IDL account `account`. */
export const at = (ix: TransactionInstruction, name: string, account: string) => {
  const i = IX[name]!.accounts.findIndex((a) => a.name === account);
  if (i < 0) throw new Error(`${name} has no account ${account}`);
  return ix.keys[i]!.pubkey;
};
