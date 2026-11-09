/** The on-chain SOL tables the game server opened (migration 0009). The escrow program holds the money. */

export type EscrowTableState = 'creating' | 'open' | 'closing' | 'closed' | 'failed';

export interface EscrowTableRow {
  table_id: string;
  room: string;
  authority: string;
  buy_in: number;
  state: EscrowTableState;
  hands: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export async function recordEscrowTable(db: D1Database, row: { tableId: string; room: string; authority: string; buyInLamports: number }, now = Date.now()): Promise<void> {
  await db
    .prepare(`INSERT INTO escrow_tables (table_id, room, authority, buy_in, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'creating', ?5, ?5)`)
    .bind(row.tableId, row.room, row.authority, row.buyInLamports, now)
    .run();
}

export async function setEscrowTableState(db: D1Database, tableId: string, state: EscrowTableState, error: string | null = null, now = Date.now()): Promise<void> {
  await db.prepare(`UPDATE escrow_tables SET state = ?2, last_error = ?3, updated_at = ?4 WHERE table_id = ?1`).bind(tableId, state, error, now).run();
}

export async function countEscrowHand(db: D1Database, tableId: string, now = Date.now()): Promise<void> {
  await db.prepare(`UPDATE escrow_tables SET hands = hands + 1, updated_at = ?2 WHERE table_id = ?1`).bind(tableId, now).run();
}

/** Tables not closed yet (open, or stuck creating/closing), oldest update first. */
export async function unclosedEscrowTables(db: D1Database, limit = 50): Promise<EscrowTableRow[]> {
  return (await db.prepare(`SELECT * FROM escrow_tables WHERE state IN ('creating', 'open', 'closing') ORDER BY updated_at LIMIT ?1`).bind(limit).all<EscrowTableRow>()).results;
}

/** The wallet a player signed in with, or null (a guest, or a Google / email account). */
export async function walletOf(db: D1Database, playerId: string): Promise<string | null> {
  const r = await db.prepare(`SELECT subject FROM identities WHERE player_id = ?1 AND provider = 'wallet' ORDER BY created_at LIMIT 1`).bind(playerId).first<{ subject: string }>();
  return r?.subject ?? null;
}
