import { Connection, PublicKey } from "@solana/web3.js";
import { programId } from "../config/solana.js";
import { createPool } from "../db/pool.js";

const LAMPORTS_PER_CHIP = 100_000n;

export async function startIndexer(connection: Connection) {
  const pid = programId();
  if (!pid) {
    console.warn(
      "[indexer] POKER_PROGRAM_ID not set — skipping log subscription. " +
        "Set it after `anchor deploy` to index on-chain events."
    );
    return;
  }

  const pool = createPool();

  connection.onLogs(pid, async (logs) => {
    if (logs.err) return;
    const sig = logs.signature;

    await pool.query(
      `INSERT INTO transactions (signature, kind, confirmed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (signature) DO NOTHING`,
      [sig, "ProgramLog"]
    );

    for (const line of logs.logs) {
      if (line.includes("SettlementNotZeroSum") || line.includes("chip_delta")) {
        console.warn("[indexer] anomaly log", sig, line);
      }
    }
  });

  console.log(`[indexer] listening on ${pid.toBase58()}`);
}

export async function checkSettlementAnomaly(
  tableId: string,
  deltas: { player: string; chipDelta: bigint }[],
  chipsInPlay: bigint
) {
  if (chipsInPlay === 0n) return;
  const maxGain = chipsInPlay / 2n;
  for (const d of deltas) {
    if (d.chipDelta > maxGain) {
      console.error(
        `[alert] outsized gain table=${tableId} player=${d.player} delta=${d.chipDelta}`
      );
    }
  }
}

export async function reconcileVault(
  connection: Connection,
  tableId: string,
  vaultPda: PublicKey,
  chipsInPlay: bigint,
  rentReserve: bigint
) {
  const balance = BigInt(await connection.getBalance(vaultPda));
  const expected = chipsInPlay * LAMPORTS_PER_CHIP + rentReserve;
  if (balance !== expected) {
    console.error(
      `[reconcile] drift table=${tableId} vault=${balance} expected=${expected}`
    );
    return false;
  }
  return true;
}
