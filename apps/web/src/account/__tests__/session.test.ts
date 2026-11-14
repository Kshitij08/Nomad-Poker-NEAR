import { describe, expect, it } from 'vitest';
import { Routes, type MeResponse } from '@nomad/contract';
import { apiBase, API_PRESETS } from '../install';
import { NomadSession, type TokenStore } from '../session';

const BASE = 'https://api.test';

function memoryStore(initial: string | null = null): TokenStore & { value: string | null } {
  const s = { value: initial, get: () => s.value, set: (t: string | null) => void (s.value = t) };
  return s;
}

const me = (id: string, coins = 10_000): MeResponse => ({
  player: { id, displayName: 'Guest 0001', kind: 'guest', createdAt: '2026-11-08T00:00:00.000Z', friendCode: '0123456789ABCDEF', avatar: 0, picture: null },
  identities: [],
  balances: { coins, gems: 0, xp: 0, streak_tokens: 0 },
});

type Handler = (req: { method: string; path: string; body: Record<string, string> | null; auth: string | null }) => [number, unknown];

function fakeFetch(handler: Handler, log: string[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const path = url.slice(BASE.length);
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(init.body as string) : null;
    log.push(`${init.method} ${path}`);
    const [status, json] = handler({ method: init.method!, path, body, auth: headers.authorization ?? null });
    return new Response(status === 204 ? null : JSON.stringify(json), { status });
  }) as typeof fetch;
}

const events = { emitted: 0, emit() { this.emitted++; } };

describe('NomadSession', () => {
  it('signs in as a guest, keeps the token and loads /me', async () => {
    const store = memoryStore();
    const log: string[] = [];
    const s = new NomadSession(BASE, store, events, fakeFetch(({ path, auth }) => {
      if (path === Routes.guest) return [201, { token: 'np_g', expiresAt: '', player: me('p1').player, created: true, linked: false }];
      if (path === Routes.me) return auth === 'Bearer np_g' ? [200, me('p1')] : [401, { error: { code: 'unauthorized', message: 'no' } }];
      return [404, {}];
    }, log));
    await s.guest();
    expect(store.value).toBe('np_g');
    expect(s.me?.balances.coins).toBe(10_000);
    expect(s.error).toBeNull();
    expect(log).toEqual([`POST ${Routes.guest}`, `GET ${Routes.me}`]);
  });

  it('signs a wallet challenge and sends a base58 signature the server can verify', async () => {
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
    const store = memoryStore('np_guest');
    let sent: Record<string, string> | null = null;
    let sentAuth: string | null = null;
    const bs58 = (await import('bs58')).default;
    const s = new NomadSession(BASE, store, events, fakeFetch(({ path, body, auth }) => {
      if (path === Routes.walletChallenge) return [200, { nonce: 'n1', message: `sign ${body!.address}`, expiresAt: '' }];
      if (path === Routes.walletVerify) {
        sent = body;
        sentAuth = auth;
        return [200, { token: 'np_w', expiresAt: '', player: me('p1').player, created: false, linked: true }];
      }
      if (path === Routes.me) return [200, me('p1')];
      return [404, {}];
    }));
    await s.wallet({
      connect: async () => bs58.encode(pub),
      signMessage: async (m) => new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, m)),
    });
    expect(sent).toMatchObject({ address: bs58.encode(pub), nonce: 'n1' });
    const challenge = new TextEncoder().encode(`sign ${bs58.encode(pub)}`);
    expect(await crypto.subtle.verify('Ed25519', keys.publicKey, bs58.decode(sent!.signature), challenge)).toBe(true);
    expect(sentAuth).toBe('Bearer np_guest'); // the guest token rides along, so the API links instead of creating
    expect(store.value).toBe('np_w');
    expect(s.signedIn).toBe(true);
  });

  it('reports a cancelled wallet without calling the API', async () => {
    const log: string[] = [];
    const s = new NomadSession(BASE, memoryStore(), events, fakeFetch(() => [500, {}], log));
    await s.wallet({ connect: async () => null, signMessage: async () => new Uint8Array() });
    expect(s.error).toBe('Wallet connection cancelled.');
    expect(log).toEqual([]);
  });

  it('drops a stored token the server no longer accepts', async () => {
    const store = memoryStore('np_old');
    const s = new NomadSession(BASE, store, events, fakeFetch(() => [401, { error: { code: 'unauthorized', message: 'Sign in first.' } }]));
    await s.restore();
    expect(store.value).toBeNull();
    expect(s.signedIn).toBe(false);
    expect(s.error).toBeNull();
  });

  it('surfaces API error messages and clears the session on sign-out even if the call fails', async () => {
    const store = memoryStore('np_x');
    const s = new NomadSession(BASE, store, events, fakeFetch(({ path }) =>
      path === Routes.emailStart ? [501, { error: { code: 'not_configured', message: 'Email sign-in is not set up on this server yet.' } }] : [500, {}],
    ));
    expect(await s.emailStart('a@b.co', 'http://localhost:5180')).toBeNull();
    expect(s.error).toBe('Email sign-in is not set up on this server yet.');
    await s.signOut();
    expect(store.value).toBeNull();
  });
});

describe('apiBase', () => {
  it('resolves the fixed presets and nothing by default', () => {
    expect(apiBase(new URLSearchParams('api=staging'))).toBe(API_PRESETS.staging);
    expect(apiBase(new URLSearchParams('api=local'))).toBe('http://localhost:8788');
    expect(apiBase(new URLSearchParams(''))).toBeNull();
  });
});
