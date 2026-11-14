import { describe, expect, it } from 'vitest';
import { NearOperator, base58Encode, base58Decode } from '../nearOperator';

// Built and signed with near-api-js 7.5.3 (createTransaction / encodeTransaction / SignedTransaction) from the same
// key (seed bytes 1..32), nonce 42 and block hash 0x07 × 32.
const SK = 'ed25519:2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSdZd8hbDHTd21as7EAsg7ypityqfsw2pMQKJcVDVcAEsd';
const SIGNED =
  'EwAAAG5vbWFkLXBva2VyLnRlc3RuZXQAebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQqAAAAAAAAABoAAABlc2Nyb3cubm9tYWQtcG9rZXIudGVzdG5ldAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHAQAAAAIIAAAAY2FzaF9vdXRmAAAAeyJ0YWJsZV9pZCI6InBva2VyLW1vbmV5LXN0NTAiLCJwbGF5ZXIiOiJhbGljZS50ZXN0bmV0IiwiYW1vdW50IjoiNTcwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJrZXkiOiJrMSJ9AOBX60gbAAAAAAAAAAAAAAAAAAAAAAAAAIBFbA3+IoOZen3oWRBmLnksbkec0hb+3qsWPX1entMIC96KeLX9K76xc6vNwl0KRDyNsjHo+BxG2qkTDjUlJg0=';
const ARGS = { table_id: 'poker-money-st50', player: 'alice.testnet', amount: '57000000000000000000000', key: 'k1' };

type Req = { method: string; params: Record<string, unknown> };

function fakeRpc(handlers: { sendTx: (signed: string, n: number) => unknown; nonce?: () => number }) {
  const sent: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as Req;
    let result: unknown;
    let error: unknown;
    if (req.method === 'query' && req.params.request_type === 'view_access_key') result = { nonce: handlers.nonce?.() ?? 41, block_hash: base58Encode(new Uint8Array(32).fill(7)) };
    else if (req.method === 'query' && req.params.request_type === 'call_function') result = { result: [...new TextEncoder().encode(JSON.stringify({ locked: '1' }))] };
    else if (req.method === 'send_tx') {
      const s = String(req.params.signed_tx_base64);
      sent.push(s);
      const r = handlers.sendTx(s, sent.length) as { error?: unknown; result?: unknown };
      result = r.result;
      error = r.error;
    }
    return new Response(JSON.stringify(error ? { error } : { result }));
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

describe('NearOperator', () => {
  it('signs a FunctionCall exactly as near-api-js does', async () => {
    const rpc = fakeRpc({ sendTx: () => ({ result: { status: { SuccessValue: btoa('true') } } }) });
    const op = new NearOperator({ rpcUrl: 'http://rpc', accountId: 'nomad-poker.testnet', secretKey: SK }, rpc.fetchImpl);
    const r = await op.call<boolean>('escrow.nomad-poker.testnet', 'cash_out', ARGS);
    expect(r).toBe(true);
    expect(rpc.sent).toEqual([SIGNED]);
  });

  it('retries with a fresh nonce when another table used it', async () => {
    let nonce = 41;
    const rpc = fakeRpc({
      nonce: () => nonce,
      sendTx: (_s, n) => (n === 1 ? ((nonce = 50), { error: { name: 'HANDLER_ERROR', data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 42, ak_nonce: 50 } } } } } }) : { result: { status: { SuccessValue: '' } } }),
    });
    const op = new NearOperator({ rpcUrl: 'http://rpc', accountId: 'nomad-poker.testnet', secretKey: SK }, rpc.fetchImpl, async () => {});
    await op.call('escrow.nomad-poker.testnet', 'cash_out', ARGS);
    expect(rpc.sent.length).toBe(2);
    // The second try carries nonce 51 (bytes 25.. of the transaction: after the 4+19 byte signer, 1+32 byte key).
    const tx = base58Decode(base58Encode(Uint8Array.from(atob(rpc.sent[1]!), (c) => c.charCodeAt(0))));
    expect(new DataView(tx.buffer).getBigUint64(4 + 19 + 33, true)).toBe(51n);
  });

  it('does not retry a contract refusal', async () => {
    const rpc = fakeRpc({ sendTx: () => ({ result: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: not seated' } } } } } } }) });
    const op = new NearOperator({ rpcUrl: 'http://rpc', accountId: 'nomad-poker.testnet', secretKey: SK }, rpc.fetchImpl, async () => {});
    await expect(op.call('escrow.nomad-poker.testnet', 'cash_out', ARGS)).rejects.toThrow(/not seated/);
    expect(rpc.sent.length).toBe(1);
  });

  it('reads views', async () => {
    const rpc = fakeRpc({ sendTx: () => ({}) });
    const op = new NearOperator({ rpcUrl: 'http://rpc', accountId: 'nomad-poker.testnet', secretKey: SK }, rpc.fetchImpl);
    expect(await op.view('escrow.nomad-poker.testnet', 'get_seat', { table_id: 't', player: 'a' })).toEqual({ locked: '1' });
  });
});
