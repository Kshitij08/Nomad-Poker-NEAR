/**
 * NEAR transactions and NEP-366 delegate actions in borsh, without near-api-js. Shared by the web app (it signs
 * delegate actions with a key kept in the browser) and the API (it checks them and wraps them in a transaction the
 * sponsor signs and pays for). Only the actions Nomad uses are covered: CreateAccount, FunctionCall, Transfer, AddKey
 * and Delegate. No dependencies: hashing is WebCrypto's SHA-256 and signing is a callback.
 *
 * Layouts (nearcore `core/primitives`):
 *   Transaction       { signer_id: String, public_key: PublicKey, nonce: u64, receiver_id: String, block_hash: [u8;32], actions: Vec<Action> }
 *   SignedTransaction { transaction, signature: Signature }
 *   DelegateAction    { sender_id, receiver_id, actions: Vec<NonDelegateAction>, nonce: u64, max_block_height: u64, public_key }
 *   SignedDelegate    { delegate_action, signature }
 *   PublicKey = u8 key type (0 = ed25519) + 32 bytes; Signature = u8 key type + 64 bytes.
 * A delegate action is signed over sha256(u32le(2^30 + 366) ‖ borsh(DelegateAction)), so it can never pass for a
 * transaction; a transaction over sha256(borsh(Transaction)).
 */

// ------------------------------------------------------------------ base58 / base64

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** "ed25519:<base58>" ⇄ 32 key bytes. */
export function parsePublicKey(text: string): Uint8Array | null {
  if (!text.startsWith('ed25519:')) return null;
  const raw = base58Decode(text.slice(8));
  return raw?.length === 32 ? raw : null;
}
export const publicKeyText = (key: Uint8Array): string => `ed25519:${base58Encode(key)}`;

/** A NEAR secret key as wallets and near-cli write it: "ed25519:<base58 of seed ‖ public key>" (64 bytes). */
export function parseSecretKey(text: string): { seed: Uint8Array; publicKey: Uint8Array } | null {
  if (!text.startsWith('ed25519:')) return null;
  const raw = base58Decode(text.slice(8));
  if (raw?.length !== 64) return null;
  return { seed: raw.slice(0, 32), publicKey: raw.slice(32) };
}
export function secretKeyText(seed: Uint8Array, publicKey: Uint8Array): string {
  const raw = new Uint8Array(64);
  raw.set(seed, 0);
  raw.set(publicKey, 32);
  return `ed25519:${base58Encode(raw)}`;
}

// ------------------------------------------------------------------ types

export type FunctionCallAction = { type: 'FunctionCall'; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
export type NearAction =
  | { type: 'CreateAccount' }
  | FunctionCallAction
  | { type: 'Transfer'; deposit: bigint }
  | { type: 'AddKey'; publicKey: Uint8Array; fullAccess: true }
  | { type: 'Delegate'; signed: SignedDelegate };

export type DelegateAction = {
  senderId: string;
  receiverId: string;
  /** Delegate actions can't nest. */
  actions: Exclude<NearAction, { type: 'Delegate' }>[];
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: Uint8Array;
};
export type SignedDelegate = { delegate: DelegateAction; signature: Uint8Array };

export type Transaction = {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  actions: NearAction[];
};

/** A JSON function call, as the app's contract calls are written. */
export const functionCall = (methodName: string, args: Record<string, unknown>, gas: bigint, deposit: bigint): FunctionCallAction => ({
  type: 'FunctionCall',
  methodName,
  args: new TextEncoder().encode(JSON.stringify(args)),
  gas,
  deposit,
});

export const TGAS = 10n ** 12n;
export const YOCTO_PER_NEAR = 10n ** 24n;
/** NEP-366's prefix, 2^30 + 366. */
export const NEP366_TAG = 2 ** 30 + 366;

// ------------------------------------------------------------------ writer

class Writer {
  private buf = new Uint8Array(256);
  private len = 0;
  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  u8(n: number) {
    this.bytes(Uint8Array.of(n));
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    this.bytes(b);
  }
  uint(n: bigint, size: 8 | 16) {
    if (n < 0n || n >= 1n << BigInt(size * 8)) throw new Error(`u${size * 8} out of range`);
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
    this.bytes(b);
  }
  string(s: string) {
    const b = new TextEncoder().encode(s);
    this.u32(b.length);
    this.bytes(b);
  }
  vecBytes(b: Uint8Array) {
    this.u32(b.length);
    this.bytes(b);
  }
  key(k: Uint8Array) {
    if (k.length !== 32) throw new Error('ed25519 keys are 32 bytes');
    this.u8(0);
    this.bytes(k);
  }
  signature(s: Uint8Array) {
    if (s.length !== 64) throw new Error('ed25519 signatures are 64 bytes');
    this.u8(0);
    this.bytes(s);
  }
  out(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const ACTION_INDEX = { CreateAccount: 0, FunctionCall: 2, Transfer: 3, AddKey: 5, Delegate: 8 } as const;

function writeAction(w: Writer, a: NearAction) {
  w.u8(ACTION_INDEX[a.type]);
  switch (a.type) {
    case 'CreateAccount':
      return;
    case 'FunctionCall':
      w.string(a.methodName);
      w.vecBytes(a.args);
      w.uint(a.gas, 8);
      w.uint(a.deposit, 16);
      return;
    case 'Transfer':
      w.uint(a.deposit, 16);
      return;
    case 'AddKey':
      w.key(a.publicKey);
      w.uint(0n, 8); // access key nonce
      w.u8(1); // FullAccess
      return;
    case 'Delegate':
      writeDelegate(w, a.signed.delegate);
      w.signature(a.signed.signature);
  }
}

function writeDelegate(w: Writer, d: DelegateAction) {
  w.string(d.senderId);
  w.string(d.receiverId);
  w.u32(d.actions.length);
  for (const a of d.actions) writeAction(w, a);
  w.uint(d.nonce, 8);
  w.uint(d.maxBlockHeight, 8);
  w.key(d.publicKey);
}

export function encodeDelegate(d: DelegateAction): Uint8Array {
  const w = new Writer();
  writeDelegate(w, d);
  return w.out();
}

export function encodeSignedDelegate(s: SignedDelegate): Uint8Array {
  const w = new Writer();
  writeDelegate(w, s.delegate);
  w.signature(s.signature);
  return w.out();
}

export function encodeTransaction(t: Transaction): Uint8Array {
  const w = new Writer();
  w.string(t.signerId);
  w.key(t.publicKey);
  w.uint(t.nonce, 8);
  w.string(t.receiverId);
  if (t.blockHash.length !== 32) throw new Error('block hash is 32 bytes');
  w.bytes(t.blockHash);
  w.u32(t.actions.length);
  for (const a of t.actions) writeAction(w, a);
  return w.out();
}

export function encodeSignedTransaction(t: Transaction, signature: Uint8Array): Uint8Array {
  const w = new Writer();
  w.bytes(encodeTransaction(t));
  w.signature(signature);
  return w.out();
}

// ------------------------------------------------------------------ reader

class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}
  take(n: number): Uint8Array {
    if (this.o + n > this.b.length) throw new Error('truncated');
    const out = this.b.slice(this.o, this.o + n);
    this.o += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  u32(): number {
    return new DataView(this.take(4).buffer).getUint32(0, true);
  }
  uint(size: 8 | 16): bigint {
    const b = this.take(size);
    let n = 0n;
    for (let i = size - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
    return n;
  }
  string(): string {
    const n = this.u32();
    if (n > 4096) throw new Error('string too long');
    return new TextDecoder().decode(this.take(n));
  }
  vecBytes(): Uint8Array {
    const n = this.u32();
    if (n > 1 << 20) throw new Error('bytes too long');
    return this.take(n);
  }
  key(): Uint8Array {
    if (this.u8() !== 0) throw new Error('only ed25519 keys');
    return this.take(32);
  }
  signature(): Uint8Array {
    if (this.u8() !== 0) throw new Error('only ed25519 signatures');
    return this.take(64);
  }
  done() {
    if (this.o !== this.b.length) throw new Error('trailing bytes');
  }
}

function readAction(r: Reader, nested: boolean): NearAction {
  const i = r.u8();
  switch (i) {
    case 0:
      return { type: 'CreateAccount' };
    case 2:
      return { type: 'FunctionCall', methodName: r.string(), args: r.vecBytes(), gas: r.uint(8), deposit: r.uint(16) };
    case 3:
      return { type: 'Transfer', deposit: r.uint(16) };
    case 5: {
      const publicKey = r.key();
      r.uint(8);
      if (r.u8() !== 1) throw new Error('only full-access keys');
      return { type: 'AddKey', publicKey, fullAccess: true };
    }
    case 8: {
      if (nested) throw new Error('delegate actions cannot nest');
      const delegate = readDelegate(r);
      return { type: 'Delegate', signed: { delegate, signature: r.signature() } };
    }
    default:
      throw new Error(`unsupported action ${i}`);
  }
}

function readDelegate(r: Reader): DelegateAction {
  const senderId = r.string();
  const receiverId = r.string();
  const n = r.u32();
  if (n > 16) throw new Error('too many actions');
  const actions = Array.from({ length: n }, () => readAction(r, true) as DelegateAction['actions'][number]);
  return { senderId, receiverId, actions, nonce: r.uint(8), maxBlockHeight: r.uint(8), publicKey: r.key() };
}

/** Parses a borsh SignedDelegateAction (throws on anything malformed or outside the actions above). */
export function decodeSignedDelegate(bytes: Uint8Array): SignedDelegate {
  const r = new Reader(bytes);
  const delegate = readDelegate(r);
  const signature = r.signature();
  r.done();
  return { delegate, signature };
}

/** Parses a borsh SignedTransaction (tests and tools). */
export function decodeSignedTransaction(bytes: Uint8Array): { transaction: Transaction; signature: Uint8Array } {
  const r = new Reader(bytes);
  const signerId = r.string();
  const publicKey = r.key();
  const nonce = r.uint(8);
  const receiverId = r.string();
  const blockHash = r.take(32);
  const n = r.u32();
  const actions = Array.from({ length: n }, () => readAction(r, false));
  const signature = r.signature();
  r.done();
  return { transaction: { signerId, publicKey, nonce, receiverId, blockHash, actions }, signature };
}

// ------------------------------------------------------------------ hashes and signing

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b));
}

/** What the sender's key signs for a delegate action (NEP-366). */
export async function delegateHash(d: DelegateAction): Promise<Uint8Array> {
  const body = encodeDelegate(d);
  const msg = new Uint8Array(4 + body.length);
  new DataView(msg.buffer).setUint32(0, NEP366_TAG, true);
  msg.set(body, 4);
  return sha256(msg);
}

/** The transaction's hash: what its signer signs, and its id on chain (base58). */
export const transactionHash = (t: Transaction): Promise<Uint8Array> => sha256(encodeTransaction(t));

export type Signer = (hash: Uint8Array) => Promise<Uint8Array> | Uint8Array;

export async function signDelegate(d: DelegateAction, sign: Signer): Promise<SignedDelegate> {
  return { delegate: d, signature: await sign(await delegateHash(d)) };
}

export async function signTransaction(t: Transaction, sign: Signer): Promise<{ bytes: Uint8Array; hash: string }> {
  const hash = await transactionHash(t);
  return { bytes: encodeSignedTransaction(t, await sign(hash)), hash: base58Encode(hash) };
}

/** Checks a delegate action's signature against the key it names (WebCrypto Ed25519). */
export async function verifyDelegate(s: SignedDelegate): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', s.delegate.publicKey, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, s.signature, await delegateHash(s.delegate));
  } catch {
    return false;
  }
}
