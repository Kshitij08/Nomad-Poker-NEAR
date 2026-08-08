/**
 * One-off maintenance: backfill rake_events from player_ledger and fix stale seat/table rows.
 *
 *   cd backend && npm run db:backfill
 *
 * Uses DATABASE_URL from backend/.env (Railway public URL works from your machine).
 */
import "../config/env.js";
import pg from "pg";
import { formatConnectionTarget, getPgConfig } from "../db/config.js";

const DEV_TABLE_2_HEX =
  "6465762d7461626c652d32000000000000000000000000000000000000000000";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required in backend/.env");
  }

  const client = new pg.Client(getPgConfig());
  await client.connect();
  console.log(`Connected to ${formatConnectionTarget(databaseUrl)}`);

  try {
    const rake = await client.query(
      `INSERT INTO rake_events (signature, table_id, player_pubkey, rake_lamports, rake_bps, collected_at)
       SELECT
         'backfill-' || pl.id::text,
         pl.table_id,
         pl.player_pubkey,
         pl.net_rake_paid_lamports,
         COALESCE(t.rake_bps, 500),
         pl.updated_at
       FROM player_ledger pl
       LEFT JOIN tables t ON t.table_id = pl.table_id
       WHERE pl.net_rake_paid_lamports > 0
         AND NOT EXISTS (
           SELECT 1 FROM rake_events re
           WHERE re.table_id = pl.table_id
             AND re.player_pubkey = pl.player_pubkey
         )`,
    );
    console.log(`rake_events: inserted ${rake.rowCount ?? 0} row(s)`);

    const seats = await client.query(
      `UPDATE seats
       SET status = 'left', chips = 0
       WHERE table_id = $1 AND status <> 'left'`,
      [DEV_TABLE_2_HEX]
    );
    console.log(`seats (dev-table-2): updated ${seats.rowCount ?? 0} row(s)`);

    const tables = await client.query(
      `UPDATE tables SET state = 'empty' WHERE table_id = $1`,
      [DEV_TABLE_2_HEX]
    );
    console.log(`tables (dev-table-2): updated ${tables.rowCount ?? 0} row(s)`);

    const summary = await client.query(
      `SELECT table_id, SUM(rake_lamports) AS total_rake FROM rake_events GROUP BY table_id`
    );
    console.log("rake summary:", summary.rows);

    const seatRows = await client.query(`SELECT table_id, player_pubkey, status, chips FROM seats`);
    console.log("seats:", seatRows.rows);
  } finally {
    await client.end();
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
