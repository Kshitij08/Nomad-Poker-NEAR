/**
 * Talking to Solana and the TEE rollup: JSON-RPC, the rollup login, and building/sending transactions with any
 * signer (the session key locally, or the browser wallet). Port of Per/Core/PerRpc.cs.
 */
import { Buffer } from 'buffer';
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { fromBase64, toBase64, utf8 } from '../lib/bytes';
import type { PerHttp } from '../lib/http';
import { perIdl } from './types';

/** Something that can sign a transaction message: a local key, or a wallet's signMessage. */
export interface PerSigner {
  readonly publicKey: PublicKey;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/** A wallet that signs whole transactions (it shows the player what they're signing). */
export interface PerTransactionSigner {
  readonly publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

/** A key held by the client (the per-table session key, or a play key). */
export class LocalSigner implements PerSigner {
  constructor(readonly keypair: Keypair) {}
  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return ed25519.sign(message, this.keypair.secretKey.slice(0, 32));
  }
}

/** A failed send or a failed transaction, with the program's error when there is one. */
export class PerTxException extends Error {
  constructor(
    message: string,
    readonly programError: number | null,
    /** Which instruction failed, when the error says (InstructionError[index, ...]). */
    readonly instructionIndex: number | null = null,
  ) {
    super(message);
  }
  get errorName(): string | null {
    return this.programError !== null ? (perIdl.error(this.programError)?.[0] ?? null) : null;
  }
}

/** UnauthorizedAccessException: the rollup login expired (HTTP 401/403). */
export class PerUnauthorized extends Error {}

export class PerRpc {
  private id = 0;
  constructor(private readonly http: PerHttp, public url: string) {}

  /** Points this connection at a new URL (a refreshed rollup login). */
  setUrl(url: string): void {
    this.url = url;
  }

  async call(method: string, ...args: unknown[]): Promise<any> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params: args });
    let { status, body: text } = await this.http.post(this.url, body);
    // Public RPCs rate-limit with 429. Every call here is safe to repeat (a resent transaction has the same
    // signature), so back off and retry a few times: 0.5, 1, 2, 4, then 5 s, about 28 s in all.
    for (let attempt = 1; status === 429 && attempt <= 8; attempt++) {
      await this.http.delay(Math.min(500 << (attempt - 1), 5000));
      ({ status, body: text } = await this.http.post(this.url, body));
    }
    if (status === 401 || status === 403) throw new PerUnauthorized(`${method}: HTTP ${status}`);
    if (status !== 200) throw new Error(`${method}: HTTP ${status}`);
    const json = JSON.parse(text);
    if (json.error != null) throw toTxError(method, json.error);
    return json.result;
  }

  /** An account's data, or null if it doesn't exist (or this login can't read it). */
  async getAccount(key: PublicKey, commitment = 'processed'): Promise<Uint8Array | null> {
    const r = await this.call('getAccountInfo', key.toBase58(), { encoding: 'base64', commitment });
    const v = r?.value;
    if (v == null) return null;
    return fromBase64(v.data[0]);
  }

  /** getAccountInfo's owner and data (PerGameWallet.OwnerAndData / PerEntry.HostedState). */
  async getAccountWithOwner(key: PublicKey, commitment = 'confirmed'): Promise<{ owner: string; data: Uint8Array; lamports: number } | null> {
    const r = await this.call('getAccountInfo', key.toBase58(), { encoding: 'base64', commitment });
    const v = r?.value;
    if (v == null) return null;
    return { owner: v.owner, data: fromBase64(v.data[0]), lamports: v.lamports };
  }

  async latestBlockhash(): Promise<string> {
    return (await this.call('getLatestBlockhash', { commitment: 'confirmed' })).value.blockhash;
  }

  /** Builds, has the wallet sign (it's the fee payer), sends and confirms. Returns the signature. */
  async sendWithWallet(ixs: TransactionInstruction[], wallet: PerTransactionSigner): Promise<string> {
    const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: await this.latestBlockhash() }).add(...ixs);
    const signed = await wallet.signTransaction(tx);
    if (!signed) throw new PerTxException("the wallet didn't sign", null);
    return this.sendRaw(signed.serialize());
  }

  /** Builds, signs (fee payer = first signer), sends and confirms. Returns the signature. */
  async send(ixs: TransactionInstruction[], ...signers: PerSigner[]): Promise<string> {
    return this.sendRaw(await this.buildSigned(ixs, signers));
  }

  /** Simulates (signed by `signers`, fee payer first) and returns the program's return data, or throws. */
  async simulateReturn(ixs: TransactionInstruction[], ...signers: PerSigner[]): Promise<Uint8Array | null> {
    const raw = await this.buildSigned(ixs, signers);
    const r = await this.call('simulateTransaction', toBase64(raw), { encoding: 'base64', commitment: 'confirmed' });
    const v = r?.value;
    if (v?.err != null) throw toTxError('simulation', v.err);
    // A success without return data has "returnData": null: that's no data, not an error.
    const rd = v?.returnData;
    if (rd == null || typeof rd !== 'object') return null;
    const data = Array.isArray(rd.data) && rd.data.length > 0 ? rd.data[0] : null;
    return data == null ? null : fromBase64(data);
  }

  private async buildSigned(ixs: TransactionInstruction[], signers: PerSigner[]): Promise<Uint8Array> {
    if (signers.length === 0) throw new Error('no signer');
    const tx = new Transaction({ feePayer: signers[0]!.publicKey, recentBlockhash: await this.latestBlockhash() }).add(...ixs);
    const message = tx.serializeMessage();
    for (const s of signers) tx.addSignature(s.publicKey, Buffer.from(await s.signMessage(message)));
    return tx.serialize();
  }

  private async sendRaw(tx: Uint8Array): Promise<string> {
    const sig: string = await this.call('sendTransaction', toBase64(tx), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'processed' });
    await this.confirm(sig);
    return sig;
  }

  private async confirm(sig: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const v = (await this.call('getSignatureStatuses', [sig]))?.value?.[0];
      if (v != null) {
        if (v.err != null) throw toTxError('transaction', v.err);
        const c = v.confirmationStatus;
        if (c === 'confirmed' || c === 'finalized' || c === 'processed') return;
      }
      await this.http.delay(600); // public RPCs rate-limit fast polling
    }
    throw new Error(`transaction ${sig} not confirmed in 30 s`);
  }
}

/** Finds a custom program error code in an RPC error or a transaction's err (PerRpc.ToTxError). */
export function toTxError(what: string, err: unknown): PerTxException {
  const text = JSON.stringify(err);
  let code: number | null = null;
  const custom = findKey(err, 'Custom');
  if (typeof custom === 'number') code = custom;
  else {
    const m = /custom program error: 0x([0-9a-fA-F]+)/.exec(text);
    if (m) code = Number.parseInt(m[1]!, 16);
  }
  const label = code !== null ? perIdl.errorText(code) : text.length > 300 ? text.slice(0, 300) : text;
  let index: number | null = null;
  const ie = findKey(err, 'InstructionError');
  if (Array.isArray(ie) && typeof ie[0] === 'number') index = ie[0];
  return new PerTxException(`${what} failed: ${label}`, code, index);
}

function findKey(v: unknown, key: string): unknown {
  if (v == null || typeof v !== 'object') return undefined;
  if (!Array.isArray(v) && key in (v as object)) return (v as Record<string, unknown>)[key];
  for (const x of Object.values(v as object)) {
    const f = findKey(x, key);
    if (f !== undefined) return f;
  }
  return undefined;
}

/** MagicBlock's rollup login: sign a challenge, get a token for `?token=` URLs (TeeAuth). */
export const TeeAuth = {
  async login(http: PerHttp, teeUrl: string, signer: PerSigner): Promise<string> {
    const r1 = await http.get(`${teeUrl}/auth/challenge?pubkey=${signer.publicKey.toBase58()}`);
    if (r1.status !== 200) throw new Error(`rollup login challenge: HTTP ${r1.status}`);
    const challenge: string = JSON.parse(r1.body).challenge;
    const signature = bs58.encode(await signer.signMessage(utf8(challenge)));
    const r2 = await http.post(`${teeUrl}/auth/login`, JSON.stringify({ pubkey: signer.publicKey.toBase58(), challenge, signature }));
    if (r2.status !== 200) throw new Error(`rollup login: HTTP ${r2.status}`);
    return JSON.parse(r2.body).token;
  },
};
