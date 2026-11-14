/**
 * NEAR sign-in: NEP-413 signed messages.
 *
 * A wallet's `signMessage({ message, recipient, nonce })` signs sha256(borsh(2^31 + 413) ‖ borsh(payload)), where the
 * payload is { message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }. A NEAR account id is
 * a name, not a key, so a valid signature is not enough: the key must also be a full-access key of that account, which
 * the RPC node answers (view_access_key).
 */
import { base58Decode } from '@nomad/db/util';
import type { EscrowTournament, TournamentEscrow } from '@nomad/db/tournaments';

/** NEP-413's tag, 2^31 + 413, written before the payload so a signed message can never be a valid transaction. */
const NEP413_TAG = 2 ** 31 + 413;

/** NEAR account ids: 2 to 64 characters, lower-case letters, digits and the separators `.`, `-` and `_`. */
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export const isAccountId = (s: string): boolean => ACCOUNT_ID.test(s);

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat([u32le(bytes.length), bytes]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The 32 bytes a wallet signs for this NEP-413 message (no callback URL). */
export async function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Promise<Uint8Array> {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  const payload = concat([u32le(NEP413_TAG), borshString(message), nonce, borshString(recipient), new Uint8Array([0])]);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
}

/** "ed25519:<base58>" to the 32 key bytes, or null. */
export function parseEd25519Key(publicKey: string): Uint8Array | null {
  if (!publicKey.startsWith('ed25519:')) return null;
  const raw = base58Decode(publicKey.slice('ed25519:'.length));
  return raw?.length === 32 ? raw : null;
}

export async function verifyNep413(publicKey: Uint8Array, signature: Uint8Array, message: string, nonce: Uint8Array, recipient: string): Promise<boolean> {
  if (signature.length !== 64) return false;
  const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, signature, await nep413Hash(message, nonce, recipient));
}

export type KeyCheck = 'full-access' | 'limited' | 'unknown';

/** Whether `publicKey` ("ed25519:…") is a key of `accountId` on chain, and with what permission. */
export async function accessKeyOf(rpcUrl: string, accountId: string, publicKey: string): Promise<KeyCheck> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'nomad-sign-in',
      method: 'query',
      params: { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey },
    }),
  });
  if (!res.ok) throw new Error(`NEAR RPC answered ${res.status}`);
  const body = (await res.json()) as { result?: { permission?: unknown; error?: string }; error?: unknown };
  // A missing key or account comes back as an error, either top-level or inside `result`.
  if (body.error || !body.result || body.result.error) return 'unknown';
  return body.result.permission === 'FullAccess' ? 'full-access' : 'limited';
}

/** A contract view (call_function) over NEAR JSON-RPC; throws if the node or the contract errs. */
export async function viewFunction<T>(rpcUrl: string, contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'nomad-view',
      method: 'query',
      params: { request_type: 'call_function', finality: 'optimistic', account_id: contractId, method_name: method, args_base64: base64Encode(new TextEncoder().encode(JSON.stringify(args))) },
    }),
  });
  if (!res.ok) throw new Error(`NEAR RPC answered ${res.status}`);
  const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
  if (body.error || !body.result?.result) throw new Error(`NEAR view ${method} failed: ${JSON.stringify(body.error ?? body.result?.error ?? 'no result').slice(0, 200)}`);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result))) as T;
}

/** The escrow's tournament views (near/escrow), for NEAR tournaments (packages/db/src/tournaments.ts). */
export function tournamentEscrow(rpcUrl: string, contractId: string): TournamentEscrow {
  return {
    getTournament: (id) => viewFunction<EscrowTournament | null>(rpcUrl, contractId, 'get_tournament', { tournament_id: id }),
    isRegistered: (id, account) => viewFunction<boolean>(rpcUrl, contractId, 'is_registered', { tournament_id: id, account }),
  };
}

export function base64Decode(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

export function base64Encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
