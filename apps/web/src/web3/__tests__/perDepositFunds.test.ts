/**
 * A deposit from a wallet without enough SOL says so in plain words. It used to read "sendTransaction failed: error 1":
 * the System Program's code 1, looked up in the poker program's error list (staging, 9 Nov).
 */
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { PerGameWallet } from '../per/gameWallet';
import { NOT_ENOUGH_SOL, PerRpc, toTxError } from '../per/rpc';
import type { PerHttp } from '../lib/http';

// What devnet's preflight returned for a transfer above the balance (simulated 9 Nov).
const PREFLIGHT_INSUFFICIENT = {
  code: -32002,
  message: 'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1',
  data: {
    err: { InstructionError: [1, { Custom: 1 }] },
    logs: [
      'Program 11111111111111111111111111111111 invoke [1]',
      'Transfer: insufficient lamports 1397281600, need 1397286601',
      'Program 11111111111111111111111111111111 failed: custom program error: 0x1',
    ],
  },
};

describe('not enough SOL in the wallet', () => {
  it('maps the System Program\'s "insufficient lamports" to a plain message', () => {
    expect(toTxError('sendTransaction', PREFLIGHT_INSUFFICIENT).message).toBe(NOT_ENOUGH_SOL);
    expect(toTxError('sendTransaction', { message: 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.' }).message).toBe(NOT_ENOUGH_SOL);
  });

  it("leaves the poker program's own errors as they were", () => {
    expect(toTxError('transaction', { InstructionError: [0, { Custom: 6000 }] }).message).toMatch(/^transaction failed: /);
    expect(toTxError('transaction', { InstructionError: [0, { Custom: 6000 }] }).message).not.toBe(NOT_ENOUGH_SOL);
  });

  it('the RPC call surfaces it too', async () => {
    const http: PerHttp = { get: async () => ({ status: 200, body: '' }), post: async () => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: PREFLIGHT_INSUFFICIENT }) }), delay: async () => {} };
    await expect(new PerRpc(http, 'https://rpc.test').call('sendTransaction', 'AA==')).rejects.toThrow(NOT_ENOUGH_SOL);
  });

  it('checks the balance before the wallet is asked to sign', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const gw = (lamports: number) => {
      const http: PerHttp = { get: async () => ({ status: 200, body: '' }), post: async () => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: lamports } }) }), delay: async () => {} };
      const port = { address: wallet, connect: async () => true, signMessage: async () => { throw new Error('should not sign'); }, signTransactionBytes: async () => { throw new Error('should not sign'); } };
      return new PerGameWallet(http, 'https://rpc.test', 'https://tee.test', port);
    };
    await expect(gw(120_000_000).assertCanDeposit(500_000_000n)).rejects.toThrow(/Your wallet has .*0\.12.* Add devnet SOL/);
    await expect(gw(503_000_000).assertCanDeposit(500_000_000n)).resolves.toBeUndefined();
  });
});
