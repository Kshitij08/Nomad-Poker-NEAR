/**
 * NEAR accounts made for players and the gasless relayer (src/nearAccounts.ts) against a fake NEAR RPC that decodes
 * and checks the sponsor's transactions and the players' delegate actions like the chain would (signatures, nonces,
 * existing accounts, contract panics).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Routes, type ApiErrorBody, type MeResponse, type NearAccountResponse, type NearChallengeResponse, type NearRelayResponse, type SessionResponse } from '@nomad/contract';
import {
  base58Encode,
  decodeSignedTransaction,
  delegateHash,
  encodeSignedDelegate,
  functionCall,
  publicKeyText,
  secretKeyText,
  signDelegate,
  toBase64,
  TGAS,
  transactionHash,
  verifyDelegate,
  YOCTO_PER_NEAR,
  type DelegateAction,
} from '@nomad/contract/near';
import { createApp } from '../app';
import type { Env } from '../env';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { base64Decode, base64Encode, nep413Hash } from '../near';

const ORIGIN = 'http://localhost:5180';
const RPC = 'https://rpc.test.near';
const SPONSOR = 'nomad-players.testnet';
const ESCROW = 'nomad-escrow.testnet';
const TABLE = 'table.nomad-poker.testnet';
const app = createApp();
let env: Env;

// ------------------------------------------------------------------ keys

type Keys = { seed: Uint8Array; publicKey: Uint8Array; sign: (h: Uint8Array) => Promise<Uint8Array> };

async function newKeys(): Promise<Keys> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const b = (s: string) => Uint8Array.from(Buffer.from(s, 'base64url'));
  return { seed: b(jwk.d!), publicKey: b(jwk.x!), sign: async (h) => new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, h)) };
}

// ------------------------------------------------------------------ fake chain

type Account = { balance: bigint; keys: Map<string, { nonce: bigint; full: boolean }> };
let chain: Map<string, Account>;
let height: bigint;
/** Function calls that ran: who, which contract, method, deposit. */
let calls: { sender: string; receiver: string; method: string; deposit: bigint; args: unknown }[];
/** Methods the fake contracts panic on. */
const PANICS: Record<string, string> = { buy_in: 'Smart contract panicked: The table is full' };
let sendTxCount = 0;
let failNextNonce = false;

const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result }), { status: 200 });
const err = (error: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', error }), { status: 200 });
const BLOCK_HASH = new Uint8Array(32).fill(7);

async function sendTx(b64: string): Promise<Response> {
  sendTxCount++;
  const { transaction: t, signature } = decodeSignedTransaction(Uint8Array.from(Buffer.from(b64, 'base64')));
  const signer = chain.get(t.signerId);
  const key = signer?.keys.get(publicKeyText(t.publicKey));
  if (!signer || !key) return err({ name: 'HANDLER_ERROR', data: { TxExecutionError: { InvalidTxError: 'InvalidAccessKeyError' } } });
  const pub = await crypto.subtle.importKey('raw', t.publicKey, { name: 'Ed25519' }, false, ['verify']);
  if (!(await crypto.subtle.verify('Ed25519', pub, signature, await transactionHash(t)))) return err({ data: { TxExecutionError: { InvalidTxError: 'InvalidSignature' } } });
  if (failNextNonce || t.nonce <= key.nonce) {
    failNextNonce = false;
    return err({ name: 'HANDLER_ERROR', data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: Number(t.nonce), ak_nonce: Number(key.nonce) } } } } });
  }
  key.nonce = t.nonce;
  const hash = base58Encode(await transactionHash(t));
  const receipts: { id: string; outcome: { executor_id: string; status: unknown } }[] = [];
  const fail = (e: unknown) => receipts.push({ id: 'r', outcome: { executor_id: t.receiverId, status: { Failure: e } } });
  for (const a of t.actions) {
    if (a.type === 'CreateAccount') {
      if (chain.has(t.receiverId)) { fail({ ActionError: { kind: { AccountAlreadyExists: { account_id: t.receiverId } } } }); break; }
      chain.set(t.receiverId, { balance: 0n, keys: new Map() });
    } else if (a.type === 'Transfer') {
      signer.balance -= a.deposit;
      chain.get(t.receiverId)!.balance += a.deposit;
    } else if (a.type === 'AddKey') {
      chain.get(t.receiverId)!.keys.set(publicKeyText(a.publicKey), { nonce: height * 1_000_000n, full: true });
    } else if (a.type === 'Delegate') {
      const d = a.signed.delegate;
      const sender = chain.get(d.senderId);
      const dk = sender?.keys.get(publicKeyText(d.publicKey));
      if (d.senderId !== t.receiverId || !dk || !(await verifyDelegate(a.signed))) { fail({ ActionError: { kind: 'DelegateActionInvalidSignature' } }); break; }
      if (d.nonce <= dk.nonce) { fail({ ActionError: { kind: { DelegateActionInvalidNonce: {} } } }); break; }
      if (d.maxBlockHeight < height) { fail({ ActionError: { kind: 'DelegateActionExpired' } }); break; }
      dk.nonce = d.nonce;
      receipts.push({ id: 'd', outcome: { executor_id: d.senderId, status: { SuccessReceiptId: 'c' } } });
      for (const c of d.actions) {
        if (c.type !== 'FunctionCall') continue;
        if (sender!.balance < c.deposit) { fail({ ActionError: { kind: { LackBalanceForState: {} } } }); continue; }
        const panic = PANICS[c.methodName];
        if (panic) { receipts.push({ id: 'c', outcome: { executor_id: d.receiverId, status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: panic } } } } } } }); continue; }
        sender!.balance -= c.deposit;
        calls.push({ sender: d.senderId, receiver: d.receiverId, method: c.methodName, deposit: c.deposit, args: JSON.parse(new TextDecoder().decode(c.args)) });
        receipts.push({ id: 'c', outcome: { executor_id: d.receiverId, status: { SuccessValue: Buffer.from(JSON.stringify(String(c.deposit))).toString('base64') } } });
      }
    }
  }
  height += 2n;
  return ok({ final_execution_status: 'EXECUTED_OPTIMISTIC', status: { SuccessValue: '' }, transaction: { hash }, transaction_outcome: { id: hash, outcome: { executor_id: t.signerId, status: { SuccessReceiptId: 'r' } } }, receipts_outcome: receipts });
}

async function fakeRpc(url: string, init: RequestInit): Promise<Response> {
  if (url !== RPC) throw new Error(`unexpected fetch ${url}`);
  const { method, params } = JSON.parse(String(init.body));
  if (method === 'block') return ok({ header: { hash: base58Encode(BLOCK_HASH), height: Number(height) } });
  if (method === 'send_tx') return sendTx(params.signed_tx_base64);
  if (method === 'query' && params.request_type === 'view_access_key') {
    const k = chain.get(params.account_id)?.keys.get(params.public_key);
    return k ? ok({ nonce: Number(k.nonce), permission: k.full ? 'FullAccess' : { FunctionCall: {} } }) : err({ name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY' } });
  }
  throw new Error(`unexpected RPC ${method} ${params?.request_type ?? ''}`);
}

// ------------------------------------------------------------------ setup

let sponsorKeys: Keys;

beforeEach(async () => {
  sponsorKeys = await newKeys();
  height = 1000n;
  calls = [];
  sendTxCount = 0;
  failNextNonce = false;
  chain = new Map([[SPONSOR, { balance: 10n * YOCTO_PER_NEAR, keys: new Map([[publicKeyText(sponsorKeys.publicKey), { nonce: 5n, full: true }]]) }]]);
  env = {
    DB: await D1Shim.migrated(),
    HANDS: {} as R2Bucket,
    STAGE: 'test',
    ALLOWED_ORIGINS: ORIGIN,
    SPIN_SECRET: 'test-secret',
    NEAR_RPC_URL: RPC,
    NEAR_ESCROW: ESCROW,
    NEAR_TABLE_CONTRACT: TABLE,
    NEAR_SPONSOR_ID: SPONSOR,
    NEAR_SPONSOR_KEY: secretKeyText(sponsorKeys.seed, sponsorKeys.publicKey),
  };
  vi.stubGlobal('fetch', fakeRpc);
});

afterEach(() => vi.unstubAllGlobals());

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const guest = async (name = 'Ace') => (await call<SessionResponse>('POST', Routes.guest, { displayName: name })).body.token;

/** A guest with a NEAR account made for it and signed in with it (NEP-413 through the ordinary verify). */
async function playerWithAccount() {
  let token = await guest();
  const keys = await newKeys();
  const made = await call<NearAccountResponse>('POST', Routes.nearAccount, { publicKey: publicKeyText(keys.publicKey) }, token);
  expect(made.status).toBe(201);
  const accountId = made.body.accountId;
  const ch = (await call<NearChallengeResponse>('POST', Routes.nearChallenge, { accountId }, token)).body;
  const signature = base64Encode(await keys.sign(await nep413Hash(ch.message, base64Decode(ch.nonce)!, ch.recipient)));
  const v = await call<SessionResponse>('POST', Routes.nearVerify, { accountId, publicKey: publicKeyText(keys.publicKey), signature, nonce: ch.nonce }, token);
  expect(v.status).toBe(200);
  token = v.body.token;
  return { token, keys, accountId };
}

let nonceSeq = 0n;
/** A delegate action from `p` (by default: deposit 0.05 NEAR to the escrow), signed with its key, base64. */
async function delegate(p: { keys: Keys; accountId: string }, over: Partial<DelegateAction> = {}, signWith?: Keys): Promise<string> {
  const d: DelegateAction = {
    senderId: p.accountId,
    receiverId: ESCROW,
    actions: [functionCall('deposit', {}, 30n * TGAS, YOCTO_PER_NEAR / 20n)],
    nonce: height * 1_000_000n + ++nonceSeq,
    maxBlockHeight: height + 100n,
    publicKey: p.keys.publicKey,
    ...over,
  };
  return toBase64(encodeSignedDelegate(await signDelegate(d, (signWith ?? p.keys).sign)));
}

const relay = (token: string, signedDelegate: string) => call<NearRelayResponse & ApiErrorBody>('POST', Routes.nearRelay, { signedDelegate }, token);

// ------------------------------------------------------------------ tests

describe('Create my NEAR account', () => {
  it('makes <id>.<sponsor> with the browser key and 0.1 NEAR, then links it through the ordinary NEP-413 sign-in', async () => {
    const { token, keys, accountId } = await playerWithAccount();
    expect(accountId).toMatch(/^[a-z][a-z0-9]{9}\.nomad-players\.testnet$/);
    const acc = chain.get(accountId)!;
    expect(acc.balance).toBe(YOCTO_PER_NEAR / 10n);
    expect([...acc.keys.keys()]).toEqual([publicKeyText(keys.publicKey)]);
    expect(acc.keys.get(publicKeyText(keys.publicKey))!.full).toBe(true);
    const me = (await call<MeResponse>('GET', Routes.me, undefined, token)).body;
    expect(me.identities).toContainEqual(expect.objectContaining({ provider: 'near', label: accountId }));
    // The guest keeps its own name (the account id is no name to play under).
    expect(me.player.displayName).toBe('Ace');
  });

  it('makes one account per player, and none for a player already on NEAR', async () => {
    const { token, keys, accountId } = await playerWithAccount();
    const k = await newKeys();
    const again = await call<ApiErrorBody>('POST', Routes.nearAccount, { publicKey: publicKeyText(k.publicKey) }, token);
    expect(again.status).toBe(409);
    // The same key again (a retry after a lost answer) gets the same account, made once.
    const retry = await call<NearAccountResponse>('POST', Routes.nearAccount, { publicKey: publicKeyText(keys.publicKey) }, token);
    expect(retry.body.accountId).toBe(accountId);
    expect(sendTxCount).toBe(1);
  });

  it('needs a signed-in player, a valid key and a configured sponsor', async () => {
    const k = publicKeyText((await newKeys()).publicKey);
    expect((await call('POST', Routes.nearAccount, { publicKey: k })).status).toBe(401);
    const token = await guest();
    expect((await call('POST', Routes.nearAccount, { publicKey: 'ed25519:nope' }, token)).status).toBe(400);
    env.NEAR_SPONSOR_KEY = undefined;
    expect((await call<ApiErrorBody>('POST', Routes.nearAccount, { publicKey: k }, token)).body.error.code).toBe('not_configured');
  });

  it('caps the starting amount at 0.5 NEAR and the accounts made per day', async () => {
    env.NEAR_NEW_ACCOUNT_YOCTO = (5n * YOCTO_PER_NEAR).toString();
    env.NEAR_NEW_ACCOUNTS_PER_DAY = '1';
    const a = await call<NearAccountResponse>('POST', Routes.nearAccount, { publicKey: publicKeyText((await newKeys()).publicKey) }, await guest());
    expect(a.body.funded).toBe((YOCTO_PER_NEAR / 2n).toString());
    const b = await call<ApiErrorBody>('POST', Routes.nearAccount, { publicKey: publicKeyText((await newKeys()).publicKey) }, await guest('Bo'));
    expect(b.status).toBe(429);
  });

  it('frees the reservation when NEAR refuses, so the player can try again', async () => {
    const token = await guest();
    const k = publicKeyText((await newKeys()).publicKey);
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body));
      return method === 'send_tx' ? new Response('down', { status: 502 }) : fakeRpc(url, init);
    });
    expect((await call('POST', Routes.nearAccount, { publicKey: k }, token)).status).toBe(502);
    vi.stubGlobal('fetch', fakeRpc);
    expect((await call('POST', Routes.nearAccount, { publicKey: k }, token)).status).toBe(201);
  });

  it('retries a sponsor nonce clash', async () => {
    failNextNonce = true;
    expect((await call('POST', Routes.nearAccount, { publicKey: publicKeyText((await newKeys()).publicKey) }, await guest())).status).toBe(201);
    expect(sendTxCount).toBe(2);
  });
});

describe('the relayer', () => {
  it('sends a deposit paid by the sponsor: the player keeps their NEAR minus the deposit only', async () => {
    const p = await playerWithAccount();
    const sponsorBefore = chain.get(SPONSOR)!.balance;
    const r = await relay(p.token, await delegate(p));
    expect(r.status).toBe(200);
    expect(r.body.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(r.body.value).toBe((YOCTO_PER_NEAR / 20n).toString());
    expect(calls).toEqual([{ sender: p.accountId, receiver: ESCROW, method: 'deposit', deposit: YOCTO_PER_NEAR / 20n, args: {} }]);
    expect(chain.get(p.accountId)!.balance).toBe(YOCTO_PER_NEAR / 10n - YOCTO_PER_NEAR / 20n);
    expect(chain.get(SPONSOR)!.balance).toBe(sponsorBefore);
  });

  it('calls the table contract too (join_pool, claim_earnings)', async () => {
    const p = await playerWithAccount();
    expect((await relay(p.token, await delegate(p, { receiverId: TABLE, actions: [functionCall('join_pool', { agent_id: 'nomad-a' }, 30n * TGAS, 10n ** 22n)] }))).status).toBe(200);
    expect((await relay(p.token, await delegate(p, { receiverId: TABLE, actions: [functionCall('claim_earnings', {}, 30n * TGAS, 0n)] }))).status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(['join_pool', 'claim_earnings']);
  });

  it('refuses a replay of the same signed move before paying for it', async () => {
    const p = await playerWithAccount();
    const sd = await delegate(p);
    expect((await relay(p.token, sd)).status).toBe(200);
    const sent = sendTxCount;
    const again = await relay(p.token, sd);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('relay_refused');
    expect(sendTxCount).toBe(sent);
  });

  it.each([
    ['another contract', { receiverId: 'wrap.testnet' }, /only calls the game's contracts/],
    ['a method not on the list', { actions: [functionCall('cash_out', { table_id: 't', player: 'x', amount: '1', key: 'k' }, 30n * TGAS, 0n)] }, /doesn't call cash_out/],
    ['an owner method', { actions: [functionCall('set_operator', { operator: 'me.testnet' }, 30n * TGAS, 0n)] }, /doesn't call set_operator/],
    ['a prototype key as a method', { actions: [functionCall('constructor', {}, 30n * TGAS, 0n)] }, /doesn't call constructor/],
    ['a deposit on a method that takes none', { actions: [functionCall('withdraw', { amount: '1' }, 30n * TGAS, 1n)] }, /takes no deposit/],
    ['a deposit over 1 NEAR', { actions: [functionCall('deposit', {}, 30n * TGAS, YOCTO_PER_NEAR + 1n)] }, /at most 1 NEAR/],
    ['deposits adding up to over 1 NEAR', { actions: [functionCall('deposit', {}, 30n * TGAS, YOCTO_PER_NEAR), functionCall('deposit', {}, 30n * TGAS, 1n)] }, /at most 1 NEAR/],
    ['too much gas', { actions: [functionCall('deposit', {}, 101n * TGAS, 1n)] }, /Too much gas/],
    ['a transfer', { actions: [{ type: 'Transfer' as const, deposit: 1n }] }, /only sends contract calls/],
    ['adding a key', { actions: [{ type: 'AddKey' as const, publicKey: new Uint8Array(32), fullAccess: true as const }] }, /only sends contract calls/],
    ['no actions', { actions: [] }, /one to four/],
    ['an expired move', { maxBlockHeight: 999n }, /expired/],
    ['a move valid for hours', { maxBlockHeight: 100_000n }, /too long/],
    ['someone else as the sender', { senderId: 'alice.testnet' }, /made for you/],
  ])('refuses %s', async (_what, over, why) => {
    const p = await playerWithAccount();
    const r = await relay(p.token, await delegate(p, over as Partial<DelegateAction>));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('relay_refused');
    expect(r.body.error.message).toMatch(why);
    expect(calls).toEqual([]);
  });

  it('refuses a move signed by another key, or naming another key', async () => {
    const p = await playerWithAccount();
    const other = await newKeys();
    expect((await relay(p.token, await delegate(p, {}, other))).body.error.message).toMatch(/signature does not match/);
    expect((await relay(p.token, await delegate(p, { publicKey: other.publicKey }, other))).body.error.message).toMatch(/not the one this account was made with/);
  });

  it('relays only for app-made accounts, and only the caller’s own', async () => {
    const p = await playerWithAccount();
    const sd = await delegate(p);
    // A guest with no app-made account (a wallet player pays their own gas).
    expect((await relay(await guest('Cy'), sd)).status).toBe(403);
    // Another player with an app-made account can't send p's move.
    const q = await playerWithAccount();
    expect((await relay(q.token, sd)).body.error.message).toMatch(/made for you/);
  });

  it('refuses garbage', async () => {
    const p = await playerWithAccount();
    expect((await relay(p.token, 'bm90IGJvcnNo')).status).toBe(400);
    expect((await relay(p.token, '%%%')).status).toBe(400);
  });

  it('rate-limits moves per player', async () => {
    const p = await playerWithAccount();
    const now = Date.now();
    const stmts = Array.from({ length: 30 }, (_, i) =>
      env.DB.prepare("INSERT INTO near_relays (hash, player_id, account_id, receiver_id, methods, deposit, status, created_at) SELECT ?1, player_id, account_id, ?2, 'deposit', '0', 'ok', ?3 FROM near_accounts WHERE account_id = ?4").bind(`h${i}`, ESCROW, now - 1000, p.accountId),
    );
    await env.DB.batch(stmts);
    const r = await relay(p.token, await delegate(p));
    expect(r.status).toBe(429);
    expect(calls).toEqual([]);
  });

  it("passes a contract panic back in the contract's words", async () => {
    const p = await playerWithAccount();
    const r = await relay(p.token, await delegate(p, { actions: [functionCall('buy_in', { table_id: 'poker-money-st50', amount: '1' }, 30n * TGAS, 0n)] }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('relay_failed');
    expect(r.body.error.message).toBe('Smart contract panicked: The table is full');
    const row = await env.DB.prepare('SELECT status, error FROM near_relays').first<{ status: string; error: string }>();
    expect(row).toEqual({ status: 'failed', error: 'Smart contract panicked: The table is full' });
  });

  it('records each relayed move once, by its NEP-366 hash', async () => {
    const p = await playerWithAccount();
    const sd = await delegate(p);
    await relay(p.token, sd);
    const { decodeSignedDelegate } = await import('@nomad/contract/near');
    const hash = base58Encode(await delegateHash(decodeSignedDelegate(Uint8Array.from(Buffer.from(sd, 'base64'))).delegate));
    const row = await env.DB.prepare('SELECT hash, methods, deposit, status FROM near_relays').first();
    expect(row).toEqual({ hash, methods: 'deposit', deposit: (YOCTO_PER_NEAR / 20n).toString(), status: 'ok' });
  });
});
