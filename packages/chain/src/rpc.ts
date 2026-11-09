import { base64 } from './transaction';

/**
 * A minimal Solana JSON-RPC client over fetch (Workers and Node). Devnet only: a mainnet URL is refused, as the old
 * backend's settlement key loader did.
 */
export class SolanaRpc {
  private id = 0;

  constructor(readonly url: string, private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {
    if (/mainnet/i.test(url)) throw new Error('refused: mainnet RPC (the new stack is devnet-only)');
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
    return body.result as T;
  }

  async latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return (await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  }

  /** Sends signed wire bytes; returns the signature. */
  sendTransaction(wire: Uint8Array): Promise<string> {
    return this.call<string>('sendTransaction', [base64(wire), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  }

  /** Polls until confirmed (or failed, or the blockhash expired). */
  async confirm(signature: string, lastValidBlockHeight: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    for (;;) {
      const st = await this.call<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[signature]]);
      const s = st.value[0];
      if (s?.err) throw new Error(`transaction failed: ${JSON.stringify(s.err)}`);
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return;
      const height = await this.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]);
      if (height > lastValidBlockHeight) throw new Error('blockhash expired before confirmation');
      await sleep(800);
    }
  }

  /** An account's data, or null when it doesn't exist. */
  async accountData(addressBase58: string): Promise<Uint8Array | null> {
    return (await this.account(addressBase58))?.data ?? null;
  }

  /** An account's data and lamports, or null when it doesn't exist. */
  async account(addressBase58: string): Promise<{ data: Uint8Array; lamports: number } | null> {
    const r = await this.call<{ value: { data: [string, string]; lamports: number } | null }>('getAccountInfo', [addressBase58, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!r.value) return null;
    return { data: unbase64(r.value.data[0]), lamports: r.value.lamports };
  }

  /** A program's accounts of one size whose bytes at `offset` equal `bytesBase58` (getProgramAccounts + memcmp). */
  async programAccounts(programBase58: string, dataSize: number, offset: number, bytesBase58: string): Promise<{ pubkey: string; data: Uint8Array; lamports: number }[]> {
    const r = await this.call<{ pubkey: string; account: { data: [string, string]; lamports: number } }[]>('getProgramAccounts', [
      programBase58,
      { encoding: 'base64', commitment: 'confirmed', filters: [{ dataSize }, { memcmp: { offset, bytes: bytesBase58 } }] },
    ]);
    return r.map((a) => ({ pubkey: a.pubkey, data: unbase64(a.account.data[0]), lamports: a.account.lamports }));
  }

  /** Several accounts in one call (null where one doesn't exist); at most 100 per call. */
  async accounts(addressesBase58: string[]): Promise<({ data: Uint8Array; lamports: number } | null)[]> {
    const out: ({ data: Uint8Array; lamports: number } | null)[] = [];
    for (let i = 0; i < addressesBase58.length; i += 100) {
      const r = await this.call<{ value: ({ data: [string, string]; lamports: number } | null)[] }>('getMultipleAccounts', [addressesBase58.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }]);
      for (const v of r.value) out.push(v ? { data: unbase64(v.data[0]), lamports: v.lamports } : null);
    }
    return out;
  }

  /** Signatures of transactions that touched an address, newest first (getSignaturesForAddress). */
  async signatures(addressBase58: string, limit = 100, before?: string): Promise<{ signature: string; err: unknown }[]> {
    return this.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [addressBase58, { limit, commitment: 'confirmed', ...(before ? { before } : {}) }]);
  }

  /** A confirmed transaction's fee payer (its first account), or null when the RPC doesn't have it. */
  async feePayer(signature: string): Promise<string | null> {
    const r = await this.call<{ transaction: { message: { accountKeys: string[] } } } | null>('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    return r?.transaction.message.accountKeys[0] ?? null;
  }

  async balance(addressBase58: string): Promise<number> {
    return (await this.call<{ value: number }>('getBalance', [addressBase58, { commitment: 'confirmed' }])).value;
  }
}

function unbase64(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
