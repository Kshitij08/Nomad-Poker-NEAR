import { beforeEach, describe, expect, it } from 'vitest';
import {
  Routes,
  ShopRoutes,
  type ApiErrorBody,
  type SessionResponse,
  type ShopBuyResponse,
  type ShopCatalogResponse,
} from '@nomad/contract';
import { createApp } from '../app';
import type { Env } from '../env';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import * as ledger from '@nomad/db/ledger';
import * as progress from '@nomad/db/progress';

const ORIGIN = 'http://localhost:5180';
const app = createApp();
let env: Env;

beforeEach(async () => {
  env = {
    DB: await D1Shim.migrated(),
    HANDS: {} as R2Bucket,
    STAGE: 'test',
    ALLOWED_ORIGINS: ORIGIN,
    SPIN_SECRET: 'test-secret',
  };
});

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function guest(): Promise<{ token: string; id: string }> {
  const s = await call<SessionResponse>('POST', Routes.guest, {});
  return { token: s.body.token, id: s.body.player.id };
}

let n = 0;
const buy = (token: string, itemId: string, requestId = `req-${(n++).toString().padStart(8, '0')}`) =>
  call<ShopBuyResponse & ApiErrorBody>('POST', ShopRoutes.buy, { itemId, requestId }, token);

describe('shop · Coins', () => {
  it('lists the catalogue with server prices', async () => {
    const g = await guest();
    const c = await call<ShopCatalogResponse>('GET', ShopRoutes.catalog, undefined, g.token);
    expect(c.status).toBe(200);
    expect(c.body.items.find((i) => i.id === 'xp-pack')?.priceCoins).toBe(8000);
    expect(c.body.owned).toEqual([]);
    expect(c.body.items.every((i) => !('priceLamports' in i))).toBe(true);
  });

  it('buys an XP pack: Coins down, XP up, levels paid', async () => {
    const g = await guest();
    const r = await buy(g.token, 'xp-pack');
    expect(r.status).toBe(200);
    expect(r.body.balances.xp).toBeGreaterThanOrEqual(5_000);
    expect(r.body.levelsPaid.length).toBeGreaterThan(0);
    // Coins: 10,000 − 8,000 + the level rewards the XP paid.
    expect(r.body.balances.coins).toBeGreaterThanOrEqual(2_000);
  });

  it('a retry with the same request id charges once', async () => {
    const g = await guest();
    const a = await buy(g.token, 'deck:Forest', 'retry-req-0001');
    const b = await buy(g.token, 'deck:Forest', 'retry-req-0001');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.balances.coins).toBe(10_000 - 6_000);
    expect(b.body.owned).toEqual(['deck:Forest']);
    const shopEntries = (await ledger.entries(env.DB, g.id, { limit: 50 })).entries.filter((e) => e.reason === 'shop');
    expect(shopEntries).toHaveLength(1);
  });

  it('refuses a second copy of a one-time item', async () => {
    const g = await guest();
    await buy(g.token, 'deck:Town');
    const again = await buy(g.token, 'deck:Town');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('conflict');
  });

  it('refuses when Coins run short and changes nothing', async () => {
    const g = await guest();
    const r = await buy(g.token, 'xp-level'); // 25,000 > 10,000
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('insufficient_funds');
    const bal = await ledger.balances(env.DB, g.id);
    expect(bal.coins).toBe(10_000);
    expect(bal.xp).toBe(0);
  });

  it('rejects unknown items', async () => {
    const g = await guest();
    const r = await buy(g.token, 'th-neon');
    expect(r.status).toBe(404);
  });

  it('Level up jumps to the start of the next level', async () => {
    const g = await guest();
    await ledger.post(env.DB, [{ playerId: g.id, currency: 'coins', delta: 50_000, reason: 'test', idempotencyKey: 'grant' }]);
    const r = await buy(g.token, 'xp-level');
    expect(r.status).toBe(200);
    expect(r.body.balances.xp).toBe(100); // level 1 → 2 needs 100 XP
  });

  it('an XP boost doubles hand XP while it runs', async () => {
    const g = await guest();
    const before = Date.now();
    const r = await buy(g.token, 'xp-boost-1h');
    expect(r.status).toBe(200);
    expect(new Date(r.body.xpBoostUntil!).getTime()).toBeGreaterThan(before + 3_500_000);
    await progress.recordHand(env.DB, g.id, { tableId: 't1', hand: 1, won: false, showdownCategory: null, net: 0 });
    const boosted = (await ledger.balances(env.DB, g.id)).xp;
    const g2 = await guest();
    await progress.recordHand(env.DB, g2.id, { tableId: 't1', hand: 1, won: false, showdownCategory: null, net: 0 });
    const plain = (await ledger.balances(env.DB, g2.id)).xp;
    expect(plain).toBeGreaterThan(0);
    expect(boosted).toBe(plain * 2);
  });
});

describe('shop · Coins packs', () => {
  it('are listed but not sold for Coins', async () => {
    const g = await guest();
    const c = await call<ShopCatalogResponse>('GET', ShopRoutes.catalog, undefined, g.token);
    expect(c.body.items.find((i) => i.id === 'coins-5k')?.priceCoins).toBeNull();
    const r = await buy(g.token, 'coins-5k');
    expect(r.status).toBe(400);
    expect((await ledger.balances(env.DB, g.id)).coins).toBe(10_000);
  });

  it('the old SOL routes are gone', async () => {
    const g = await guest();
    expect((await call('POST', '/v1/shop/sol/intent', { itemId: 'xp-pack' }, g.token)).status).toBe(404);
    expect((await call('POST', '/v1/shop/sol/confirm', { intentId: 'x', signature: 'y' }, g.token)).status).toBe(404);
  });
});
