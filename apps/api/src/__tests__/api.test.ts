import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Routes,
  type ApiErrorBody,
  type EmailStartResponse,
  type LedgerResponse,
  type MeResponse,
  type SessionResponse,
  type WalletChallengeResponse,
} from '@nomad/contract';
import { createApp } from '../app';
import type { Env } from '../env';
import { resetGoogleKeyCache } from '../google';
import * as ledger from '@nomad/db/ledger';
import { base58Encode, base64url, utf8 } from '@nomad/db/util';
import { D1Shim } from '@nomad/db/testing/d1Shim';

const ORIGIN = 'http://localhost:5180';
const app = createApp();
let env: Env;

beforeEach(async () => {
  env = {
    DB: await D1Shim.migrated(),
    HANDS: {} as R2Bucket,
    STAGE: 'test',
    ALLOWED_ORIGINS: `${ORIGIN},https://nomad-poker-web.vercel.app`,
    WALLET_CHAIN_ID: 'devnet',
    EMAIL_DEV_ECHO: '1',
    GOOGLE_CLIENT_IDS: 'web-client-id',
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetGoogleKeyCache();
});

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T; headers: Headers }> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

async function newWallet() {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const address = base58Encode(new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer));
  const sign = async (message: string) => base58Encode(new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, utf8(message))));
  return { address, sign };
}

async function walletSignIn(w: Awaited<ReturnType<typeof newWallet>>, token?: string) {
  const ch = await call<WalletChallengeResponse>('POST', Routes.walletChallenge, { address: w.address });
  expect(ch.status).toBe(200);
  return call<SessionResponse>('POST', Routes.walletVerify, { address: w.address, nonce: ch.body.nonce, signature: await w.sign(ch.body.message) }, token);
}

describe('guest sign-in', () => {
  it('creates a guest with the starter grant, visible in /me and the ledger', async () => {
    const s = await call<SessionResponse>('POST', Routes.guest, {});
    expect(s.status).toBe(201);
    expect(s.body.player.kind).toBe('guest');
    expect(s.body.player.displayName).toMatch(/^Guest \d{4}$/);
    expect(s.body.token).toMatch(/^np_/);

    const me = await call<MeResponse>('GET', Routes.me, undefined, s.body.token);
    expect(me.status).toBe(200);
    expect(me.body.balances).toEqual({ coins: 10_000, gems: 0, xp: 0, streak_tokens: 0 });
    expect(me.body.identities).toEqual([]);

    const l = await call<LedgerResponse>('GET', Routes.ledger, undefined, s.body.token);
    expect(l.body.entries).toHaveLength(1);
    expect(l.body.entries[0]).toMatchObject({ currency: 'coins', delta: 10_000, reason: 'starter' });
  });

  it('keeps a chosen display name, trimmed', async () => {
    const s = await call<SessionResponse>('POST', Routes.guest, { displayName: '  Ace High  ' });
    expect(s.body.player.displayName).toBe('Ace High');
  });

  it('rejects missing, unknown and signed-out tokens', async () => {
    expect((await call<ApiErrorBody>('GET', Routes.me)).status).toBe(401);
    expect((await call<ApiErrorBody>('GET', Routes.me, undefined, 'np_nope')).body.error.code).toBe('unauthorized');
    const s = await call<SessionResponse>('POST', Routes.guest, {});
    expect((await call('POST', Routes.signOut, undefined, s.body.token)).status).toBe(204);
    expect((await call('GET', Routes.me, undefined, s.body.token)).status).toBe(401);
  });

  it('stores only the token hash', async () => {
    const s = await call<SessionResponse>('POST', Routes.guest, {});
    const rows = await env.DB.prepare('SELECT token_hash FROM sessions').all<{ token_hash: string }>();
    expect(rows.results[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.results[0].token_hash).not.toContain(s.body.token);
  });
});

describe('wallet sign-in', () => {
  it('signs in a new wallet as a registered player with the starter grant', async () => {
    const w = await newWallet();
    const s = await walletSignIn(w);
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ created: true, linked: false, player: { kind: 'registered' } });
    const me = await call<MeResponse>('GET', Routes.me, undefined, s.body.token);
    expect(me.body.identities).toMatchObject([{ provider: 'wallet', label: w.address }]);
    expect(me.body.balances.coins).toBe(10_000);

    const again = await walletSignIn(w);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, player: { id: s.body.player.id } });
  });

  it('builds a SIWS-style message for the calling origin and devnet', async () => {
    const w = await newWallet();
    const ch = await call<WalletChallengeResponse>('POST', Routes.walletChallenge, { address: w.address });
    expect(ch.body.message).toContain('localhost:5180 wants you to sign in with your Solana account:');
    expect(ch.body.message).toContain(`\n${w.address}\n`);
    expect(ch.body.message).toContain('Chain ID: devnet');
    expect(ch.body.message).toContain(`Nonce: ${ch.body.nonce}`);
  });

  it('links a wallet to the guest who asks, keeping the balance', async () => {
    const g = await call<SessionResponse>('POST', Routes.guest, {});
    await ledger.post(env.DB, [{ playerId: g.body.player.id, currency: 'coins', delta: -2_500, reason: 'table:buy_in', idempotencyKey: 'b1' }]);
    const w = await newWallet();
    const s = await walletSignIn(w, g.body.token);
    expect(s.body).toMatchObject({ created: false, linked: true, player: { id: g.body.player.id, kind: 'registered' } });
    const me = await call<MeResponse>('GET', Routes.me, undefined, s.body.token);
    expect(me.body.balances.coins).toBe(7_500);
  });

  it('signs a different guest in to the wallet owner instead of linking', async () => {
    const w = await newWallet();
    const owner = await walletSignIn(w);
    const g = await call<SessionResponse>('POST', Routes.guest, {});
    const s = await walletSignIn(w, g.body.token);
    expect(s.body).toMatchObject({ linked: false, player: { id: owner.body.player.id } });
  });

  it('rejects a bad signature, a reused nonce and another address', async () => {
    const w = await newWallet();
    const other = await newWallet();
    const ch = await call<WalletChallengeResponse>('POST', Routes.walletChallenge, { address: w.address });
    const bad = await call<ApiErrorBody>('POST', Routes.walletVerify, { address: w.address, nonce: ch.body.nonce, signature: await other.sign(ch.body.message) });
    expect(bad.status).toBe(401);
    // The nonce was consumed by the failed attempt.
    const reuse = await call<ApiErrorBody>('POST', Routes.walletVerify, { address: w.address, nonce: ch.body.nonce, signature: await w.sign(ch.body.message) });
    expect(reuse.status).toBe(401);

    const ch2 = await call<WalletChallengeResponse>('POST', Routes.walletChallenge, { address: w.address });
    const swapped = await call<ApiErrorBody>('POST', Routes.walletVerify, { address: other.address, nonce: ch2.body.nonce, signature: await other.sign(ch2.body.message) });
    expect(swapped.status).toBe(401);
  });

  it('rejects an expired challenge', async () => {
    const w = await newWallet();
    const ch = await call<WalletChallengeResponse>('POST', Routes.walletChallenge, { address: w.address });
    await env.DB.prepare('UPDATE auth_challenges SET expires_at = 1').run();
    const r = await call<ApiErrorBody>('POST', Routes.walletVerify, { address: w.address, nonce: ch.body.nonce, signature: await w.sign(ch.body.message) });
    expect(r.body.error.code).toBe('expired');
  });

  it('rejects malformed addresses', async () => {
    expect((await call<ApiErrorBody>('POST', Routes.walletChallenge, { address: 'not-base58-0OIl' })).status).toBe(400);
    expect((await call<ApiErrorBody>('POST', Routes.walletChallenge, { address: base58Encode(new Uint8Array(31).fill(7)) })).status).toBe(400);
  });
});

describe('Google sign-in', () => {
  async function googleSetup() {
    const keys = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }), { headers: { 'cache-control': 'max-age=600' } })),
    );
    const enc = (o: unknown) => base64url(utf8(JSON.stringify(o)));
    return async (claims: Record<string, unknown>, kid = 'k1') => {
      const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
      const body = enc({ iss: 'https://accounts.google.com', aud: 'web-client-id', exp: Math.floor(Date.now() / 1000) + 600, ...claims });
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, utf8(`${head}.${body}`)));
      return `${head}.${body}.${base64url(sig)}`;
    };
  }

  it('signs in with a valid ID token', async () => {
    const token = await googleSetup();
    const s = await call<SessionResponse>('POST', Routes.google, { idToken: await token({ sub: 'g-123', email: 'ann@example.com', email_verified: true, given_name: 'Ann' }) });
    expect(s.status).toBe(201);
    expect(s.body.player.displayName).toBe('Ann');
    const me = await call<MeResponse>('GET', Routes.me, undefined, s.body.token);
    expect(me.body.identities).toMatchObject([{ provider: 'google', label: 'ann@example.com' }]);
  });

  it('rejects another audience, an expired token and a forged signature', async () => {
    const token = await googleSetup();
    expect((await call<ApiErrorBody>('POST', Routes.google, { idToken: await token({ sub: 'g', aud: 'someone-else' }) })).status).toBe(401);
    expect((await call<ApiErrorBody>('POST', Routes.google, { idToken: await token({ sub: 'g', exp: 1000 }) })).body.error.code).toBe('expired');
    const good = await token({ sub: 'g' });
    const forged = good.split('.').slice(0, 2).join('.') + '.' + base64url(new Uint8Array(256));
    expect((await call<ApiErrorBody>('POST', Routes.google, { idToken: forged })).status).toBe(401);
  });

  it('answers not_configured without client ids', async () => {
    env.GOOGLE_CLIENT_IDS = undefined;
    const r = await call<ApiErrorBody>('POST', Routes.google, { idToken: 'x.y.z' });
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('not_configured');
  });
});

describe('email sign-in', () => {
  it('signs in through the echoed link once', async () => {
    const start = await call<EmailStartResponse>('POST', Routes.emailStart, { email: 'Bob@Example.com' });
    expect(start.status).toBe(200);
    expect(start.body.devLink).toMatch(new RegExp(`^${ORIGIN}/\\?emailToken=ne_`));
    const token = new URL(start.body.devLink!).searchParams.get('emailToken')!;
    const s = await call<SessionResponse>('POST', Routes.emailVerify, { token });
    expect(s.status).toBe(201);
    expect(s.body.player.displayName).toBe('bob');
    expect((await call('POST', Routes.emailVerify, { token })).status).toBe(401);
  });

  it('refuses a returnTo outside the allowed origins', async () => {
    const r = await call<ApiErrorBody>('POST', Routes.emailStart, { email: 'a@b.co', returnTo: 'https://evil.example' });
    expect(r.status).toBe(400);
  });

  it('answers not_configured when links cannot be delivered', async () => {
    env.EMAIL_DEV_ECHO = '';
    expect((await call<ApiErrorBody>('POST', Routes.emailStart, { email: 'a@b.co' })).status).toBe(501);
  });
});

describe('ledger', () => {
  async function guestId() {
    return (await call<SessionResponse>('POST', Routes.guest, {})).body;
  }

  it('is idempotent per key', async () => {
    const g = await guestId();
    const p = { playerId: g.player.id, currency: 'coins' as const, delta: 50, reason: 'reward:login', idempotencyKey: 'day-1' };
    const [first] = await ledger.post(env.DB, [p]);
    const [again] = await ledger.post(env.DB, [p]);
    expect(first).toBeTypeOf('number');
    expect(again).toBeNull();
    expect((await ledger.balances(env.DB, g.player.id)).coins).toBe(10_050);
  });

  it('refuses overdrafts atomically', async () => {
    const g = await guestId();
    const id = g.player.id;
    await expect(
      ledger.post(env.DB, [
        { playerId: id, currency: 'gems', delta: 5, reason: 'x', idempotencyKey: 'a' },
        { playerId: id, currency: 'coins', delta: -10_001, reason: 'x', idempotencyKey: 'b' },
      ]),
    ).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(await ledger.balances(env.DB, id)).toEqual({ coins: 10_000, gems: 0, xp: 0, streak_tokens: 0 });
  });

  it('pages newest first', async () => {
    const g = await guestId();
    for (let i = 1; i <= 4; i++) await ledger.post(env.DB, [{ playerId: g.player.id, currency: 'xp', delta: i, reason: 'hand', idempotencyKey: `h${i}` }]);
    const p1 = await call<LedgerResponse>('GET', `${Routes.ledger}?limit=2`, undefined, g.token);
    expect(p1.body.entries.map((e) => e.delta)).toEqual([4, 3]);
    const p2 = await call<LedgerResponse>('GET', `${Routes.ledger}?limit=2&before=${p1.body.nextBefore}`, undefined, g.token);
    expect(p2.body.entries.map((e) => e.delta)).toEqual([2, 1]);
    const p3 = await call<LedgerResponse>('GET', `${Routes.ledger}?limit=2&before=${p2.body.nextBefore}`, undefined, g.token);
    expect(p3.body.entries.map((e) => e.reason)).toEqual(['starter']);
    expect(p3.body.nextBefore).toBeUndefined();
  });
});

describe('http', () => {
  it('answers CORS preflights for allowed origins only', async () => {
    const ok = await app.request(Routes.me, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'GET' } }, env);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const no = await app.request(Routes.me, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } }, env);
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reports health and unknown routes as JSON', async () => {
    expect((await call<{ ok: boolean; stage: string }>('GET', Routes.health)).body).toMatchObject({ ok: true, stage: 'test' });
    expect((await call<ApiErrorBody>('GET', '/v1/nope')).body.error.code).toBe('not_found');
  });

  it('rate-limits sign-in when the limiter says no', async () => {
    env.AUTH_LIMITER = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    expect((await call<ApiErrorBody>('POST', Routes.guest, {})).status).toBe(429);
  });
});
