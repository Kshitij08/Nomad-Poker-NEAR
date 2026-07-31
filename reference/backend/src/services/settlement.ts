import { PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "../config/anchor.js";
import { createConnection, loadSettlementKeypair } from "../config/solana.js";
import { loadEscrowIdl } from "../config/idl.js";
import { createPool } from "../db/pool.js";
import { checkSettlementAnomaly } from "./indexer.js";

const idl = loadEscrowIdl();

export type SettlementRequest = {
  tableId: number[];
  tablePda: string;
  vaultPda: string;
  nonce: number;
  potChips?: number;
  deltas: { player: string; chipDelta: number; seatPda: string }[];
  chipsInPlay: number;
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

  const remainingAccounts = request.deltas.map((d) => ({
    pubkey: new PublicKey(d.seatPda),
    isWritable: true,
    isSigner: false,
  }));

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

export async function cashOutDisconnectedPlayer(params: {
  tableId: number[];
  tablePda: string;
  vaultPda: string;
  seatPda: string;
  playerWallet: string;
  payer: string;
}) {
  const connection = createConnection();
  const settlement = loadSettlementKeypair();
  const wallet = new Wallet(settlement);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl as any, provider);

  return (program.methods as any)
    .cashOut(params.tableId)
    .accounts({
      payer: settlement.publicKey,
      table: new PublicKey(params.tablePda),
      vault: new PublicKey(params.vaultPda),
      seat: new PublicKey(params.seatPda),
      playerWallet: new PublicKey(params.playerWallet),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}
