import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Routes,
  ShopRoutes,
  type ApiErrorBody,
  type SessionResponse,
  type ShopBuyResponse,
  type ShopCatalogResponse,
  type ShopSolIntentResponse,
} from '@nomad/contract';
import { createApp, setShopTxFetcherForTests } from '../app';
import type { Env } from '../env';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import * as ledger from '@nomad/db/ledger';
import * as progress from '@nomad/db/progress';
import type { ParsedTx } from '@nomad/db/shop';

const ORIGIN = 'http://localhost:5180';
const TREASURY = 'GV5LYvyakPHtjNWENbFKnfyG2NuMLkL6xYPxo6YyEcJw';
const SIG = '5'.repeat(88);
const app = createApp();
let env: Env;

beforeEach(async () => {
  env = {
    DB: await D1Shim.migrated(),
    HANDS: {} as R2Bucket,
    STAGE: 'test',
    ALLOWED_ORIGINS: ORIGIN,
    WALLET_CHAIN_ID: 'devnet',
    SPIN_SECRET: 'test-secret',
    SOLANA_RPC_URL: 'https://devnet.example',
    SHOP_TREASURY: TREASURY,
  };
});
afterEach(() => setShopTxFetcherForTests(null));

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
    expect(c.body.solEnabled).toBe(true);
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

describe('shop · SOL (devnet)', () => {
  const tx = (memo: string, lamports: number, dest = TREASURY, err: unknown = null): ParsedTx => ({
    meta: { err },
    blockTime: Math.floor(Date.now() / 1000),
    transaction: {
      message: {
        instructions: [
          { programId: '11111111111111111111111111111111', program: 'system', parsed: { type: 'transfer', info: { destination: dest, lamports } } },
          { programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', program: 'spl-memo', parsed: memo },
        ],
      },
    },
  });

  it('quotes, checks the transfer on chain, applies the item once', async () => {
    const g = await guest();
    const q = await call<ShopSolIntentResponse>('POST', ShopRoutes.solIntent, { itemId: 'deck:Desert' }, g.token);
    expect(q.status).toBe(200);
    expect(q.body.treasury).toBe(TREASURY);
    setShopTxFetcherForTests(async () => tx(q.body.memo, q.body.lamports));
    const r = await call<ShopBuyResponse>('POST', ShopRoutes.solConfirm, { intentId: q.body.intentId, signature: SIG }, g.token);
    expect(r.status).toBe(200);
    expect(r.body.owned).toEqual(['deck:Desert']);
    expect(r.body.balances.coins).toBe(10_000); // no Coins spent
    const again = await call<ShopBuyResponse>('POST', ShopRoutes.solConfirm, { intentId: q.body.intentId, signature: SIG }, g.token);
    expect(again.status).toBe(200);
  });

  it('refuses a wrong memo, a short payment, another address, or a failed transaction', async () => {
    const g = await guest();
    const q = await call<ShopSolIntentResponse>('POST', ShopRoutes.solIntent, { itemId: 'xp-pack' }, g.token);
    const bads = [
      tx('other', q.body.lamports),
      tx(q.body.memo, q.body.lamports - 1),
      tx(q.body.memo, q.body.lamports, 'Somewhere1111111111111111111111111111111111'),
      tx(q.body.memo, q.body.lamports, TREASURY, { InstructionError: [0, 'x'] }),
    ];
    for (const bad of bads) {
      setShopTxFetcherForTests(async () => bad);
      const r = await call<ApiErrorBody>('POST', ShopRoutes.solConfirm, { intentId: q.body.intentId, signature: SIG }, g.token);
      expect(r.status).toBe(409);
    }
    expect((await ledger.balances(env.DB, g.id)).xp).toBe(0);
  });

  it('one signature cannot pay two purchases', async () => {
    const g = await guest();
    const a = await call<ShopSolIntentResponse>('POST', ShopRoutes.solIntent, { itemId: 'xp-pack' }, g.token);
    const b = await call<ShopSolIntentResponse>('POST', ShopRoutes.solIntent, { itemId: 'xp-pack' }, g.token);
    setShopTxFetcherForTests(async () => tx(a.body.memo, a.body.lamports));
    expect((await call('POST', ShopRoutes.solConfirm, { intentId: a.body.intentId, signature: SIG }, g.token)).status).toBe(200);
    const r = await call<ApiErrorBody>('POST', ShopRoutes.solConfirm, { intentId: b.body.intentId, signature: SIG }, g.token);
    expect(r.status).toBe(409);
  });

  it('sells Coins packs for SOL: credits the Coins once per signature', async () => {
    const g = await guest();
    const q = await call<ShopSolIntentResponse>('POST', ShopRoutes.solIntent, { itemId: 'coins-25k' }, g.token);
    expect(q.status).toBe(200);
    expect(q.body.lamports).toBe(20_000_000); // ◎0.02, the server's price
    setShopTxFetcherForTests(async () => tx(q.body.memo, q.body.lamports));
    const r = await call<ShopBuyResponse>('POST', ShopRoutes.solConfirm, { intentId: q.body.intentId, signature: SIG }, g.token);
    expect(r.status).toBe(200);
    expect(r.body.balances.coins).toBe(10_000 + 25_000);
    // A retried confirm (same intent, same signature) credits nothing more.
    const again = await call<ShopBuyResponse>('POST', ShopRoutes.solConfirm, { intentId: q.body.intentId, signature: SIG }, g.token);
    expect(again.status).toBe(200);
    expect(again.body.balances.coins).toBe(35_000);
    const credits = (await ledger.entries(env.DB, g.id, { limit: 50 })).entries.filter((e) => e.reason === 'shop' && e.currency === 'coins');
    expect(credits).toHaveLength(1);
  });

  it('Coins packs are not sold for Coins', async () => {
    const g = await guest();
    const r = await buy(g.token, 'coins-5k');
    expect(r.status).toBe(400);
    expect((await ledger.balances(env.DB, g.id)).coins).toBe(10_000);
  });

  it('a short payment for a Coins pack credits nothing', async () => {
    const g = await guest();
    const q = await call<ShopSolIntentResponse>('POST', ShopRoutes.solIntent, { itemId: 'coins-150k' }, g.token);
    setShopTxFetcherForTests(async () => tx(q.body.memo, q.body.lamports - 1));
    const r = await call<ApiErrorBody>('POST', ShopRoutes.solConfirm, { intentId: q.body.intentId, signature: SIG }, g.token);
    expect(r.status).toBe(409);
    expect((await ledger.balances(env.DB, g.id)).coins).toBe(10_000);
  });

  it('is closed without a treasury', async () => {
    env.SHOP_TREASURY = undefined;
    const g = await guest();
    const q = await call<ApiErrorBody>('POST', ShopRoutes.solIntent, { itemId: 'xp-pack' }, g.token);
    expect(q.status).toBe(501);
  });
});
