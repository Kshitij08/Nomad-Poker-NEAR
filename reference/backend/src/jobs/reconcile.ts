import "../config/env.js";
import { PublicKey } from "@solana/web3.js";
import { createConnection } from "../config/solana.js";
import { createPool } from "../db/pool.js";
import { reconcileVault } from "../services/indexer.js";

const LAMPORTS_PER_CHIP = 100_000n;

async function main() {
  const connection = createConnection();
  const pool = createPool();
  const { rows } = await pool.query(`SELECT table_id, vault_pda FROM tables`);

  for (const row of rows) {
    const chipsResult = await pool.query(
      `SELECT COALESCE(SUM(chips), 0) AS chips FROM seats WHERE table_id = $1`,
      [row.table_id]
    );
    const chipsInPlay = BigInt(chipsResult.rows[0].chips);
    const rentReserve = 890880n; // approximate; read from chain in production
    await reconcileVault(
      connection,
      row.table_id,
      new PublicKey(row.vault_pda),
      chipsInPlay,
      rentReserve
    );
  }

  console.log("[reconcile] complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
