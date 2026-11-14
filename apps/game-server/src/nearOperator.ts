/**
 * The game server's NEAR client: contract views over JSON-RPC, and function calls signed with the operator's
 * full-access key (the escrow's `operator`). No NEAR library: a FunctionCall transaction is a few dozen bytes of borsh,
 * signed with WebCrypto Ed25519, which Workers and Node both have.
 *
 * Several tables share one access key, so two may pick the same nonce: a call refused for its nonce reads the key's
 * nonce again and retries.
 */

export interface NearOperatorConfig {
  rpcUrl: string;
  /** The operator's account, e.g. `nomad-poker.testnet`. */
  accountId: string;
  /** `ed25519:<base58 of 64 bytes>` (seed ‖ public key), as the NEAR CLI stores it. */
  secretKey: string;
}

export class NearCallError extends Error {
  constructor(message: string, readonly retriable: boolean) {
    super(message);
  }
}

type FetchFn = typeof fetch;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b) break;
    s = '1' + s;
  }
  return s;
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Borsh writer for the handful of types a FunctionCall transaction needs. */
class Borsh {
  private parts: Uint8Array[] = [];
  u8(v: number): this {
    this.parts.push(Uint8Array.of(v));
    return this;
  }
  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.parts.push(b);
    return this;
  }
  uint(v: bigint, bytes: number): this {
    const b = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) b[i] = Number((v >> BigInt(8 * i)) & 255n);
    this.parts.push(b);
    return this;
  }
  fixed(b: Uint8Array): this {
    this.parts.push(b);
    return this;
  }
  bytes(b: Uint8Array): this {
    return this.u32(b.length).fixed(b);
  }
  string(s: string): this {
    return this.bytes(new TextEncoder().encode(s));
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((a, p) => a + p.length, 0));
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

export interface FunctionCall {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}

/** The borsh bytes of a one-action FunctionCall transaction (exported for tests). */
export function encodeTransaction(signerId: string, publicKey: Uint8Array, nonce: bigint, blockHash: Uint8Array, call: FunctionCall): Uint8Array {
  return new Borsh()
    .string(signerId)
    .u8(0)
    .fixed(publicKey)
    .uint(nonce, 8)
    .string(call.receiverId)
    .fixed(blockHash)
    .u32(1)
    .u8(2) // Action::FunctionCall
    .string(call.methodName)
    .bytes(new TextEncoder().encode(JSON.stringify(call.args)))
    .uint(call.gas, 8)
    .uint(call.deposit, 16)
    .done();
}

export class NearOperator {
  private readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
  private key: Promise<CryptoKey> | null = null;
  private nonce: bigint | null = null;
  /** Calls go one at a time per table (nonces in order). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: NearOperatorConfig,
    private readonly fetchImpl: FetchFn = (...a) => fetch(...a),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    const raw = base58Decode(cfg.secretKey.replace(/^ed25519:/, ''));
    if (raw.length !== 64) throw new Error('The NEAR operator key must be an ed25519 secret key (64 bytes).');
    this.seed = raw.slice(0, 32);
    this.publicKey = raw.slice(32);
  }

  get accountId(): string {
    return this.cfg.accountId;
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'nomad', method, params }) });
    } catch (e) {
      throw new NearCallError(`NEAR RPC unreachable: ${(e as Error).message}`, true);
    }
    const j = (await res.json().catch(() => null)) as { result?: T; error?: unknown } | null;
    if (!j) throw new NearCallError(`NEAR RPC answered ${res.status}`, true);
    if (j.error) {
      const text = JSON.stringify(j.error);
      throw new NearCallError(`NEAR RPC error: ${text.slice(0, 300)}`, /InvalidNonce|TIMEOUT_ERROR|Timeout|UNKNOWN_BLOCK|ShardUnavailable/i.test(text));
    }
    return j.result as T;
  }

  /** A contract view (call_function). */
  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.rpc<{ result?: number[]; error?: string }>('query', {
      request_type: 'call_function', finality: 'optimistic', account_id: contractId, method_name: method, args_base64: b64(new TextEncoder().encode(JSON.stringify(args))),
    });
    if (r.error || !r.result) throw new NearCallError(`view ${method}: ${r.error ?? 'no result'}`, false);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
  }

  private signingKey(): Promise<CryptoKey> {
    const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...this.seed]);
    this.key ??= crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']) as Promise<CryptoKey>;
    return this.key;
  }

  private async accessKey(): Promise<{ nonce: bigint; blockHash: Uint8Array }> {
    const r = await this.rpc<{ nonce: number | string; block_hash: string }>('query', {
      request_type: 'view_access_key', finality: 'final', account_id: this.cfg.accountId, public_key: 'ed25519:' + base58Encode(this.publicKey),
    });
    return { nonce: BigInt(r.nonce), blockHash: base58Decode(r.block_hash) };
  }

  /** Signs and sends a FunctionCall; resolves to the method's JSON return value once it executed. */
  call<T = unknown>(contractId: string, methodName: string, args: Record<string, unknown>, opts: { deposit?: bigint; tgas?: bigint } = {}): Promise<T> {
    const run = this.queue.then(() => this.callNow<T>({ receiverId: contractId, methodName, args, gas: (opts.tgas ?? 30n) * 10n ** 12n, deposit: opts.deposit ?? 0n }));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async callNow<T>(call: FunctionCall, attempt = 0): Promise<T> {
    try {
      const ak = await this.accessKey();
      const nonce = (this.nonce !== null && this.nonce >= ak.nonce ? this.nonce : ak.nonce) + 1n;
      this.nonce = nonce;
      const tx = encodeTransaction(this.cfg.accountId, this.publicKey, nonce, ak.blockHash, call);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', tx));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, await this.signingKey(), hash));
      const signed = new Borsh().fixed(tx).u8(0).fixed(sig).done();
      const out = await this.rpc<{ status?: { SuccessValue?: string; Failure?: unknown } }>('send_tx', { signed_tx_base64: b64(signed), wait_until: 'EXECUTED_OPTIMISTIC' });
      if (out.status?.Failure !== undefined) throw new NearCallError(`${call.methodName} failed: ${JSON.stringify(out.status.Failure).slice(0, 300)}`, false);
      const v = out.status?.SuccessValue;
      return (v ? JSON.parse(new TextDecoder().decode(fromB64(v))) : undefined) as T;
    } catch (e) {
      const retriable = e instanceof NearCallError ? e.retriable : true;
      if (!retriable || attempt >= 4) throw e;
      this.nonce = null;
      await this.sleep(300 * 2 ** attempt + Math.random() * 300);
      return this.callNow<T>(call, attempt + 1);
    }
  }
}
