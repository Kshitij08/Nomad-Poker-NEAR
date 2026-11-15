/**
 * The shop (Phase 3). The server is the only source of prices and effects; clients name an item.
 *
 * Only items the game honours are sold:
 *   - XP pack (+5,000 XP) and Level up (XP to the start of the next level): ledger XP, level rewards paid as usual.
 *   - 2× XP boosts (1 h / 24 h): hands recorded while the boost runs earn double XP (recordHand reads shop_boosts).
 *   - Card backs from the five room themes, worn at every table (owned_items `deck:<theme>`; the client equips one).
 *   - Coins (chip) packs are listed but not sold for Coins (priceCoins null; clients show "Coming soon").
 * Room themes are not sold: they'd change the room backgrounds, which stay as they are.
 *
 * Coins purchases are one atomic batch: the purchase row (keyed by the client's request id), the Coins debit, the
 * effect. A retry with the same request id changes nothing; an overdraft aborts the whole batch.
 */
import { PlayerLevelMath } from '@nomad/engine/retention/levels';
import { SHOP_ITEMS, type Balances, type ShopBuyResponse, type ShopCatalogResponse, type ShopItemInfo } from '@nomad/contract';

export { SHOP_ITEMS };
import { balances, conditionalPostingStatement, isInsufficientFunds } from './ledger';
import { settleLevels } from './progress';
import { fail, iso } from './util';

const HOUR = 3_600_000;

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

export async function catalog(db: D1Database, playerId: string, now = Date.now()): Promise<ShopCatalogResponse> {
  const until = await boostUntil(db, playerId, now);
  return { items: [...SHOP_ITEMS], owned: await ownedShopItems(db, playerId), xpBoostUntil: until ? iso(until) : null };
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
