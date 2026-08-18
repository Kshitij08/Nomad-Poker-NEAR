import { Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "../config/anchor.js";
import { loadEscrowIdl } from "../config/idl.js";
import { createConnection, programId } from "../config/solana.js";
import { createPool } from "../db/pool.js";
import { cashOutPlayer, closeTable } from "./settlement.js";
import type { ChainTableAccount } from "./tableRead.js";

const idl = loadEscrowIdl();

/** Mirrors STALE_ROUND_SECS on chain, plus a margin so we never race a live host's settle. */
const STALE_ROUND_SECS = 600;
const STALE_MARGIN_SECS = 300;

/** A table idle this long with players still seated is treated as abandoned (host gone for good). */
const ABANDONED_TABLE_SECS = Number(process.env.SWEEP_ABANDONED_SECS ?? 6 * 3600);

/**
 * Empty lobby tables (dedicated VPS money rooms) stay open until this idle window.
 * `create_table` leaves `last_settlement_ts` at 0, so idle must be measured from `created_at`.
 * Set `SWEEP_EMPTY_SECS=0` to never auto-close empty tables.
 */
const EMPTY_TABLE_SECS = Number(process.env.SWEEP_EMPTY_SECS ?? 24 * 3600);

type SeatRow = { player: string; seatPda: string };

function createReadProgram() {
  const connection = createConnection();
  const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {
    commitment: "confirmed",
  });
  return { connection, program: new Program(idl as any, provider) };
}

async function listChainSeats(tablePda: PublicKey): Promise<SeatRow[]> {
  const pid = programId()!;
  const { connection, program } = createReadProgram();

  const seatDisc = (idl.accounts as { name: string; discriminator: number[] }[]).find(
    (a) => a.name === "Seat"
  )!.discriminator;

  const accounts = await connection.getProgramAccounts(pid, {
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from(seatDisc).toString("base64"), encoding: "base64" } },
      { memcmp: { offset: 8, bytes: tablePda.toBase58() } },
    ],
  });

  const rows: SeatRow[] = [];
  for (const { pubkey } of accounts) {
    const seat = await (program.account as any).seat.fetch(pubkey);
    rows.push({ player: seat.player.toBase58(), seatPda: pubkey.toBase58() });
  }
  return rows;
}

/**
 * Recovers dead money tables without any client involvement: every seat on a table whose host has
 * clearly vanished is cashed out by the settlement authority (cash_out always pays seat.player, so
 * absent players are safe), then the empty table is closed to reclaim rent.
 *
 * A table is swept when, on chain, either:
 *  - a round is stuck active well past the stale window (host died mid-hand), or
 *  - it has been idle with seated players far longer than any real game pauses.
 * Empty, round-free tables are closed only after {@link EMPTY_TABLE_SECS} — a dedicated
 * lobby is empty by design until the first buy-in.
 */
export async function sweepStaleTables(): Promise<void> {
  const pool = createPool();
  const { program } = createReadProgram();
  const now = Math.floor(Date.now() / 1000);

  const { rows: tables } = await pool.query<{
    table_id: string;
    table_pda: string;
    vault_pda: string;
    created_at: Date | string;
  }>(`SELECT table_id, table_pda, vault_pda, created_at FROM tables WHERE state IS DISTINCT FROM 'closed'`);

  for (const row of tables) {
    try {
      const tablePda = new PublicKey(row.table_pda);
      const table = (await (program.account as any).table.fetchNullable(
        tablePda
      )) as ChainTableAccount | null;

      if (!table) {
        await pool.query(`UPDATE tables SET state = 'closed' WHERE table_id = $1`, [row.table_id]);
        continue;
      }

      const lastSettle = table.lastSettlementTs.toNumber();
      const createdAt = Math.floor(new Date(row.created_at).getTime() / 1000);
      const lastActive = Math.max(lastSettle > 0 ? lastSettle : 0, Number.isFinite(createdAt) ? createdAt : 0);
      const idle = now - lastActive;
      const stuckRound = table.roundActive && idle > STALE_ROUND_SECS + STALE_MARGIN_SECS;
      const abandoned = !table.roundActive && table.seatedCount > 0 && idle > ABANDONED_TABLE_SECS;
      const emptyIdle =
        table.seatedCount === 0 &&
        !table.roundActive &&
        EMPTY_TABLE_SECS > 0 &&
        idle >= EMPTY_TABLE_SECS;

      if (stuckRound || abandoned) {
        console.log(
          `[sweep] table ${row.table_id} ${stuckRound ? "stuck mid-round" : "abandoned"} ` +
            `(idle ${idle}s, ${table.seatedCount} seats) — cashing everyone out`
        );
        const seats = await listChainSeats(tablePda);
        for (const seat of seats) {
          try {
            const sig = await cashOutPlayer({
              tableId: [...Buffer.from(row.table_id, "hex")],
              tablePda: row.table_pda,
              vaultPda: row.vault_pda,
              seatPda: seat.seatPda,
              playerWallet: seat.player,
            });
            console.log(`[sweep]   cashed out ${seat.player}: ${sig}`);
          } catch (err: any) {
            console.warn(`[sweep]   cash-out failed for ${seat.player}: ${err.message ?? err}`);
          }
        }
      }

      if (stuckRound || abandoned || emptyIdle) {
        try {
          const sig = await closeTable({
            tableId: [...Buffer.from(row.table_id, "hex")],
            tablePda: row.table_pda,
            vaultPda: row.vault_pda,
          });
          console.log(`[sweep] closed table ${row.table_id}: ${sig}`);
          await pool.query(`UPDATE tables SET state = 'closed' WHERE table_id = $1`, [row.table_id]);
        } catch {
          // Not empty yet (a cash-out failed, or a round is still flagged active) — next run finishes it.
        }
      }
    } catch (err: any) {
      console.warn(`[sweep] table ${row.table_id} skipped: ${err.message ?? err}`);
    }
  }
}
