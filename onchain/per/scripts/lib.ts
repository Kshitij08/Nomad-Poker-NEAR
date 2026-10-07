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
