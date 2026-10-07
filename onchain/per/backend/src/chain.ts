// Solana and TEE rollup access: connections, the program, PDAs and the rollup login.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, getAuthToken, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import idl from "./shared/poker_per.json";
import { config } from "./config";

export const PROGRAM_ID = new PublicKey((idl as any).address);
export const CONFIG_PDA = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
export const l1 = new Connection(config.l1Url, "confirmed");
// Anchor's Program converts the IDL's names to camelCase ("table", "handLog", "lastRecord"); the
// coder is taken from a Program (with a read-only provider) so names match the scripts and tests.
const readOnly = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(l1, new anchor.Wallet(Keypair.generate()), {}));
export const coder = readOnly.coder.accounts as anchor.BorshAccountsCoder;

const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const rollupPrograms = { magicProgram: MAGIC_PROGRAM_ID, vault: EPHEMERAL_VAULT, permissionProgram: PERMISSION_PROGRAM_ID };
export const MAGIC_FEE_VAULT = PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()], DELEGATION_PROGRAM_ID)[0];

const pda = (tag: string, t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(tag), t.toBuffer()], PROGRAM_ID)[0];
export const accountsOf = (table: PublicKey) => {
  const ledger = pda("ledger", table), deck = pda("deck", table), record = pda("record", table), log = pda("log", table);
  return { table, ledger, deck, record, log, logPermission: permissionPdaFromAccount(log) };
};

/**
 * A rollup connection logged in as `kp`. The token is refreshed every 10 minutes (and on demand
 * after an auth error), so a long-running service never holds an expired login.
 */
export class TeeSession {
  private conn: Connection | null = null;
  private at = 0;
  constructor(readonly kp: Keypair) {}
  async get(force = false): Promise<Connection> {
    if (force || !this.conn || Date.now() - this.at > 10 * 60_000) {
      const { token } = await getAuthToken(config.teeUrl, this.kp.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, this.kp.secretKey)));
      this.conn = new Connection(`${config.teeUrl}?token=${token}`, { commitment: "confirmed", wsEndpoint: `${config.teeUrl.replace("https", "wss")}?token=${token}` });
      this.at = Date.now();
    }
    return this.conn;
  }
  async program(): Promise<anchor.Program> {
    return new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(await this.get(), new anchor.Wallet(this.kp), { commitment: "confirmed" }));
  }
}

/** A public (no login) rollup connection, for public accounts only. */
export const teePublic = new Connection(config.teeUrl, "confirmed");

export type PublicTable = {
  address: string; tableId: string; creator: string; status: number; maxSeats: number; seated: number; inviteOnly: boolean;
  smallBlind: string; bigBlind: string; minBuyIn: string; maxBuyIn: string; handNo: string; handState: number; ledgerSeq: string;
  lastCommitTs: number; turnDeadline: number; lastRecordHandNo: string;
};

export function toPublic(address: PublicKey, t: any): PublicTable {
  return {
    address: address.toBase58(), tableId: t.tableId.toString(), creator: t.creator.toBase58(), status: t.status, maxSeats: t.maxSeats,
    seated: (t.seatMask as number).toString(2).split("").filter((c) => c === "1").length, inviteOnly: t.inviteOnly,
    smallBlind: t.smallBlind.toString(), bigBlind: t.bigBlind.toString(), minBuyIn: t.minBuyIn.toString(), maxBuyIn: t.maxBuyIn.toString(),
    handNo: t.handNo.toString(), handState: t.handState, ledgerSeq: t.ledgerSeq.toString(), lastCommitTs: Number(t.lastCommitTs),
    turnDeadline: Number(t.turnDeadline), lastRecordHandNo: t.lastRecord.handNo.toString(),
  };
}
