/**
 * Live check of "Create my NEAR account" and the relayer on NEAR testnet, with the API running in this process (Hono
 * app + the node:sqlite D1 stand-in) and real RPC. Makes one player account under the sponsor, signs in with its key,
 * then deposits 0.06 NEAR, buys in at poker-money-st50 for 50 chips (0.05 NEAR, from the game balance) and withdraws the
 * remaining 0.01 NEAR, every move a relayed delegate action. The seat's locked NEAR stays at the table until the game
 * server cashes it out (or the escrow's reclaim).
 *
 *   NEAR_SPONSOR_KEY=ed25519:... npx tsx scripts/near-relay-live.ts
 */
import { Routes, type NearAccountResponse, type NearChallengeResponse, type NearRelayResponse, type SessionResponse, type MeResponse } from '@nomad/contract';
import { encodeSignedDelegate, functionCall, publicKeyText, signDelegate, TGAS, toBase64, YOCTO_PER_NEAR } from '@nomad/contract/near';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { base64Decode, base64Encode, nep413Hash, viewFunction } from '../src/near';

const RPC = process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com';
const ESCROW = 'nomad-escrow.testnet';
const TABLE_ID = 'poker-money-st50';
const SPONSOR = process.env.NEAR_SPONSOR_ID ?? 'players.nomad-poker.testnet';
const ORIGIN = 'http://localhost:5180';
if (!process.env.NEAR_SPONSOR_KEY) throw new Error('set NEAR_SPONSOR_KEY');

const env: Env = {
  DB: await D1Shim.migrated(),
  HANDS: {} as R2Bucket,
  STAGE: 'development',
  ALLOWED_ORIGINS: ORIGIN,
  NEAR_RPC_URL: RPC,
  NEAR_ESCROW: ESCROW,
  NEAR_TABLE_CONTRACT: 'table.nomad-poker.testnet',
  NEAR_SPONSOR_ID: SPONSOR,
  NEAR_SPONSOR_KEY: process.env.NEAR_SPONSOR_KEY,
};
const app = createApp();
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const r = (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: T; error?: unknown };
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result;
}
const balanceOf = async (account: string) => BigInt((await rpc<{ amount: string }>('query', { request_type: 'view_account', finality: 'final', account_id: account })).amount);
const near = (y: bigint) => (Number(y) / 1e24).toFixed(5);

// The browser's side: a key pair, NEP-413 sign-in, NEP-366 delegate actions.
const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const publicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
const sign = async (h: Uint8Array) => new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, h));

const sponsorBefore = await balanceOf(SPONSOR);
log(`sponsor ${SPONSOR}: ${near(sponsorBefore)} NEAR`);

let token = (await call<SessionResponse>('POST', Routes.guest, { displayName: 'LiveCheck' })).token;
const made = await call<NearAccountResponse>('POST', Routes.nearAccount, { publicKey: publicKeyText(publicKey) }, token);
const account = made.accountId;
log(`account ${account} made (tx ${made.txHash}), funded ${near(BigInt(made.funded))} NEAR`);

const ch = await call<NearChallengeResponse>('POST', Routes.nearChallenge, { accountId: account }, token);
const sig = base64Encode(await sign(await nep413Hash(ch.message, base64Decode(ch.nonce)!, ch.recipient)));
token = (await call<SessionResponse>('POST', Routes.nearVerify, { accountId: account, publicKey: publicKeyText(publicKey), signature: sig, nonce: ch.nonce }, token)).token;
const me = await call<MeResponse>('GET', Routes.me, undefined, token);
log(`signed in with the browser key; identities: ${me.identities.map((i) => `${i.provider}:${i.label}`).join(', ')}`);

async function move(method: string, args: Record<string, unknown>, deposit: bigint): Promise<NearRelayResponse> {
  const [key, block] = await Promise.all([
    rpc<{ nonce: number }>('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: account, public_key: publicKeyText(publicKey) }),
    rpc<{ header: { height: number } }>('block', { finality: 'final' }),
  ]);
  const signed = await signDelegate(
    { senderId: account, receiverId: ESCROW, actions: [functionCall(method, args, 30n * TGAS, deposit)], nonce: BigInt(key.nonce) + 1n, maxBlockHeight: BigInt(block.header.height) + 300n, publicKey },
    sign,
  );
  const r = await call<NearRelayResponse>('POST', Routes.nearRelay, { signedDelegate: toBase64(encodeSignedDelegate(signed)) }, token);
  log(`${method}: tx ${r.txHash} → ${JSON.stringify(r.value)}`);
  return r;
}

const gameBalance = async () => BigInt(await viewFunction<string>(RPC, ESCROW, 'get_balance', { account }));
await move('deposit', {}, (6n * YOCTO_PER_NEAR) / 100n);
log(`game balance ${near(await gameBalance())} NEAR`);
await move('buy_in', { table_id: TABLE_ID, amount: ((5n * YOCTO_PER_NEAR) / 100n).toString() }, 0n);
log(`seat at ${TABLE_ID}: ${JSON.stringify(await viewFunction(RPC, ESCROW, 'get_seat', { table_id: TABLE_ID, player: account }))}`);
const left = await gameBalance();
await move('withdraw', { amount: left.toString() }, 0n);
log(`game balance ${near(await gameBalance())} NEAR; account ${near(await balanceOf(account))} NEAR`);
const sponsorAfter = await balanceOf(SPONSOR);
log(`sponsor ${near(sponsorAfter)} NEAR (spent ${near(sponsorBefore - sponsorAfter)}: ${near(BigInt(made.funded))} funding + gas)`);
