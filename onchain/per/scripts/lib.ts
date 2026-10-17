// Shared helpers for poker-per devnet scripts and tests. Keys live outside the repo in
// ~/.config/solana/poker-per/ (POKER_PER_KEYS overrides the folder).
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

export const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
export const connection = new Connection(RPC_URL, "confirmed");
export const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../idl/poker_per.json"), "utf8"));
export const PROGRAM_ID = new PublicKey(idl.address);
// client-web/vault.ts derives addresses with this program too (its web pages keep the live one).
process.env.PER_PROGRAM_ID ??= PROGRAM_ID.toBase58();
export const CONFIG_PDA = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];

export function loadKey(name: string): Keypair {
  const dir = process.env.POKER_PER_KEYS ?? path.join(os.homedir(), ".config/solana/poker-per");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"))));
}

export function programFor(payer: Keypair) {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  return new anchor.Program(idl, provider);
}

export const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

// ---- MagicBlock private rollup (TEE) access
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";

export const TEE_URL = "https://devnet-tee.magicblock.app";
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

/** Signs MagicBlock's login challenge and returns a connection to the TEE rollup for that wallet. */
export async function teeConnection(kp: Keypair): Promise<Connection> {
  const { token } = await getAuthToken(TEE_URL, kp.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, kp.secretKey)));
  return new Connection(`${TEE_URL}?token=${token}`, { commitment: "confirmed", wsEndpoint: `${TEE_URL.replace("https", "wss")}?token=${token}` });
}

export function programOn(conn: Connection, payer: Keypair) {
  return new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" }));
}

/** Table PDA: ["table", creator, table_id (u64 LE)]. */
export const tablePda = (creator: PublicKey, tableId: bigint) => {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(tableId);
  return PublicKey.findProgramAddressSync([Buffer.from("table"), creator.toBuffer(), b], PROGRAM_ID)[0];
};

/** A random u64 table id, so table addresses can't be predicted and claimed in advance. */
export const randomTableId = () => BigInt.asUintN(64, BigInt("0x" + Buffer.from(Keypair.generate().secretKey.subarray(0, 8)).toString("hex")));
