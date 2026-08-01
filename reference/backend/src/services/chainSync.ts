import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "../config/anchor.js";
import { loadEscrowIdl } from "../config/idl.js";
import { programId } from "../config/solana.js";
import { createPool } from "../db/pool.js";

const idl = loadEscrowIdl();

function seatDiscriminator(): Buffer {
  const seat = (idl.accounts as { name: string; discriminator: number[] }[]).find(
    (account) => account.name === "Seat"
  );
  if (!seat?.discriminator?.length) {
    throw new Error("Seat discriminator missing from IDL");
  }
  return Buffer.from(seat.discriminator);
}

const TABLE_FIELD_OFFSET = 8;

type SeatAccount = {
  table: PublicKey;
  player: PublicKey;
  chips: { toNumber(): number };
  depositedLamports: { toNumber(): number };
  rakePaidLamports: { toNumber(): number };
  status: Record<string, unknown>;
};

type TableAccount = {
  host: PublicKey;
  buyInLamports: { toNumber(): number };
  rakeBps: number;
  smallBlindChips: { toNumber(): number };
  bigBlindChips: { toNumber(): number };
  maxSeats: number;
  seatedCount: number;
  chipsInPlay: { toNumber(): number };
  roundNonce: { toNumber(): number };
  roundActive: boolean;
};

function seatStatusLabel(status: Record<string, unknown>): string {
  const key = Object.keys(status)[0];
  return key ?? "active";
}

function createProgram(connection: Connection) {
  const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {
    commitment: "confirmed",
  });
  return new Program(idl as any, provider);
}

export async function syncTableFromChain(connection: Connection, tablePda: PublicKey, tableIdHex: string) {
  const program = createProgram(connection);
  const table = (await (program.account as any).table.fetch(tablePda)) as TableAccount;
  const vaultPda = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(tableIdHex, "hex")],
    programId()!
  )[0];

  const pool = createPool();
  await pool.query(
    `INSERT INTO tables (
       table_id, table_pda, vault_pda, host_pubkey,
       buy_in_lamports, rake_bps, small_blind_chips, big_blind_chips, max_seats,
       state
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (table_id) DO UPDATE SET
       table_pda = EXCLUDED.table_pda,
       vault_pda = EXCLUDED.vault_pda,
       host_pubkey = EXCLUDED.host_pubkey,
       buy_in_lamports = EXCLUDED.buy_in_lamports,
       rake_bps = EXCLUDED.rake_bps,
       small_blind_chips = EXCLUDED.small_blind_chips,
       big_blind_chips = EXCLUDED.big_blind_chips,
       max_seats = EXCLUDED.max_seats`,
    [
      tableIdHex,
      tablePda.toBase58(),
      vaultPda.toBase58(),
      table.host.toBase58(),
      table.buyInLamports.toNumber(),
      table.rakeBps,
      table.smallBlindChips.toNumber(),
      table.bigBlindChips.toNumber(),
      table.maxSeats,
      table.roundActive ? "round_active" : "open",
    ]
  );

  await syncSeatsForTable(connection, tablePda, tableIdHex);
}

export async function syncSeatsForTable(
  connection: Connection,
  tablePda: PublicKey,
  tableIdHex: string
) {
  const pid = programId();
  if (!pid) {
    return;
  }

  const program = createProgram(connection);
  const accounts = await connection.getProgramAccounts(pid, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: seatDiscriminator().toString("base64"),
          encoding: "base64",
        },
      },
      { memcmp: { offset: TABLE_FIELD_OFFSET, bytes: tablePda.toBase58() } },
    ],
  });

  const pool = createPool();
  const activePlayers = new Set<string>();

  for (const { pubkey } of accounts) {
    const seat = (await (program.account as any).seat.fetch(pubkey)) as SeatAccount;
    const player = seat.player.toBase58();
    const status = seatStatusLabel(seat.status);
    activePlayers.add(player);

    await pool.query(
      `INSERT INTO seats (
         table_id, player_pubkey, seat_pda, chips, deposited_lamports, rake_paid_lamports, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (table_id, player_pubkey) DO UPDATE SET
         seat_pda = EXCLUDED.seat_pda,
         chips = EXCLUDED.chips,
         deposited_lamports = EXCLUDED.deposited_lamports,
         rake_paid_lamports = EXCLUDED.rake_paid_lamports,
         status = EXCLUDED.status`,
      [
        tableIdHex,
        player,
        pubkey.toBase58(),
        seat.chips.toNumber(),
        seat.depositedLamports.toNumber(),
        seat.rakePaidLamports.toNumber(),
        status,
      ]
    );

    await pool.query(
      `INSERT INTO player_ledger (
         table_id, player_pubkey, chips, net_deposited_lamports, net_rake_paid_lamports, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (table_id, player_pubkey) DO UPDATE SET
         chips = EXCLUDED.chips,
         net_deposited_lamports = EXCLUDED.net_deposited_lamports,
         net_rake_paid_lamports = EXCLUDED.net_rake_paid_lamports,
         updated_at = NOW()`,
      [
        tableIdHex,
        player,
        seat.chips.toNumber(),
        seat.depositedLamports.toNumber(),
        seat.rakePaidLamports.toNumber(),
      ]
    );
  }

  if (activePlayers.size > 0) {
    await pool.query(
      `UPDATE seats SET status = 'left'
       WHERE table_id = $1 AND player_pubkey <> ALL($2::text[]) AND status <> 'left'`,
      [tableIdHex, [...activePlayers]]
    );
  }
}

export function tableIdHexFromBytes(bytes: number[] | Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
