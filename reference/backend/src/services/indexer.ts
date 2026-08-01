import { Connection, PublicKey } from "@solana/web3.js";
import { programId } from "../config/solana.js";
import { createPool } from "../db/pool.js";
import { syncSeatsForTable, syncTableFromChain } from "./chainSync.js";

const INSTRUCTION_KINDS = new Map<string, string>([
  ["InitializeTable", "InitializeTable"],
  ["BuyIn", "BuyIn"],
  ["Rebuy", "Rebuy"],
  ["BeginRound", "BeginRound"],
  ["SettleRound", "SettleRound"],
  ["RequestLeave", "RequestLeave"],
  ["CashOut", "CashOut"],
  ["SweepAbandonedSeat", "SweepAbandonedSeat"],
  ["CloseTable", "CloseTable"],
]);

/** Table account index in the instruction's account metas (after program id lookup). */
const TABLE_ACCOUNT_INDEX: Record<string, number> = {
  InitializeTable: 2,
  BuyIn: 2,
  Rebuy: 2,
  BeginRound: 1,
  SettleRound: 1,
  RequestLeave: 1,
  CashOut: 1,
  SweepAbandonedSeat: 1,
  CloseTable: 1,
};

/** Player signer index in the instruction's account metas. */
const PLAYER_ACCOUNT_INDEX: Record<string, number> = {
  InitializeTable: 0,
  BuyIn: 0,
  Rebuy: 0,
};

const RAKE_KINDS = new Set(["InitializeTable", "BuyIn", "Rebuy"]);

const SYNC_KINDS = new Set([
  "InitializeTable",
  "BuyIn",
  "Rebuy",
  "BeginRound",
  "SettleRound",
  "CashOut",
  "SweepAbandonedSeat",
  "CloseTable",
]);

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
    const kind = parseInstructionKind(logs.logs) ?? "Unknown";

    try {
      await pool.query(
        `INSERT INTO transactions (signature, kind, confirmed_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (signature) DO UPDATE SET kind = EXCLUDED.kind`,
        [sig, kind]
      );

      if (SYNC_KINDS.has(kind)) {
        const tablePda = await extractTablePda(connection, sig, kind);
        if (tablePda) {
          const tableIdHex = await fetchTableIdHex(connection, tablePda);
          if (tableIdHex) {
            await pool.query(
              `UPDATE transactions SET table_id = $2 WHERE signature = $1`,
              [sig, tableIdHex]
            );
            await syncTableFromChain(connection, tablePda, tableIdHex);
            if (RAKE_KINDS.has(kind)) {
              await recordRakeEvent(connection, pool, sig, kind, tablePda, tableIdHex);
            }
          }
        }
      }

      for (const line of logs.logs) {
        if (line.includes("SettlementNotZeroSum") || line.includes("chip_delta")) {
          console.warn("[indexer] anomaly log", sig, line);
        }
      }
    } catch (err) {
      console.error("[indexer] failed to index", sig, err);
    }
  });

  console.log(`[indexer] listening on ${pid.toBase58()}`);
}

function parseInstructionKind(logLines: string[]): string | null {
  for (const line of logLines) {
    const match = line.match(/Instruction:\s*(\w+)/);
    if (match) {
      return INSTRUCTION_KINDS.get(match[1]) ?? match[1];
    }
  }
  return null;
}

async function extractTablePda(
  connection: Connection,
  signature: string,
  kind: string
): Promise<PublicKey | null> {
  const tableIndex = TABLE_ACCOUNT_INDEX[kind];
  if (tableIndex === undefined) {
    return null;
  }

  const pid = programId();
  if (!pid) {
    return null;
  }

  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.transaction) {
    return null;
  }

  const message = tx.transaction.message;
  const accountKeys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });

  for (const ix of message.compiledInstructions) {
    const programKey = accountKeys.get(ix.programIdIndex);
    if (!programKey || !programKey.equals(pid)) {
      continue;
    }

    const tableKeyIndex = ix.accountKeyIndexes[tableIndex];
    if (tableKeyIndex === undefined) {
      continue;
    }

    return accountKeys.get(tableKeyIndex) ?? null;
  }

  return null;
}

async function fetchTableIdHex(connection: Connection, tablePda: PublicKey): Promise<string | null> {
  const info = await connection.getAccountInfo(tablePda);
  if (!info?.data || info.data.length < 8 + 32 + 32 + 32) {
    return null;
  }

  // Table layout: discriminator (8) + host (32) + settlement_authority (32) + table_id (32)
  const tableIdBytes = info.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32);
  return Buffer.from(tableIdBytes).toString("hex");
}

async function recordRakeEvent(
  connection: Connection,
  pool: ReturnType<typeof createPool>,
  signature: string,
  kind: string,
  tablePda: PublicKey,
  tableIdHex: string
) {
  const { rows } = await pool.query(`SELECT 1 FROM rake_events WHERE signature = $1`, [signature]);
  if (rows.length > 0) {
    return;
  }

  const player = await extractAccountPubkey(connection, signature, kind, PLAYER_ACCOUNT_INDEX);
  if (!player) {
    return;
  }

  const info = await connection.getAccountInfo(tablePda);
  if (!info?.data || info.data.length < 8 + 32 + 32 + 32 + 8 + 2) {
    return;
  }

  // buy_in_lamports at offset 104 (after disc + host + settlement + table_id)
  const buyInLamports = info.data.readBigUInt64LE(104);
  const rakeBps = info.data.readUInt16LE(112);
  const rakeLamports = (buyInLamports * BigInt(rakeBps)) / 10_000n;
  if (rakeLamports <= 0n) {
    return;
  }

  await pool.query(
    `INSERT INTO rake_events (signature, table_id, player_pubkey, rake_lamports, rake_bps)
     VALUES ($1, $2, $3, $4, $5)`,
    [signature, tableIdHex, player.toBase58(), rakeLamports.toString(), rakeBps]
  );
}

async function extractAccountPubkey(
  connection: Connection,
  signature: string,
  kind: string,
  indexMap: Record<string, number>
): Promise<PublicKey | null> {
  const accountIndex = indexMap[kind];
  if (accountIndex === undefined) {
    return null;
  }

  const pid = programId();
  if (!pid) {
    return null;
  }

  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.transaction) {
    return null;
  }

  const message = tx.transaction.message;
  const accountKeys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });

  for (const ix of message.compiledInstructions) {
    const programKey = accountKeys.get(ix.programIdIndex);
    if (!programKey || !programKey.equals(pid)) {
      continue;
    }

    const keyIndex = ix.accountKeyIndexes[accountIndex];
    if (keyIndex === undefined) {
      continue;
    }

    return accountKeys.get(keyIndex) ?? null;
  }

  return null;
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
  const LAMPORTS_PER_CHIP = 100_000n;
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
