import { PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "../config/anchor.js";
import { createConnection, loadSettlementKeypair, programId } from "../config/solana.js";
import { loadEscrowIdl } from "../config/idl.js";
import { createPool } from "../db/pool.js";
import { checkSettlementAnomaly } from "./indexer.js";
import { syncTableFromChain } from "./chainSync.js";
import {
  deriveTablePdas,
  resolveTableIdBytes,
  tableIdToNumberArray,
} from "../utils/tableId.js";

const idl = loadEscrowIdl();

export type CreateTableRequest = {
  tableId: string | number[];
  hostPubkey: string;
  buyInLamports: number;
  smallBlindChips: number;
  bigBlindChips: number;
  maxSeats: number;
};

export type CreateTableResponse = {
  signature: string;
  tablePda: string;
  vaultPda: string;
};

export async function createTable(request: CreateTableRequest): Promise<CreateTableResponse> {
  const pid = programId();
  if (!pid) {
    throw new Error("POKER_PROGRAM_ID is required to create tables");
  }

  const tableIdBuf = resolveTableIdBytes(request.tableId);
  const tableIdArr = [...tableIdBuf];
  const { tablePda, vaultPda } = deriveTablePdas(pid, tableIdBuf);

  const connection = createConnection();
  const settlement = loadSettlementKeypair();
  const wallet = new Wallet(settlement);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl as any, provider);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);

  const sig = await (program.methods as any)
    .createTable(
      tableIdArr,
      new PublicKey(request.hostPubkey),
      new BN(request.buyInLamports),
      new BN(request.smallBlindChips),
      new BN(request.bigBlindChips),
      request.maxSeats
    )
    .accounts({
      settlementAuthority: settlement.publicKey,
      config: configPda,
      table: tablePda,
      vault: vaultPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const tableIdHex = tableIdBuf.toString("hex");
  const pool = createPool();
  await pool.query(
    `INSERT INTO transactions (signature, kind, table_id, confirmed_at)
     VALUES ($1, 'CreateTable', $2, NOW())
     ON CONFLICT (signature) DO NOTHING`,
    [sig, tableIdHex]
  );

  await syncTableFromChain(connection, tablePda, tableIdHex);

  return {
    signature: sig,
    tablePda: tablePda.toBase58(),
    vaultPda: vaultPda.toBase58(),
  };
}

export type CloseTableRequest = {
  tableId: string | number[];
  tablePda: string;
  vaultPda: string;
};

export async function closeTable(request: CloseTableRequest): Promise<string> {
  const tableIdBuf = resolveTableIdBytes(request.tableId);
  const tableIdArr = [...tableIdBuf];

  const connection = createConnection();
  const settlement = loadSettlementKeypair();
  const wallet = new Wallet(settlement);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl as any, provider);

  const sig = await (program.methods as any)
    .closeTable(tableIdArr)
    .accounts({
      settlementAuthority: settlement.publicKey,
      table: new PublicKey(request.tablePda),
      vault: new PublicKey(request.vaultPda),
    })
    .rpc();

  const pool = createPool();
  await pool.query(
    `INSERT INTO transactions (signature, kind, table_id, confirmed_at)
     VALUES ($1, 'CloseTable', $2, NOW())
     ON CONFLICT (signature) DO NOTHING`,
    [sig, tableIdBuf.toString("hex")]
  );

  return sig;
}

export type SettlementRequest = {
  tableId: number[];
  tablePda: string;
  vaultPda: string;
  nonce: number;
  potChips?: number;
  deltas: { player: string; chipDelta: number; seatPda: string }[];
  chipsInPlay: number;
  pendingSeatPdas?: string[];
};

export async function settleRound(request: SettlementRequest): Promise<string> {
  const connection = createConnection();
  const settlement = loadSettlementKeypair();
  const wallet = new Wallet(settlement);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl as any, provider);

  const sum = request.deltas.reduce((acc, d) => acc + d.chipDelta, 0);
  if (sum !== 0) {
    throw new Error("Settlement deltas must sum to zero");
  }

  await checkSettlementAnomaly(
    Buffer.from(request.tableId).toString("hex"),
    request.deltas.map((d) => ({ player: d.player, chipDelta: BigInt(d.chipDelta) })),
    BigInt(request.chipsInPlay)
  );

  const remainingAccounts = [
    ...request.deltas.map((d) => ({
      pubkey: new PublicKey(d.seatPda),
      isWritable: true,
      isSigner: false,
    })),
    ...(request.pendingSeatPdas ?? []).map((pda) => ({
      pubkey: new PublicKey(pda),
      isWritable: true,
      isSigner: false,
    })),
  ];

  const tableIdHex = Buffer.from(request.tableId).toString("hex");
  const tableAccount = await (program.account as any).table.fetch(
    new PublicKey(request.tablePda)
  );

  const sig = await (program.methods as any)
    .settleRound(
      request.tableId,
      new BN(request.nonce),
      request.deltas.map((d) => ({
        player: new PublicKey(d.player),
        chipDelta: new BN(d.chipDelta),
      }))
    )
    .accounts({
      settlementAuthority: settlement.publicKey,
      table: new PublicKey(request.tablePda),
      vault: new PublicKey(request.vaultPda),
    })
    .remainingAccounts(remainingAccounts)
    .rpc();

  const pool = createPool();
  await pool.query(
    `INSERT INTO tables (
       table_id, table_pda, vault_pda, host_pubkey,
       buy_in_lamports, rake_bps, small_blind_chips, big_blind_chips, max_seats
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (table_id) DO UPDATE SET
       table_pda = EXCLUDED.table_pda,
       vault_pda = EXCLUDED.vault_pda`,
    [
      tableIdHex,
      request.tablePda,
      request.vaultPda,
      tableAccount.host.toBase58(),
      tableAccount.buyInLamports.toNumber(),
      tableAccount.rakeBps,
      tableAccount.smallBlindChips.toNumber(),
      tableAccount.bigBlindChips.toNumber(),
      tableAccount.maxSeats,
    ]
  );

  await pool.query(
    `INSERT INTO rounds (table_id, round_nonce, pot_chips, deltas, settle_sig)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (table_id, round_nonce) DO NOTHING`,
    [
      Buffer.from(request.tableId).toString("hex"),
      request.nonce,
      request.potChips ?? null,
      JSON.stringify(request.deltas),
      sig,
    ]
  );

  await pool.query(
    `INSERT INTO transactions (signature, kind, table_id, confirmed_at)
     VALUES ($1, 'Settle', $2, NOW())
     ON CONFLICT (signature) DO NOTHING`,
    [sig, Buffer.from(request.tableId).toString("hex")]
  );

  return sig;
}

export type BeginRoundRequest = {
  tableId: number[];
  tablePda: string;
};

export async function beginRound(request: BeginRoundRequest): Promise<string> {
  const connection = createConnection();
  const settlement = loadSettlementKeypair();
  const wallet = new Wallet(settlement);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl as any, provider);

  const sig = await (program.methods as any)
    .beginRound(request.tableId)
    .accounts({
      settlementAuthority: settlement.publicKey,
      table: new PublicKey(request.tablePda),
    })
    .rpc();

  const pool = createPool();
  await pool.query(
    `INSERT INTO transactions (signature, kind, table_id, confirmed_at)
     VALUES ($1, 'BeginRound', $2, NOW())
     ON CONFLICT (signature) DO NOTHING`,
    [sig, Buffer.from(request.tableId).toString("hex")]
  );

  return sig;
}

export type CashOutPlayerRequest = {
  tableId: string | number[];
  tablePda: string;
  vaultPda: string;
  seatPda: string;
  playerWallet: string;
};

/** Server-signed cash-out (default leave path after request_leave + hand completion). */
export async function cashOutPlayer(params: CashOutPlayerRequest): Promise<string> {
  const tableIdBuf = resolveTableIdBytes(params.tableId);
  const tableIdArr = [...tableIdBuf];

  const connection = createConnection();
  const settlement = loadSettlementKeypair();
  const wallet = new Wallet(settlement);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl as any, provider);

  const sig = await (program.methods as any)
    .cashOut(tableIdArr)
    .accounts({
      payer: settlement.publicKey,
      table: new PublicKey(params.tablePda),
      vault: new PublicKey(params.vaultPda),
      seat: new PublicKey(params.seatPda),
      playerWallet: new PublicKey(params.playerWallet),
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const pool = createPool();
  await pool.query(
    `INSERT INTO transactions (signature, kind, table_id, confirmed_at)
     VALUES ($1, 'CashOut', $2, NOW())
     ON CONFLICT (signature) DO NOTHING`,
    [sig, tableIdBuf.toString("hex")]
  );

  return sig;
}

/** @deprecated Use cashOutPlayer */
export async function cashOutDisconnectedPlayer(params: {
  tableId: number[];
  tablePda: string;
  vaultPda: string;
  seatPda: string;
  playerWallet: string;
  payer: string;
}) {
  return cashOutPlayer({
    tableId: params.tableId,
    tablePda: params.tablePda,
    vaultPda: params.vaultPda,
    seatPda: params.seatPda,
    playerWallet: params.playerWallet,
  });
}

export { tableIdToNumberArray };
