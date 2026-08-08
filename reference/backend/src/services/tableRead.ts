import { Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "../config/anchor.js";
import { loadEscrowIdl } from "../config/idl.js";
import { createConnection, programId } from "../config/solana.js";
import { deriveTablePdas, tableIdFromString } from "../utils/tableId.js";

const idl = loadEscrowIdl();

/** Anchor-decoded Table account (BN fields exposed via toNumber()). */
export type ChainTableAccount = {
  host: PublicKey;
  settlementAuthority: PublicKey;
  buyInLamports: { toNumber(): number };
  rakeBps: number;
  smallBlindChips: { toNumber(): number };
  bigBlindChips: { toNumber(): number };
  maxSeats: number;
  seatedCount: number;
  chipsInPlay: { toNumber(): number };
  roundNonce: { toNumber(): number };
  roundActive: boolean;
  lastSettlementTs: { toNumber(): number };
};

export type ResolvedTable = {
  table: ChainTableAccount;
  tableIdBuf: Buffer;
  tablePda: PublicKey;
  vaultPda: PublicKey;
};

/** table_id must be a short printable ascii string that fits the 32-byte seed. */
const TABLE_ID_RE = /^[\x21-\x7e]{1,32}$/;

export function isValidTableIdString(id: string): boolean {
  return TABLE_ID_RE.test(id) && Buffer.byteLength(id, "utf8") <= 32;
}

export function deriveSeatPda(pid: PublicKey, tableIdBuf: Buffer, player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("seat"), tableIdBuf, player.toBuffer()],
    pid
  )[0];
}

/** Fetch a table account by its string id; null when the table PDA doesn't exist. */
export async function fetchTableByIdString(tableIdStr: string): Promise<ResolvedTable | null> {
  const pid = programId();
  if (!pid) {
    throw new Error("POKER_PROGRAM_ID is required");
  }

  const tableIdBuf = tableIdFromString(tableIdStr);
  const { tablePda, vaultPda } = deriveTablePdas(pid, tableIdBuf);

  const connection = createConnection();
  const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {
    commitment: "confirmed",
  });
  const program = new Program(idl as any, provider);

  const table = (await (program.account as any).table.fetchNullable(
    tablePda
  )) as ChainTableAccount | null;
  if (!table) {
    return null;
  }

  return { table, tableIdBuf, tablePda, vaultPda };
}
