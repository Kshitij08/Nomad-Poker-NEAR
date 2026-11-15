/**
 * NEAR without a wallet: accounts the API makes for players, and a relayer for their moves.
 *
 * - Create my NEAR account (`POST /v1/near/account`): the browser makes an ed25519 key pair and sends the public half.
 *   The sponsor account (NEAR_SPONSOR_ID, key in the NEAR_SPONSOR_KEY secret) creates `<10 random a-z0-9>.<sponsor>`
 *   with that key as its only full-access key and sends it NEAR_NEW_ACCOUNT_YOCTO (default 0.1 NEAR: storage plus a
 *   starting amount for deposits and buy-ins). A sub-account needs no faucet; the sponsor pays. One per player, and at
 *   most NEAR_NEW_ACCOUNTS_PER_DAY a day across everyone. The player then signs in with that key through the ordinary
 *   NEP-413 challenge / verify, which links the account like a wallet's.
 * - Gasless moves (`POST /v1/near/relay`): the browser signs a NEP-366 delegate action; the API checks it only calls
 *   the app's contracts and methods with sane gas and no attached NEAR (a meta-transaction's deposits would be the sponsor's), was signed by the key it registered, is fresh and was
 *   never relayed before, then wraps it in a transaction the sponsor signs and pays gas for. Only app-made accounts are
 *   relayed (wallet players pay their own gas, as before). Deposits still come from the player's own account.
 */
import {
  base58Decode,
  base58Encode,
  decodeSignedDelegate,
  delegateHash,
  fromBase64,
  parsePublicKey,
  parseSecretKey,
  publicKeyText,
  signTransaction,
  TGAS,
  verifyDelegate,
  YOCTO_PER_NEAR,
  type NearAction,
  type SignedDelegate,
} from '@nomad/contract/near';
import { fail } from '@nomad/db/util';
import type { Env } from './env';

// ------------------------------------------------------------------ rules

/** What a new account gets unless NEAR_NEW_ACCOUNT_YOCTO says otherwise: 0.1 NEAR. Never more than 0.5 NEAR. */
export const DEFAULT_NEW_ACCOUNT_YOCTO = YOCTO_PER_NEAR / 10n;
export const MAX_NEW_ACCOUNT_YOCTO = YOCTO_PER_NEAR / 2n;
export const DEFAULT_NEW_ACCOUNTS_PER_DAY = 50;
export const MAX_ACTION_GAS = 100n * TGAS;
export const MAX_TOTAL_GAS = 250n * TGAS;
/** Relays per player: 30 in 10 minutes, 300 a day. */
export const RELAY_BURST = { count: 30, ms: 10 * 60_000 };
export const RELAY_DAILY = { count: 300, ms: 24 * 3_600_000 };
/** A delegate action must expire within this many blocks (about 10 minutes on testnet). */
export const MAX_BLOCKS_AHEAD = 600n;

/**
 * Methods the relayer pays gas for. Never with an attached deposit: in a NEP-366 meta-transaction the relayer pays the
 * delegate's deposits too (seen live: a relayed 0.06 NEAR deposit came out of the sponsor). Calls that attach NEAR
 * (deposit, buy_in topped up from the account, register, join_pool, back) go as ordinary transactions signed by the
 * browser key and paid from the player's account (apps/web/src/near/localKey.ts); with no deposit they may be relayed.
 */
const ESCROW_METHODS = new Set(['deposit', 'withdraw', 'buy_in', 'create_hosted_table', 'close_table', 'reclaim', 'register', 'leave', 'create_tournament', 'cancel_tournament']);
// A pro's own agent moves too (update_agent, the NEAR AI private strategy, the pool loss limit): no NEAR attached.
const TABLE_METHODS = new Set([
  'join_pool', 'leave_pool', 'claim_earnings', 'register_agent', 'back', 'withdraw', 'set_loss_limit',
  'update_agent', 'set_private_strategy', 'clear_private_strategy', 'set_pool_loss_limit',
]);

/** The contracts (and their methods) the relayer will call. */
export function relayAllowlist(env: Env): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  if (env.NEAR_ESCROW) m.set(env.NEAR_ESCROW, ESCROW_METHODS);
  if (env.NEAR_TABLE_CONTRACT) m.set(env.NEAR_TABLE_CONTRACT, TABLE_METHODS);
  return m;
}

export type Sponsor = { accountId: string; publicKey: Uint8Array; sign: (hash: Uint8Array) => Promise<Uint8Array> };

/** The sponsor from NEAR_SPONSOR_ID and the NEAR_SPONSOR_KEY secret ("ed25519:<base58 of 64 bytes>"), or null. */
export async function sponsorOf(env: Env): Promise<Sponsor | null> {
  if (!env.NEAR_RPC_URL || !env.NEAR_SPONSOR_ID || !env.NEAR_SPONSOR_KEY) return null;
  const sk = parseSecretKey(env.NEAR_SPONSOR_KEY.trim());
  if (!sk) throw new Error('NEAR_SPONSOR_KEY is not an ed25519 secret key');
  const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d: b64url(sk.seed), x: b64url(sk.publicKey) }, { name: 'Ed25519' }, false, ['sign']);
  return {
    accountId: env.NEAR_SPONSOR_ID,
    publicKey: sk.publicKey,
    sign: async (hash) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, hash)),
  };
}

export function newAccountYocto(env: Env): bigint {
  const raw = env.NEAR_NEW_ACCOUNT_YOCTO?.trim();
  const v = raw && /^\d+$/.test(raw) ? BigInt(raw) : DEFAULT_NEW_ACCOUNT_YOCTO;
  return v > MAX_NEW_ACCOUNT_YOCTO ? MAX_NEW_ACCOUNT_YOCTO : v;
}

/** A fresh sub-account name: 10 of a-z0-9 (the first a letter) under the sponsor. */
export function newAccountName(sponsor: string, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const abc = letters + '0123456789';
  const r = random(10);
  return `${letters[r[0]! % 26]}${[...r.slice(1)].map((b) => abc[b % abc.length]).join('')}.${sponsor}`;
}

/** Whether `account` is one the API made (a direct sub-account of the sponsor). */
export const isAppMadeAccount = (env: Env, account: string): boolean =>
  !!env.NEAR_SPONSOR_ID && account.endsWith(`.${env.NEAR_SPONSOR_ID}`) && !account.slice(0, -(env.NEAR_SPONSOR_ID.length + 1)).includes('.');

/**
 * Why the relayer refuses this delegate action (null: it may go). Checks the sender and key, the contract, every
 * action (function calls only, allowed methods, gas, deposits) and the expiry. The signature is checked separately.
 */
export function relayRuleBreak(env: Env, d: SignedDelegate['delegate'], own: { accountId: string; publicKey: string }, height: bigint): string | null {
  if (d.senderId !== own.accountId) return 'You can only send moves from the NEAR account made for you.';
  if (publicKeyText(d.publicKey) !== own.publicKey) return 'That key is not the one this account was made with.';
  const methods = relayAllowlist(env).get(d.receiverId);
  if (!methods) return `The relayer only calls the game's contracts, not ${d.receiverId}.`;
  if (d.actions.length === 0 || d.actions.length > 4) return 'Send one to four contract calls.';
  let gas = 0n;
  for (const a of d.actions) {
    if (a.type !== 'FunctionCall') return 'The relayer only sends contract calls.';
    if (!methods.has(a.methodName)) return `The relayer doesn't call ${a.methodName}.`;
    if (a.deposit !== 0n) return 'The relayer sends no NEAR: send calls that attach NEAR from your own account.';
    if (a.gas > MAX_ACTION_GAS) return 'Too much gas for one call.';
    gas += a.gas;
  }
  if (gas > MAX_TOTAL_GAS) return 'Too much gas.';
  if (d.maxBlockHeight <= height) return 'This move expired; try again.';
  if (d.maxBlockHeight > height + MAX_BLOCKS_AHEAD) return 'This move is valid for too long; sign it again.';
  return null;
}

// ------------------------------------------------------------------ NEAR RPC

type RpcError = { name?: string; cause?: { name?: string; info?: unknown }; message?: string; data?: unknown };

async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'nomad-relay', method, params }) });
  if (!res.ok) throw new NearRpcError(`NEAR RPC answered ${res.status}`, null);
  const body = (await res.json()) as { result?: T & { error?: string }; error?: RpcError };
  if (body.error) throw new NearRpcError(JSON.stringify(body.error.data ?? body.error.cause ?? body.error.message).slice(0, 400), body.error);
  if (body.result && typeof body.result === 'object' && 'error' in body.result && body.result.error) throw new NearRpcError(String(body.result.error).slice(0, 400), null);
  return body.result as T;
}

export class NearRpcError extends Error {
  constructor(
    message: string,
    readonly error: RpcError | null,
  ) {
    super(message);
  }
}

async function latestBlock(url: string): Promise<{ hash: Uint8Array; height: bigint }> {
  const b = await rpc<{ header: { hash: string; height: number } }>(url, 'block', { finality: 'final' });
  return { hash: base58Decode(b.header.hash)!, height: BigInt(b.header.height) };
}

async function keyNonce(url: string, account: string, publicKey: Uint8Array): Promise<bigint> {
  const k = await rpc<{ nonce: number | string }>(url, 'query', { request_type: 'view_access_key', finality: 'optimistic', account_id: account, public_key: publicKeyText(publicKey) });
  return BigInt(k.nonce);
}

type Status = { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };
type Outcome = { id: string; outcome: { executor_id: string; status: Status } };
type FinalOutcome = { final_execution_status?: string; status: Status; transaction: { hash: string }; transaction_outcome: Outcome; receipts_outcome: Outcome[] };

/** The first failure anywhere in the transaction (refund receipts never fail), as text; null when it all went through. */
export function failureOf(o: FinalOutcome): string | null {
  const f = [o.status, ...o.receipts_outcome.map((r) => r.outcome.status)].find((s) => s && 'Failure' in s && s.Failure);
  if (!f) return null;
  const text = JSON.stringify(f.Failure);
  // A contract panic carries the contract's own words: "Smart contract panicked: Not enough balance".
  const panic = /"ExecutionError":"([^"]+)"/.exec(text)?.[1];
  return (panic ?? text).slice(0, 300);
}

/** What `executor` returned (JSON when it parses), from the first non-empty SuccessValue it produced. */
function valueOf(o: FinalOutcome, executor: string): unknown {
  for (const r of o.receipts_outcome) {
    const v = r.outcome.executor_id === executor ? r.outcome.status?.SuccessValue : undefined;
    if (!v) continue;
    const text = new TextDecoder().decode(fromBase64(v) ?? new Uint8Array());
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return null;
}

/**
 * Signs `actions` to `receiverId` as the sponsor and waits for them to run. Reads the sponsor key's nonce each time and
 * retries a nonce clash (two requests at once) twice.
 */
export async function sponsorSend(url: string, sponsor: Sponsor, receiverId: string, actions: NearAction[], waitUntil: 'EXECUTED_OPTIMISTIC' | 'FINAL' = 'EXECUTED_OPTIMISTIC'): Promise<{ hash: string; outcome: FinalOutcome }> {
  for (let attempt = 0; ; attempt++) {
    const [block, nonce] = await Promise.all([latestBlock(url), keyNonce(url, sponsor.accountId, sponsor.publicKey)]);
    const signed = await signTransaction(
      { signerId: sponsor.accountId, publicKey: sponsor.publicKey, nonce: nonce + 1n + BigInt(attempt), receiverId, blockHash: block.hash, actions },
      sponsor.sign,
    );
    try {
      const outcome = await rpc<FinalOutcome>(url, 'send_tx', { signed_tx_base64: btoa(String.fromCharCode(...signed.bytes)), wait_until: waitUntil });
      return { hash: signed.hash, outcome };
    } catch (e) {
      if (attempt < 2 && e instanceof NearRpcError && /InvalidNonce/.test(e.message)) continue;
      throw e;
    }
  }
}

// ------------------------------------------------------------------ routes

type Db = D1Database;
const isUniqueViolation = (err: unknown) => /UNIQUE constraint failed|PRIMARY KEY/i.test(String((err as Error)?.message ?? err));

async function needSponsor(env: Env): Promise<Sponsor> {
  const s = await sponsorOf(env);
  if (!s) fail(501, 'not_configured', 'NEAR accounts made for you are not set up on this server yet. Connect a wallet instead.');
  return s;
}

/** Creates the player's NEAR account (POST /v1/near/account). */
export async function createPlayerAccount(env: Env, playerId: string, publicKeyIn: string, now = Date.now()): Promise<{ accountId: string; funded: string; txHash: string }> {
  const sponsor = await needSponsor(env);
  const key = parsePublicKey(publicKeyIn);
  if (!key) fail(400, 'bad_request', 'publicKey must be "ed25519:<base58>".');
  const db: Db = env.DB;
  const existing = await db
    .prepare('SELECT account_id, public_key, funded, tx_hash FROM near_accounts WHERE player_id = ?1')
    .bind(playerId)
    .first<{ account_id: string; public_key: string; funded: string; tx_hash: string | null }>();
  // The same browser asking again (its first answer got lost): the same account.
  if (existing?.tx_hash && existing.public_key === publicKeyText(key)) return { accountId: existing.account_id, funded: existing.funded, txHash: existing.tx_hash };
  if (existing) fail(409, 'conflict', `You already have a NEAR account: ${existing.account_id}.`);
  const linked = await db.prepare("SELECT subject FROM identities WHERE player_id = ?1 AND provider = 'near'").bind(playerId).first<{ subject: string }>();
  if (linked) fail(409, 'conflict', `You already play as ${linked.subject}.`);
  const perDay = Number(env.NEAR_NEW_ACCOUNTS_PER_DAY) || DEFAULT_NEW_ACCOUNTS_PER_DAY;
  const today = await db.prepare('SELECT COUNT(*) AS n FROM near_accounts WHERE created_at > ?1').bind(now - 24 * 3_600_000).first<{ n: number }>();
  if ((today?.n ?? 0) >= perDay) fail(429, 'rate_limited', 'Enough NEAR accounts were made today. Try tomorrow, or connect a wallet.');

  const funded = newAccountYocto(env);
  const accountId = newAccountName(sponsor.accountId);
  // Reserve first: the UNIQUE player_id stops a second request from making a second account.
  try {
    await db.prepare('INSERT INTO near_accounts (account_id, player_id, public_key, funded, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(accountId, playerId, publicKeyText(key), funded.toString(), now)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'conflict', 'Your NEAR account is already being made.');
    throw e;
  }
  const undo = () => db.prepare('DELETE FROM near_accounts WHERE account_id = ?1').bind(accountId).run();
  let sent: Awaited<ReturnType<typeof sponsorSend>>;
  try {
    sent = await sponsorSend(env.NEAR_RPC_URL!, sponsor, accountId, [
      { type: 'CreateAccount' },
      { type: 'Transfer', deposit: funded },
      { type: 'AddKey', publicKey: key, fullAccess: true },
      // FINAL: sign-in checks the key at final finality right after this answer.
    ], 'FINAL');
  } catch (e) {
    console.warn('[near account] send', e);
    await undo();
    fail(502, 'relay_failed', "Couldn't reach NEAR to make your account. Try again in a moment.");
  }
  const failure = failureOf(sent.outcome);
  if (failure) {
    console.warn('[near account] failed', failure);
    await undo();
    fail(502, 'relay_failed', "NEAR didn't make the account. Try again in a moment.");
  }
  await db.prepare('UPDATE near_accounts SET tx_hash = ?2 WHERE account_id = ?1').bind(accountId, sent.hash).run();
  return { accountId, funded: funded.toString(), txHash: sent.hash };
}

/** Relays one signed delegate action for the player (POST /v1/near/relay). */
export async function relay(env: Env, playerId: string, signedDelegateB64: string, now = Date.now()): Promise<{ txHash: string; value: unknown }> {
  const sponsor = await needSponsor(env);
  const db: Db = env.DB;
  const own = await db.prepare('SELECT account_id, public_key FROM near_accounts WHERE player_id = ?1 AND tx_hash IS NOT NULL').bind(playerId).first<{ account_id: string; public_key: string }>();
  if (!own) fail(403, 'forbidden', 'Gasless moves are for NEAR accounts made here. Your wallet sends its own.');

  const bytes = fromBase64(signedDelegateB64);
  let signed: SignedDelegate;
  try {
    if (!bytes || bytes.length > 8192) throw new Error('size');
    signed = decodeSignedDelegate(bytes);
  } catch {
    fail(400, 'bad_request', 'signedDelegate is not a borsh SignedDelegateAction (base64).');
  }

  // Rate limits before any RPC call.
  const recent = await db
    .prepare('SELECT SUM(created_at > ?2) AS burst, COUNT(*) AS day FROM near_relays WHERE player_id = ?1 AND created_at > ?3')
    .bind(playerId, now - RELAY_BURST.ms, now - RELAY_DAILY.ms)
    .first<{ burst: number | null; day: number }>();
  if ((recent?.burst ?? 0) >= RELAY_BURST.count || (recent?.day ?? 0) >= RELAY_DAILY.count) fail(429, 'rate_limited', 'Too many moves at once; wait a few minutes.');

  let height: bigint;
  try {
    height = (await latestBlock(env.NEAR_RPC_URL!)).height;
  } catch (e) {
    console.warn('[near relay] block', e);
    fail(503, 'internal', "Couldn't reach NEAR. Try again in a moment.");
  }
  const why = relayRuleBreak(env, signed.delegate, { accountId: own.account_id, publicKey: own.public_key }, height);
  if (why) fail(400, 'relay_refused', why);
  if (!(await verifyDelegate(signed))) fail(400, 'relay_refused', 'The signature does not match the move.');

  // Each signed move is relayed once (the chain's nonce would refuse a replay too, but after the sponsor paid).
  const hash = base58Encode(await delegateHash(signed.delegate));
  const calls = signed.delegate.actions.filter((a) => a.type === 'FunctionCall');
  try {
    await db
      .prepare("INSERT INTO near_relays (hash, player_id, account_id, receiver_id, methods, deposit, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)")
      .bind(hash, playerId, own.account_id, signed.delegate.receiverId, calls.map((a) => a.methodName).join(','), calls.reduce((n, a) => n + a.deposit, 0n).toString(), now)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'relay_refused', 'This move was already sent.');
    throw e;
  }
  const done = (status: 'ok' | 'failed', txHash: string | null, error: string | null) =>
    db.prepare('UPDATE near_relays SET status = ?2, tx_hash = ?3, error = ?4 WHERE hash = ?1').bind(hash, status, txHash, error).run();

  let sent: Awaited<ReturnType<typeof sponsorSend>>;
  try {
    sent = await sponsorSend(env.NEAR_RPC_URL!, sponsor, own.account_id, [{ type: 'Delegate', signed }]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.warn('[near relay] send', msg);
    await done('failed', null, msg.slice(0, 300));
    if (/DelegateActionInvalidNonce|InvalidNonce/.test(msg)) fail(409, 'relay_refused', 'This move was already used; try again.');
    if (/DelegateActionExpired|Expired/.test(msg)) fail(400, 'relay_refused', 'This move expired; try again.');
    fail(502, 'relay_failed', "Couldn't reach NEAR to send your move. Try again in a moment.");
  }
  const failure = failureOf(sent.outcome);
  await done(failure ? 'failed' : 'ok', sent.hash, failure);
  if (failure) fail(400, 'relay_failed', failure);
  return { txHash: sent.hash, value: valueOf(sent.outcome, signed.delegate.receiverId) };
}
