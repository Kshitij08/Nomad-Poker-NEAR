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
  pendingChipsInPlay: { toNumber(): number };
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

/**
 * Every seat on this table that is holding mid-round buy-in chips.
 *
 * settle_round refuses to finish while `pending_chips_in_play > 0`, and the only way to drain it is
 * to hand it the seat account for each of those buy-ins. The host sends the list it knows about, but
 * it builds that list from its own roster before the settle goes out, so a buy-in that confirms a
 * moment later is invisible to it — and to every one of its retries, which resend the same accounts.
 * Reading the seats here instead makes each settle attempt use what the chain holds right now.
 */
export async function listSeatPdasWithPendingChips(tablePda: PublicKey): Promise<string[]> {
  const pid = programId();
  if (!pid) {
    throw new Error("POKER_PROGRAM_ID is required");
  }

  const seatDisc = (idl.accounts as { name: string; discriminator: number[] }[]).find(
    (account) => account.name === "Seat"
  )?.discriminator;
  if (!seatDisc?.length) {
    throw new Error("Seat discriminator missing from IDL");
  }

  const connection = createConnection();
  const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {
    commitment: "confirmed",
  });
  const program = new Program(idl as any, provider);

  const accounts = await connection.getProgramAccounts(pid, {
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from(seatDisc).toString("base64"), encoding: "base64" } },
      { memcmp: { offset: SEAT_TABLE_FIELD_OFFSET, bytes: tablePda.toBase58() } },
    ],
  });

  const pending: string[] = [];
  for (const { pubkey } of accounts) {
    const seat = (await (program.account as any).seat.fetch(pubkey)) as {
      pendingChips: { toNumber(): number };
    };
    if (seat.pendingChips.toNumber() > 0) {
      pending.push(pubkey.toBase58());
    }
  }
  return pending;
}

/** Seat.table sits directly after the 8-byte account discriminator. */
const SEAT_TABLE_FIELD_OFFSET = 8;
