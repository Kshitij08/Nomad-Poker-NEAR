// Simulates `commit_table` for one table as a given key (e.g. a keeper) and prints the program logs.
// Usage: npx tsx scripts/probe-commit.ts <keypair.json> <table>
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getAuthToken, DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import fs from "fs";
import idl from "../idl/poker_per.json";

const TEE = "https://devnet-tee.magicblock.app";
async function main() {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))));
  const table = new PublicKey(process.argv[3]);
  const { token } = await getAuthToken(TEE, kp.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, kp.secretKey)));
  const conn = new Connection(`${TEE}?token=${token}`, "confirmed");
  const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" }));
  const feeVault = PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo").toBuffer()], DELEGATION_PROGRAM_ID)[0];
  const tx = await program.methods.commitTable().accountsPartial({ payer: kp.publicKey, table, magicFeeVault: feeVault } as any).transaction();
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(kp);
  const sim = await conn.simulateTransaction(tx);
  console.log(JSON.stringify({ err: sim.value.err, logs: sim.value.logs?.slice(-12) }, null, 1));
  console.log("payer in rollup:", await conn.getBalance(kp.publicKey));
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
