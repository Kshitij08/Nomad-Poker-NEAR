import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Routes, type ApiErrorBody, type MeResponse, type NearChallengeResponse, type SessionResponse } from '@nomad/contract';
import { createApp } from '../app';
import type { Env } from '../env';
import { base58Encode } from '@nomad/db/util';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { base64Decode, base64Encode, isAccountId, nep413Hash, parseEd25519Key, verifyNep413 } from '../near';

const ORIGIN = 'http://localhost:5180';
const RPC = 'https://rpc.test.near';
const app = createApp();
let env: Env;

/** Keys the stubbed RPC node knows: account -> public key -> permission. */
let chainKeys: Record<string, Record<string, 'FullAccess' | { FunctionCall: object }>> = {};
let rpcDown = false;
const ESCROW = 'nomad-escrow.testnet';
type EscrowT = { host: string; entry_fee: string; max_players: number; starts_at: string; prize: string; private: boolean; players: string[]; status: string };
/** The escrow's tournaments as its views show them (get_tournament, is_registered). */
let escrowTournaments: Record<string, EscrowT> = {};

function escrowView(params: { account_id: string; method_name: string; args_base64: string }): Response {
  if (params.account_id !== ESCROW) throw new Error('unexpected contract ' + params.account_id);
  if (rpcDown) return new Response('down', { status: 502 });
  const args = JSON.parse(new TextDecoder().decode(base64Decode(params.args_base64)!));
  const t = escrowTournaments[args.tournament_id] ?? null;
  const value = params.method_name === 'get_tournament' ? t : params.method_name === 'is_registered' ? !!t?.players.includes(args.account) : undefined;
  if (value === undefined) throw new Error('unexpected view ' + params.method_name);
  const result = [...new TextEncoder().encode(JSON.stringify(value))];
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { result, logs: [] } }), { status: 200 });
}

beforeEach(async () => {
  env = {
    DB: await D1Shim.migrated(),
    HANDS: {} as R2Bucket,
    STAGE: 'test',
    ALLOWED_ORIGINS: ORIGIN,
    EMAIL_DEV_ECHO: '1',
    SPIN_SECRET: 'test-secret',
    NEAR_RPC_URL: RPC,
    NEAR_ESCROW: ESCROW,
  };
  chainKeys = {};
  escrowTournaments = {};
  rpcDown = false;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url !== RPC) throw new Error(`unexpected fetch ${url}`);
    if (rpcDown) return new Response('down', { status: 502 });
    const { params } = JSON.parse(String(init.body));
    if (params.request_type === 'call_function') return escrowView(params);
    const permission = chainKeys[params.account_id]?.[params.public_key];
    const body = permission ? { result: { nonce: 1, permission } } : { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY' } } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', ...body }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** A NEAR account holding one key; `full` registers it as a full-access key on the stubbed chain. */
async function newAccount(accountId: string, full = true) {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = `ed25519:${base58Encode(new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer))}`;
  if (full) (chainKeys[accountId] ??= {})[publicKey] = 'FullAccess';
  /** What a wallet's NEP-413 signMessage returns for a challenge. */
  const sign = async (ch: NearChallengeResponse) =>
    base64Encode(new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, await nep413Hash(ch.message, base64Decode(ch.nonce)!, ch.recipient))));
  return { accountId, publicKey, sign };
}

async function nearSignIn(a: Awaited<ReturnType<typeof newAccount>>, token?: string) {
  const ch = await call<NearChallengeResponse>('POST', Routes.nearChallenge, { accountId: a.accountId });
  expect(ch.status).toBe(200);
  return call<SessionResponse>('POST', Routes.nearVerify, { accountId: a.accountId, publicKey: a.publicKey, nonce: ch.body.nonce, signature: await a.sign(ch.body) }, token);
}

describe('NEP-413 encoding', () => {
  it('verifies a signature made by near-api-js (interoperability vector)', async () => {
    // Produced by near-api-js 7.5.3 KeyPairSigner.signNep413Message with a fixed test key (seed bytes 0x01..0x20).
    const v = {
      publicKey: 'ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj',
      message: 'Sign in to Nomad Poker as alice.testnet.',
      recipient: 'localhost:5180',
      nonce: '//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=',
      signature: 'tgOokDwhd4xN47hSPm9zXdyasVYITKB43JxPheogZnOxTc3A1L3mf+NX66XXNKQUj7VyK23d0kNDRfCIP/+eDg==',
    };
    const key = parseEd25519Key(v.publicKey)!;
    const sig = base64Decode(v.signature)!;
    const nonce = base64Decode(v.nonce)!;
    expect(await verifyNep413(key, sig, v.message, nonce, v.recipient)).toBe(true);
    // Any change to what was signed fails.
    expect(await verifyNep413(key, sig, v.message + '!', nonce, v.recipient)).toBe(false);
    expect(await verifyNep413(key, sig, v.message, nonce, 'evil.example')).toBe(false);
  });

  it('accepts NEAR account ids and refuses other text', () => {
    for (const ok of ['alice.testnet', 'pro.nomad-poker.testnet', 'a_b-c.near', 'f'.repeat(64)]) expect(isAccountId(ok)).toBe(true);
    for (const bad of ['A.testnet', 'a', 'alice..near', '.alice', 'alice.', 'al ice', 'x'.repeat(65)]) expect(isAccountId(bad)).toBe(false);
  });
});

describe('NEAR sign-in', () => {
  it('signs a new NEAR account in as a registered player, and the same account again', async () => {
    const a = await newAccount('alice.testnet');
    const s = await nearSignIn(a);
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ created: true, player: { kind: 'registered', displayName: 'alice.testnet' } });
    const me = await call<MeResponse>('GET', Routes.me, undefined, s.body.token);
    expect(me.body.identities).toMatchObject([{ provider: 'near', label: 'alice.testnet' }]);
    const again = await nearSignIn(a);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, player: { id: s.body.player.id } });
  });

  it('gives the wallet the message, the app as recipient, and a 32-byte nonce', async () => {
    const ch = await call<NearChallengeResponse>('POST', Routes.nearChallenge, { accountId: 'Alice.Testnet' });
    expect(ch.body.message).toContain('alice.testnet');
    expect(ch.body.recipient).toBe('localhost:5180');
    expect(base64Decode(ch.body.nonce)).toHaveLength(32);
  });

  it('links NEAR to a signed-in guest', async () => {
    const g = await call<SessionResponse>('POST', Routes.guest, {});
    const s = await nearSignIn(await newAccount('bob.testnet'), g.body.token);
    expect(s.body).toMatchObject({ linked: true, player: { id: g.body.player.id } });
  });

  it('refuses a wrong signature, a reused or swapped challenge, and an expired one', async () => {
    const a = await newAccount('alice.testnet');
    const other = await newAccount('mallory.testnet');
    const ch = await call<NearChallengeResponse>('POST', Routes.nearChallenge, { accountId: a.accountId });
    const bad = await call<ApiErrorBody>('POST', Routes.nearVerify, { accountId: a.accountId, publicKey: a.publicKey, nonce: ch.body.nonce, signature: await other.sign(ch.body) });
    expect(bad.status).toBe(401);
    // The challenge was used up by the failed attempt.
    const reuse = await call<ApiErrorBody>('POST', Routes.nearVerify, { accountId: a.accountId, publicKey: a.publicKey, nonce: ch.body.nonce, signature: await a.sign(ch.body) });
    expect(reuse.status).toBe(401);
    // A challenge for alice cannot sign in mallory.
    const ch2 = await call<NearChallengeResponse>('POST', Routes.nearChallenge, { accountId: a.accountId });
    const swapped = await call<ApiErrorBody>('POST', Routes.nearVerify, { accountId: other.accountId, publicKey: other.publicKey, nonce: ch2.body.nonce, signature: await other.sign(ch2.body) });
    expect(swapped.status).toBe(401);
    const ch3 = await call<NearChallengeResponse>('POST', Routes.nearChallenge, { accountId: a.accountId });
    await env.DB.prepare('UPDATE auth_challenges SET expires_at = 1').run();
    const late = await call<ApiErrorBody>('POST', Routes.nearVerify, { accountId: a.accountId, publicKey: a.publicKey, nonce: ch3.body.nonce, signature: await a.sign(ch3.body) });
    expect(late.body.error.code).toBe('expired');
  });

  it("refuses a valid signature from a key that isn't a full-access key of the account", async () => {
    // Signed correctly, but the key is not on alice's account at all: anyone could claim any account name.
    const stranger = await newAccount('alice.testnet', false);
    const r = await nearSignIn(stranger);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'unauthorized' } });
    // A function-call key (an app's limited key) is not enough either.
    const limited = await newAccount('carol.testnet', false);
    chainKeys['carol.testnet'] = { [limited.publicKey]: { FunctionCall: { receiver_id: 'game.testnet', method_names: [] } } };
    expect((await nearSignIn(limited)).status).toBe(401);
  });

  it('answers 503 when NEAR is unreachable, and the account can sign in once it is back', async () => {
    const a = await newAccount('dave.testnet');
    rpcDown = true;
    expect((await nearSignIn(a)).status).toBe(503);
    rpcDown = false;
    expect((await nearSignIn(a)).status).toBe(201);
  });

  it('refuses bad account ids, and answers not_configured without an RPC', async () => {
    expect((await call<ApiErrorBody>('POST', Routes.nearChallenge, { accountId: 'not an account' })).status).toBe(400);
    env.NEAR_RPC_URL = undefined;
    const r = await call<ApiErrorBody>('POST', Routes.nearChallenge, { accountId: 'alice.testnet' });
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('not_configured');
  });
});

describe('NEAR tournaments over HTTP', () => {
  type One = { tournament: { id: string; currency: string; escrowReady: boolean; players: number; myStatus: string; status: string; joinCode: string; startsAtUnix: number } };
  it('creates, confirms against the escrow, registers and leaves by what the escrow says, and cancels', async () => {
    env.TOURNAMENT_MIN_LEAD_SECONDS = '60';
    const host = await nearSignIn(await newAccount('host.testnet'));
    const ann = await nearSignIn(await newAccount('ann.testnet'));
    const guest = await call<SessionResponse>('POST', Routes.guest, {});
    const startsAtUnix = Math.floor(Date.now() / 1000) + 3600;

    const made = await call<One>('POST', '/v1/tournaments', { name: 'NEAR Cup', entryFee: 50, hostPrize: 100, maxPlayers: 6, startsAtUnix, currency: 'near' }, host.body.token);
    expect(made.status).toBe(200);
    const t = made.body.tournament;
    expect(t).toMatchObject({ currency: 'near', escrowReady: false });
    expect((await call<ApiErrorBody>('POST', '/v1/tournaments', { name: 'x', startsAtUnix, currency: 'near' }, guest.body.token)).body.error.code).toBe('near_required');
    expect((await call<{ tournaments: unknown[] }>('GET', '/v1/tournaments')).body.tournaments).toEqual([]);

    // Not on the escrow yet, then created there by the host's wallet.
    expect((await call<ApiErrorBody>('POST', `/v1/tournaments/${t.id}/confirm-escrow`, {}, host.body.token)).body.error.code).toBe('escrow_missing');
    const yocto = (chips: number) => (BigInt(chips) * 10n ** 21n).toString();
    escrowTournaments[t.id] = { host: 'host.testnet', entry_fee: yocto(50), max_players: 6, starts_at: (BigInt(startsAtUnix) * 10n ** 9n).toString(), prize: yocto(100), private: false, players: [], status: 'Open' };
    rpcDown = true;
    expect((await call<ApiErrorBody>('POST', `/v1/tournaments/${t.id}/confirm-escrow`, {}, host.body.token)).status).toBe(503);
    rpcDown = false;
    expect((await call<One>('POST', `/v1/tournaments/${t.id}/confirm-escrow`, {}, host.body.token)).body.tournament.escrowReady).toBe(true);
    expect((await call<{ tournaments: { id: string }[] }>('GET', '/v1/tournaments')).body.tournaments.map((x) => x.id)).toEqual([t.id]);

    // Register: only once the escrow has ann's entry; leave: only once it let her go.
    expect((await call<ApiErrorBody>('POST', `/v1/tournaments/${t.id}/register`, {}, ann.body.token)).body.error.code).toBe('escrow_unpaid');
    escrowTournaments[t.id]!.players.push('ann.testnet');
    expect((await call<One>('POST', `/v1/tournaments/${t.id}/register`, {}, ann.body.token)).body.tournament).toMatchObject({ players: 1, myStatus: 'registered' });
    expect((await call<ApiErrorBody>('POST', `/v1/tournaments/${t.id}/unregister`, {}, ann.body.token)).body.error.code).toBe('escrow_registered');
    escrowTournaments[t.id]!.players = [];
    expect((await call<One>('POST', `/v1/tournaments/${t.id}/unregister`, {}, ann.body.token)).body.tournament.myStatus).toBe('unregistered');
    expect((await call<ApiErrorBody>('POST', `/v1/tournaments/${t.id}/register`, {}, guest.body.token)).body.error.code).toBe('near_required');

    // The host's wallet cancelled it on the escrow; then the API marks it cancelled.
    escrowTournaments[t.id]!.status = 'Cancelled';
    expect((await call<One>('POST', `/v1/tournaments/${t.id}/cancel`, {}, host.body.token)).body.tournament.status).toBe('cancelled');
    const row = await env.DB.prepare('SELECT escrow_status FROM tournaments WHERE id = ?1').bind(t.id).first<{ escrow_status: string }>();
    expect(row?.escrow_status).toBe('refunded');
  });

  it('answers not_configured for a NEAR tournament without an escrow', async () => {
    env.NEAR_ESCROW = undefined;
    const host = await nearSignIn(await newAccount('host.testnet'));
    const r = await call<ApiErrorBody>('POST', '/v1/tournaments', { name: 'x', startsAtUnix: Math.floor(Date.now() / 1000) + 3600, currency: 'near' }, host.body.token);
    expect(r.status).toBe(501);
  });
});
