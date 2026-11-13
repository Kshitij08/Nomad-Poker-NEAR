/**
 * The shop (Phase 3). The server is the only source of prices and effects; clients name an item.
 *
 * Only items the game honours are sold:
 *   - XP pack (+5,000 XP) and Level up (XP to the start of the next level): ledger XP, level rewards paid as usual.
 *   - 2× XP boosts (1 h / 24 h): hands recorded while the boost runs earn double XP (recordHand reads shop_boosts).
 *   - Card backs from the five room themes, worn at every table (owned_items `deck:<theme>`; the client equips one).
 *   - Coins (chip) packs, sold for devnet SOL only: the Coins are credited to the ledger once per intent.
 * Room themes are not sold: they'd change the room backgrounds, which stay as they are.
 *
 * Coins purchases are one atomic batch: the purchase row (keyed by the client's request id), the Coins debit, the
 * effect. A retry with the same request id changes nothing; an overdraft aborts the whole batch. SOL purchases
 * (devnet) quote an intent; the player's transfer must pay the treasury at least the price and carry the intent id
 * as its memo; the server reads the transaction from a devnet RPC before applying the item, once per signature.
 */
import { PlayerLevelMath } from '@nomad/engine/retention/levels';
import { SHOP_ITEMS, type Balances, type ShopBuyResponse, type ShopCatalogResponse, type ShopItemInfo, type ShopSolIntentResponse } from '@nomad/contract';

export { SHOP_ITEMS };
import { balances, conditionalPostingStatement, isInsufficientFunds } from './ledger';
import { settleLevels } from './progress';
import { fail, iso, randomId } from './util';

const HOUR = 3_600_000;
/** How long a SOL quote stays open. */
const INTENT_TTL_MS = 15 * 60_000;
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

export function shopItem(id: string): ShopItemInfo | undefined {
  return SHOP_ITEMS.find((i) => i.id === id);
}

async function ownedShopItems(db: D1Database, playerId: string): Promise<string[]> {
  const rows = await db.prepare("SELECT item_id FROM owned_items WHERE player_id = ?1 AND item_id LIKE 'deck:%' ORDER BY created_at").bind(playerId).all<{ item_id: string }>();
  return rows.results.map((r) => r.item_id);
}

async function boostUntil(db: D1Database, playerId: string, now: number): Promise<number | null> {
  const r = await db.prepare('SELECT xp_until FROM shop_boosts WHERE player_id = ?1').bind(playerId).first<{ xp_until: number }>();
  return r && r.xp_until > now ? r.xp_until : null;
}

export async function catalog(db: D1Database, playerId: string, solEnabled: boolean, now = Date.now()): Promise<ShopCatalogResponse> {
  const until = await boostUntil(db, playerId, now);
  return { items: [...SHOP_ITEMS], owned: await ownedShopItems(db, playerId), xpBoostUntil: until ? iso(until) : null, solEnabled };
}

/** XP an item grants now (0 for non-XP items). */
function xpFor(item: ShopItemInfo, totalXp: number): number {
  if (item.effect.kind === 'xp') return item.effect.amount;
  if (item.effect.kind === 'level_up') return Math.max(1, PlayerLevelMath.xpRemainingToNext(totalXp));
  return 0;
}

/**
 * The statements that apply `item` for purchase `requestId`, each guarded so it only runs in the batch that created
 * the purchase row (a retry finds the row with an older created_at and skips them all).
 */
function effectStatements(db: D1Database, playerId: string, item: ShopItemInfo, requestId: string, xp: number, now: number): D1PreparedStatement[] {
  const fresh = 'EXISTS (SELECT 1 FROM shop_purchases WHERE player_id = ?8 AND request_id = ?9 AND created_at = ?10)';
  const out: D1PreparedStatement[] = [];
  if (xp > 0)
    out.push(conditionalPostingStatement(db, { playerId, currency: 'xp', delta: xp, reason: 'shop', ref: item.id, idempotencyKey: `shop-xp:${requestId}` }, fresh, [playerId, requestId, now], now));
  if (item.effect.kind === 'xp_boost') {
    const dur = item.effect.hours * HOUR;
    out.push(
      db
        .prepare(
          `INSERT INTO shop_boosts (player_id, xp_until)
           SELECT ?1, ?2 + ?3 WHERE EXISTS (SELECT 1 FROM shop_purchases WHERE player_id = ?1 AND request_id = ?4 AND created_at = ?2)
           ON CONFLICT (player_id) DO UPDATE SET xp_until = MAX(shop_boosts.xp_until, ?2) + ?3`,
        )
        .bind(playerId, now, dur, requestId),
    );
  }
  if (item.effect.kind === 'coins')
    out.push(conditionalPostingStatement(db, { playerId, currency: 'coins', delta: item.effect.amount, reason: 'shop', ref: item.id, idempotencyKey: `shop-coins:${requestId}` }, fresh, [playerId, requestId, now], now));
  if (item.effect.kind === 'card_back')
    out.push(db.prepare('INSERT INTO owned_items (player_id, item_id, source, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING').bind(playerId, item.id, 'shop', now));
  return out;
}

async function result(db: D1Database, playerId: string, itemId: string, levelsPaid: number[], now: number): Promise<ShopBuyResponse> {
  const [bal, owned, until] = await Promise.all([balances(db, playerId), ownedShopItems(db, playerId), boostUntil(db, playerId, now)]);
  return { itemId, balances: bal as Balances, owned, xpBoostUntil: until ? iso(until) : null, levelsPaid };
}

async function assertNotOwned(db: D1Database, playerId: string, item: ShopItemInfo): Promise<void> {
  if (!item.oneTime) return;
  if (await db.prepare('SELECT 1 FROM owned_items WHERE player_id = ?1 AND item_id = ?2').bind(playerId, item.id).first())
    fail(409, 'conflict', 'You already own this.');
}

/** Buys `itemId` with Coins. Idempotent per requestId. */
export async function buyWithCoins(db: D1Database, playerId: string, itemId: string, requestId: string, now = Date.now()): Promise<ShopBuyResponse> {
  const item = shopItem(itemId);
  if (!item) fail(404, 'not_found', 'That item is not in the shop.');
  if (item.priceCoins === null) fail(400, 'bad_request', "That item isn't sold for Coins.");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) fail(400, 'bad_request', 'Bad requestId.');
  const done = await db.prepare('SELECT item_id FROM shop_purchases WHERE player_id = ?1 AND request_id = ?2').bind(playerId, requestId).first<{ item_id: string }>();
  if (done) {
    if (done.item_id !== itemId) fail(409, 'conflict', 'That request id was used for another item.');
    return result(db, playerId, itemId, [], now);
  }
  await assertNotOwned(db, playerId, item);
  const xp = xpFor(item, (await balances(db, playerId)).xp);
  const fresh = 'EXISTS (SELECT 1 FROM shop_purchases WHERE player_id = ?8 AND request_id = ?9 AND created_at = ?10)';
  try {
    await db.batch([
      db.prepare("INSERT INTO shop_purchases (player_id, request_id, item_id, paid_with, created_at) VALUES (?1, ?2, ?3, 'coins', ?4) ON CONFLICT DO NOTHING").bind(playerId, requestId, item.id, now),
      conditionalPostingStatement(db, { playerId, currency: 'coins', delta: -item.priceCoins, reason: 'shop', ref: item.id, idempotencyKey: `shop:${requestId}` }, fresh, [playerId, requestId, now], now),
      ...effectStatements(db, playerId, item, requestId, xp, now),
    ]);
  } catch (err) {
    if (isInsufficientFunds(err)) fail(409, 'insufficient_funds', 'Not enough Coins.');
    throw err;
  }
  const levels = xp > 0 ? await settleLevels(db, playerId, now) : [];
  return result(db, playerId, itemId, levels, now);
}

// ---- SOL (devnet) ------------------------------------------------------------------------------------

export async function solIntent(db: D1Database, playerId: string, itemId: string, treasury: string, now = Date.now()): Promise<ShopSolIntentResponse> {
  const item = shopItem(itemId);
  if (!item) fail(404, 'not_found', 'That item is not in the shop.');
  if (item.priceLamports === null) fail(400, 'bad_request', "That item isn't sold for SOL.");
  await assertNotOwned(db, playerId, item);
  const id = randomId('np-shop-', 12);
  const expires = now + INTENT_TTL_MS;
  await db
    .prepare('INSERT INTO shop_sol_intents (id, player_id, item_id, lamports, treasury, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id, playerId, item.id, item.priceLamports, treasury, now, expires)
    .run();
  return { intentId: id, lamports: item.priceLamports, treasury, memo: id, expiresAt: iso(expires) };
}

/** A parsed devnet transaction, as `getTransaction(sig, { encoding: 'jsonParsed' })` returns it. */
export type FetchParsedTx = (signature: string) => Promise<ParsedTx | null>;
interface ParsedIx {
  programId?: string;
  program?: string;
  parsed?: unknown;
}
export interface ParsedTx {
  meta?: { err: unknown } | null;
  blockTime?: number | null;
  transaction?: { message?: { instructions?: ParsedIx[] } };
}

/** Checks the transfer: no error, pays `treasury` ≥ lamports, carries the memo. Returns a reason it doesn't, or null. */
export function checkSolPayment(tx: ParsedTx | null, intent: { id: string; lamports: number; treasury: string }): string | null {
  if (!tx) return "That transaction isn't confirmed yet. Wait a moment and try again.";
  if (tx.meta?.err) return 'That transaction failed on chain.';
  const ixs = tx.transaction?.message?.instructions ?? [];
  let paid = 0;
  let memo = false;
  for (const ix of ixs) {
    const p = ix.parsed as { type?: string; info?: { destination?: string; lamports?: number } } | string | undefined;
    if ((ix.programId === SYSTEM_PROGRAM_ID || ix.program === 'system') && typeof p === 'object' && p?.type === 'transfer' && p.info?.destination === intent.treasury)
      paid += Number(p.info.lamports ?? 0);
    if ((ix.programId === MEMO_PROGRAM_ID || ix.program === 'spl-memo') && typeof p === 'string' && p.trim() === intent.id) memo = true;
  }
  if (!memo) return "That transaction isn't for this purchase.";
  if (paid < intent.lamports) return "That transaction didn't pay the full price.";
  return null;
}

/** Applies a SOL purchase once its devnet transfer checks out. Idempotent per intent; a signature settles one intent. */
export async function solConfirm(db: D1Database, playerId: string, intentId: string, signature: string, fetchTx: FetchParsedTx, now = Date.now()): Promise<ShopBuyResponse> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(signature)) fail(400, 'bad_request', 'Bad signature.');
  const intent = await db
    .prepare('SELECT id, item_id, lamports, treasury, expires_at, signature, done_at FROM shop_sol_intents WHERE id = ?1 AND player_id = ?2')
    .bind(intentId, playerId)
    .first<{ id: string; item_id: string; lamports: number; treasury: string; expires_at: number; signature: string | null; done_at: number | null }>();
  if (!intent) fail(404, 'not_found', 'Unknown purchase.');
  if (intent.done_at) {
    if (intent.signature !== signature) fail(409, 'conflict', 'This purchase was already paid.');
    return result(db, playerId, intent.item_id, [], now);
  }
  // The quote must be paid before it expires; the transaction's own time is checked when the chain reports it.
  const tx = await fetchTx(signature);
  const why = checkSolPayment(tx, intent);
  if (why) fail(409, 'conflict', why);
  if (tx?.blockTime && tx.blockTime * 1000 > intent.expires_at + 60_000) fail(409, 'expired', 'That purchase quote had expired. Start the purchase again.');
  const item = shopItem(intent.item_id);
  if (!item) fail(404, 'not_found', 'That item is no longer in the shop.');
  const xp = xpFor(item, (await balances(db, playerId)).xp);
  try {
    await db.batch([
      db.prepare('UPDATE shop_sol_intents SET signature = ?2, done_at = ?3 WHERE id = ?1 AND done_at IS NULL').bind(intent.id, signature, now),
      db.prepare("INSERT INTO shop_purchases (player_id, request_id, item_id, paid_with, created_at) VALUES (?1, ?2, ?3, 'sol', ?4) ON CONFLICT DO NOTHING").bind(playerId, intent.id, item.id, now),
      ...effectStatements(db, playerId, item, intent.id, xp, now),
    ]);
  } catch (err) {
    if (/UNIQUE constraint failed: shop_sol_intents.signature/i.test(String((err as Error)?.message ?? err))) fail(409, 'conflict', 'That transaction already paid for another purchase.');
    throw err;
  }
  const levels = xp > 0 ? await settleLevels(db, playerId, now) : [];
  return result(db, playerId, item.id, levels, now);
}

/** A devnet RPC reader for solConfirm. Refuses mainnet URLs (the shop is devnet-only). */
export function rpcFetchTx(rpcUrl: string, fetcher: typeof fetch = fetch): FetchParsedTx {
  if (/mainnet/i.test(rpcUrl)) throw new Error('shop: refusing a mainnet RPC');
  return async (signature) => {
    const res = await fetcher(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }),
    });
    if (!res.ok) fail(502, 'internal', 'The Solana network did not answer. Try again in a moment.');
    const body = (await res.json()) as { result?: ParsedTx | null; error?: unknown };
    return body.result ?? null;
  };
}
