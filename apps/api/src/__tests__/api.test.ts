import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProgressRoutes,
  Routes,
  type ProgressSnapshot,
  type SpinResponse,
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
    SPIN_SECRET: 'test-secret',
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

describe('rewards (the server decides)', () => {
  it('serves progress and pays the daily spin once', async () => {
    const g = await call<SessionResponse>('POST', Routes.guest, {});
    const p0 = await call<ProgressSnapshot>('GET', ProgressRoutes.progress, undefined, g.body.token);
    expect(p0.body).toMatchObject({ level: 1, spin: { canSpin: true }, login: { canClaim: true, day: 1 } });
    expect(p0.body.missions.slots).toHaveLength(8);
    const s1 = await call<SpinResponse>('POST', ProgressRoutes.spin, {}, g.body.token);
    expect(s1.body.awarded).toBe(true);
    expect(s1.body.progress.balances.coins).toBe(10_000 + s1.body.coins);
    const s2 = await call<SpinResponse>('POST', ProgressRoutes.spin, {}, g.body.token);
    expect(s2.body.awarded).toBe(false);
  });

  it('needs a session, and a spin secret on the server', async () => {
    expect((await call('POST', ProgressRoutes.spin, {})).status).toBe(401);
    const g = await call<SessionResponse>('POST', Routes.guest, {});
    env.SPIN_SECRET = undefined;
    expect((await call<ApiErrorBody>('POST', ProgressRoutes.spin, {}, g.body.token)).body.error.code).toBe('not_configured');
  });

  it('gives a scripted client no way to grant itself coins, XP or items', async () => {
    const g = await call<SessionResponse>('POST', Routes.guest, {});
    const t = g.body.token;
    const forged = { amount: 1_000_000, chips: 1_000_000, coins: 1_000_000, xp: 1_000_000, gems: 500, itemId: 'frame_lv100', key: 'daily_spin:x', reason: 'daily_spin', delta: 1_000_000 };
    for (const path of ['/v1/ledger', '/v1/ledger/grant', '/v1/rewards/grant', '/v1/wallet/grant', '/v1/progress', '/v1/rewards/level', '/v1/items']) {
      await call('POST', path, forged, t);
    }
    // The real routes ignore anything a client says about amounts: a spin is the server's roll, a mission needs
    // hands the game server counted, the login track pays its catalogue day.
    await call('POST', ProgressRoutes.spin, forged, t);
    await call('POST', ProgressRoutes.login, forged, t);
    expect((await call<{ ok: boolean }>('POST', ProgressRoutes.missionClaim, { id: 'weekly_collector_12', ...forged }, t)).body.ok).toBe(false);
    const p = await call<ProgressSnapshot>('GET', ProgressRoutes.progress, undefined, t);
    const spinCoins = p.body.spin.lastSpinCoins;
    expect(p.body.balances).toEqual({ coins: 10_000 + spinCoins + 500, gems: 0, xp: 0, streak_tokens: 0 });
    expect(p.body.items).toEqual([]);
  });
});

describe('social over HTTP (two accounts)', () => {
  it('friends, invites, profile and a leaderboard page', async () => {
    const a = await call<SessionResponse>('POST', Routes.guest, { displayName: 'Ann' });
    const b = await call<SessionResponse>('POST', Routes.guest, { displayName: 'Bob' });
    const bobCode = b.body.player.friendCode;
    expect(bobCode).toMatch(/^[0-9A-F]{16}$/);

    expect((await call('POST', '/v1/friends/request', { idOrName: bobCode }, a.body.token)).body).toEqual({ ok: true, relation: 'pending_out' });
    const bobView = await call<{ friends: { id: string; relation: string }[] }>('GET', '/v1/social', undefined, b.body.token);
    expect(bobView.body.friends).toMatchObject([{ id: a.body.player.friendCode, relation: 'pending_in' }]);
    expect((await call('POST', '/v1/friends/accept', { friendId: a.body.player.friendCode }, b.body.token)).body).toEqual({ ok: true, relation: 'friend' });

    expect((await call('POST', '/v1/invites/send', { friendId: bobCode, session: 'poker-free' }, a.body.token)).body).toEqual({ ok: true });
    const inbox = await call<{ invites: { fromName: string; session: string }[] }>('GET', '/v1/social', undefined, b.body.token);
    expect(inbox.body.invites).toMatchObject([{ fromName: 'Ann', session: 'poker-free' }]);

    const renamed = await call<{ displayName: string; avatar: number }>('POST', '/v1/me/profile', { displayName: 'Ann the Bold', avatar: 2 }, a.body.token);
    expect(renamed.body).toMatchObject({ displayName: 'Ann the Bold', avatar: 2 });
    expect((await call<ApiErrorBody>('POST', '/v1/me/profile', { avatar: 9999 }, a.body.token)).status).toBe(400);

    const board = await call<{ localRank: number; rows: unknown[] }>('GET', '/v1/leaderboards/0', undefined, a.body.token);
    expect(board.body).toMatchObject({ localRank: 1, rows: [] });
    expect((await call('GET', '/v1/leaderboards/9', undefined, a.body.token)).status).toBe(404);
    expect((await call('GET', '/v1/social')).status).toBe(401);
  });
});

describe('tournaments and the strategies market over HTTP', () => {
  it('hosts, registers by join code, takes fees through the ledger, and shows my tournaments', async () => {
    env.TOURNAMENT_MIN_LEAD_SECONDS = '60';
    const host = await call<SessionResponse>('POST', Routes.guest, { displayName: 'Host' });
    const ann = await call<SessionResponse>('POST', Routes.guest, { displayName: 'Ann' });
    const startsAtUnix = Math.floor(Date.now() / 1000) + 120;
    type One = { serverNowUnix: number; tournament: { id: string; joinCode: string; status: string; players: number; myStatus: string; hostPlayFabId: string } };
    const made = await call<One>('POST', '/v1/tournaments', { name: 'Lunch Cup', entryFee: 300, hostPrize: 1000, visibility: 'private', speed: 'turbo', startsAtUnix }, host.body.token);
    expect(made.status).toBe(200);
    expect(made.body.tournament).toMatchObject({ status: 'registering', hostPlayFabId: host.body.player.friendCode });
    const code = made.body.tournament.joinCode;
    expect((await call<{ tournaments: unknown[] }>('GET', '/v1/tournaments')).body.tournaments).toEqual([]); // private

    const found = await call<One>('GET', `/v1/tournaments/code/${code}`, undefined, ann.body.token);
    expect(found.body.tournament.id).toBe(made.body.tournament.id);
    const reg = await call<One>('POST', `/v1/tournaments/${found.body.tournament.id}/register`, {}, ann.body.token);
    expect(reg.body.tournament).toMatchObject({ players: 1, myStatus: 'registered' });
    const l = await call<LedgerResponse>('GET', Routes.ledger, undefined, ann.body.token);
    expect(l.body.balances.coins).toBe(9700);
    const mine = await call<{ entries: { id: string }[] }>('GET', '/v1/me/tournaments', undefined, ann.body.token);
    expect(mine.body.entries.map((t) => t.id)).toEqual([made.body.tournament.id]);
    expect((await call<ApiErrorBody>('POST', `/v1/tournaments/${made.body.tournament.id}/cancel`, {}, ann.body.token)).status).toBe(403);
    expect((await call<One>('POST', `/v1/tournaments/${made.body.tournament.id}/cancel`, {}, host.body.token)).body.tournament.status).toBe('cancelled');
    expect((await call<LedgerResponse>('GET', Routes.ledger, undefined, ann.body.token)).body.balances.coins).toBe(10_000);
    expect((await call<ApiErrorBody>('POST', '/v1/tournaments', { name: 'Too soon', startsAtUnix: Math.floor(Date.now() / 1000) + 10 }, host.body.token)).status).toBe(400);
  });

  it('publishes a strategy, lists it, and answers twin and coach', async () => {
    const bob = await call<SessionResponse>('POST', Routes.guest, { displayName: 'Bob' });
    const profile = { foldBelow: 0.2, raiseAbove: 0.55, aggression: 0.8, bluffChance: 0.1, raiseFractionOfPot: 0.9 };
    const pub = await call<{ strategyId: string; name: string; version: number; qualified: boolean }>('POST', '/v1/strategies', { name: 'Shark', profile }, bob.body.token);
    expect(pub.body).toMatchObject({ name: 'Shark', version: 1, qualified: false });
    expect((await call<{ strategies: unknown[] }>('GET', '/v1/strategies?sort=top')).body.strategies).toEqual([]); // nothing qualified yet
    expect((await call<{ strategyId: string }>('GET', `/v1/strategies/${pub.body.strategyId}`)).body.strategyId).toBe(pub.body.strategyId);
    expect((await call<{ strategies: unknown[]; earned: number }>('GET', '/v1/strategies/mine', undefined, bob.body.token)).body).toMatchObject({ earned: 0 });
    expect((await call<{ decisions: number }>('GET', '/v1/style/twin', undefined, bob.body.token)).body.decisions).toBe(0);
    expect((await call<{ hands: number; note: null }>('GET', '/v1/style/coach', undefined, bob.body.token)).body).toMatchObject({ hands: 0, note: null });
    expect((await call('POST', `/v1/strategies/${pub.body.strategyId}/unlist`, {}, bob.body.token)).body).toEqual({ ok: true });
  });
});

describe('write rate limit', () => {
  it('refuses writes over the limit but never sign-in, and leaves reads alone', async () => {
    const s = await call<SessionResponse>('POST', Routes.guest, { displayName: 'Busy' });
    let allowed = 2;
    const keys: string[] = [];
    env.WRITE_LIMITER = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: allowed-- > 0 }) } as unknown as RateLimit;
    expect((await call('POST', '/v1/friends/request', { idOrName: 'nobody' }, s.body.token)).status).toBe(200);
    expect((await call('POST', '/v1/friends/request', { idOrName: 'nobody' }, s.body.token)).status).toBe(200);
    const third = await call<ApiErrorBody>('POST', '/v1/friends/request', { idOrName: 'nobody' }, s.body.token);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('rate_limited');
    expect((await call('GET', '/v1/social', undefined, s.body.token)).status).toBe(200);
    expect((await call('POST', Routes.guest, { displayName: 'Other' })).status).toBe(201);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).not.toContain(s.body.token);
  });
});
