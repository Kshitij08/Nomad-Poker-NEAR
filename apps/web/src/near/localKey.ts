/**
 * A NEAR account made for you: its key lives in this browser (localStorage, this origin only), so On-chain works
 * without a wallet. The API creates `<id>.nomad-players.testnet` with this key as its only full-access key; sign-in is
 * the ordinary NEP-413 challenge / verify, signed here; contract calls are NEP-366 delegate actions the API's relayer
 * sends and pays gas for (deposits still come from the account's own NEAR). The key can be backed up as a near-cli
 * style JSON file and restored on another device (or imported into a wallet).
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { Routes, type NearAccountResponse, type NearRelayResponse } from '@nomad/contract';
import {
  encodeSignedDelegate,
  functionCall,
  parseSecretKey,
  publicKeyText,
  secretKeyText,
  signDelegate,
  TGAS,
  toBase64,
} from '@nomad/contract/near';
import { NEAR_RPC } from './rpc';
import type { NearSigner } from './wallet';

export const NEAR_NETWORK_ID = 'testnet';
const STORE = `nomad.nearKey:${NEAR_NETWORK_ID}`;
/** A delegate action is valid for this many blocks (about 5 minutes). */
const VALID_BLOCKS = 300n;

/** The stored key: `accountId` is null until the API made the account (a key made but not yet used). */
export type LocalKey = { accountId: string | null; publicKey: string; secretKey: string };

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const store = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadLocalKey(s: Storage | null = store()): LocalKey | null {
  try {
    const v = JSON.parse(s?.getItem(STORE) ?? 'null') as LocalKey | null;
    return v && typeof v.secretKey === 'string' && parseSecretKey(v.secretKey) ? v : null;
  } catch {
    return null;
  }
}

function save(k: LocalKey, s: Storage | null = store()): void {
  if (!s) throw new Error("This browser can't keep your NEAR key (private mode?). Connect a wallet instead.");
  s.setItem(STORE, JSON.stringify(k));
}

/** The key for a new account: the one made earlier and not used yet, else a fresh one (saved before it's sent). */
export function pendingKey(s: Storage | null = store(), random: () => Uint8Array = () => ed25519.utils.randomSecretKey()): LocalKey {
  const have = loadLocalKey(s);
  if (have && !have.accountId) return have;
  const seed = random();
  const pub = ed25519.getPublicKey(seed);
  const k: LocalKey = { accountId: null, publicKey: publicKeyText(pub), secretKey: secretKeyText(seed, pub) };
  save(k, s);
  return k;
}

export function setLocalAccount(accountId: string, s: Storage | null = store()): LocalKey {
  const k = loadLocalKey(s);
  if (!k) throw new Error('No NEAR key in this browser.');
  const next = { ...k, accountId };
  save(next, s);
  return next;
}

export function forgetLocalKey(s: Storage | null = store()): void {
  s?.removeItem(STORE);
}

/** Signs a 32-byte hash with the stored key. */
function signer(k: LocalKey): (hash: Uint8Array) => Uint8Array {
  const sk = parseSecretKey(k.secretKey)!;
  return (hash) => ed25519.sign(hash, sk.seed);
}

// ------------------------------------------------------------------ sign-in (NEP-413)

const NEP413_TAG = 2 ** 31 + 413;

/** sha256(u32le(2^31 + 413) ‖ borsh { message, nonce: [u8; 32], recipient, callback_url: None }). */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const enc = new TextEncoder();
  const m = enc.encode(message);
  const r = enc.encode(recipient);
  const out = new Uint8Array(4 + 4 + m.length + 32 + 4 + r.length + 1);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, NEP413_TAG, true);
  dv.setUint32((o += 4), m.length, true);
  out.set(m, (o += 4));
  out.set(nonce, (o += m.length));
  dv.setUint32((o += 32), r.length, true);
  out.set(r, (o += 4));
  out[o + r.length] = 0;
  return sha256(out);
}

/** A NearSigner for the stored account: what `NomadSession.near` signs in with, like a wallet's. */
export function localSigner(k: LocalKey): NearSigner {
  const sign = signer(k);
  return {
    connect: async () => k.accountId,
    signMessage: async ({ message, recipient, nonce }) => {
      if (!k.accountId) throw new Error('This key has no NEAR account yet.');
      return { accountId: k.accountId, publicKey: k.publicKey, signature: toBase64(sign(nep413Hash(message, nonce, recipient))) };
    },
  };
}

// ------------------------------------------------------------------ the relayer (NEP-366)

type Rpc = <T>(method: string, params: unknown) => Promise<T>;
const rpc: Rpc = async <T>(method: string, params: unknown) => {
  const res = await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'nomad', method, params }) });
  const j = (await res.json()) as { result?: T; error?: { data?: unknown; message?: string } };
  if (j.error || j.result === undefined) throw new Error(typeof j.error?.data === 'string' ? j.error.data : (j.error?.message ?? `NEAR RPC error (${res.status})`));
  return j.result;
};

let lastNonce = 0n;

/**
 * Signs a call as a delegate action (the key's next nonce, valid ~5 minutes) and hands it to `send` (the API relayer).
 * `deposit` in yoctoNEAR comes from the account; gas is the sponsor's.
 */
export async function relayCall(
  k: LocalKey,
  send: (signedDelegate: string) => Promise<NearRelayResponse>,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  deposit = 0n,
  tgas = 50n,
  rpcImpl: Rpc = rpc,
): Promise<NearRelayResponse> {
  if (!k.accountId) throw new Error('This key has no NEAR account yet.');
  const sk = parseSecretKey(k.secretKey)!;
  const [key, block] = await Promise.all([
    rpcImpl<{ nonce: number | string }>('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: k.accountId, public_key: k.publicKey }),
    rpcImpl<{ header: { height: number } }>('block', { finality: 'final' }),
  ]);
  const chainNonce = BigInt(key.nonce);
  lastNonce = (chainNonce > lastNonce ? chainNonce : lastNonce) + 1n;
  const signed = await signDelegate(
    {
      senderId: k.accountId,
      receiverId: contractId,
      actions: [functionCall(methodName, args, tgas * TGAS, deposit)],
      nonce: lastNonce,
      maxBlockHeight: BigInt(block.header.height) + VALID_BLOCKS,
      publicKey: sk.publicKey,
    },
    signer(k),
  );
  return send(toBase64(encodeSignedDelegate(signed)));
}

// ------------------------------------------------------------------ backup

/** The backup file: near-cli's credentials format, so it also imports into wallets and the CLI. */
export function backupJson(k: LocalKey): string {
  return JSON.stringify({ account_id: k.accountId, public_key: k.publicKey, private_key: k.secretKey }, null, 2);
}

/** Reads a backup (the JSON above) and stores it as this browser's key. Throws with a player-facing reason. */
export function restoreBackup(text: string, s: Storage | null = store()): LocalKey {
  let v: { account_id?: unknown; private_key?: unknown; secret_key?: unknown };
  try {
    v = JSON.parse(text.trim()) as typeof v;
  } catch {
    throw new Error('Paste the whole backup (it starts with {).');
  }
  const accountId = typeof v.account_id === 'string' ? v.account_id.trim().toLowerCase() : '';
  const secret = typeof v.private_key === 'string' ? v.private_key : typeof v.secret_key === 'string' ? v.secret_key : '';
  const sk = parseSecretKey(secret.trim());
  if (!accountId || !sk) throw new Error("That isn't a NEAR key backup.");
  if (publicKeyText(ed25519.getPublicKey(sk.seed)) !== publicKeyText(sk.publicKey)) throw new Error('That key backup is damaged.');
  const k: LocalKey = { accountId, publicKey: publicKeyText(sk.publicKey), secretKey: secret.trim() };
  save(k, s);
  return k;
}

// ------------------------------------------------------------------ with the Nomad API

/** What these flows need from the Nomad session (account/session.ts). */
export type SessionLike = {
  signedIn: boolean;
  error: string | null;
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
  near(signer: NearSigner): Promise<void>;
};

/**
 * Create my NEAR account: a key for this browser, the account from the API (the sponsor pays storage and a starting
 * amount), then NEAR sign-in with that key, which links the account to the player you're signed in as.
 */
export async function createNearAccount(session: SessionLike): Promise<LocalKey> {
  const k = pendingKey();
  const made = await session.call<NearAccountResponse>('POST', Routes.nearAccount, { publicKey: k.publicKey });
  const ready = setLocalAccount(made.accountId);
  await signInWithLocalKey(session, ready);
  return ready;
}

export async function signInWithLocalKey(session: SessionLike, k: LocalKey): Promise<void> {
  await session.near(localSigner(k));
  if (!session.signedIn || session.error) throw new Error(session.error ?? 'NEAR sign-in failed.');
}

/** Sends a call through the relayer for the stored account. */
export const relayVia = (session: Pick<SessionLike, 'call'>) => (signedDelegate: string) =>
  session.call<NearRelayResponse>('POST', Routes.nearRelay, { signedDelegate });
