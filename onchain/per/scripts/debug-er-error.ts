// Debug: what does the TEE rollup return for a rejected transaction? (preflight vs. sent)
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { CONFIG_PDA, loadKey, programOn, teeConnection } from "./lib";

async function main() {
  const table = new PublicKey(process.argv[2]);
  const p3 = loadKey("p3");
  const conn = await teeConnection(p3);
  const prog = programOn(conn, p3);
  const accts = { player: p3.publicKey, table, playerToken: getAssociatedTokenAddressSync(NATIVE_MINT, p3.publicKey), escrow: getAssociatedTokenAddressSync(NATIVE_MINT, table, true) };
  try { await prog.methods.cashOut().accountsPartial(accts).rpc(); }
  catch (e: any) {
    console.log("rpc() error type:", e?.constructor?.name, "keys:", Object.keys(e ?? {}));
    console.log("message:", JSON.stringify(e?.message), "logs:", JSON.stringify(e?.logs ?? e?.transactionLogs));
    console.log("raw:", JSON.stringify(e, Object.getOwnPropertyNames(e ?? {})).slice(0, 800));
  }
  const tx = await prog.methods.cashOut().accountsPartial(accts).transaction();
  tx.feePayer = p3.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(p3);
  const sim = await conn.simulateTransaction(tx);
  console.log("simulate:", JSON.stringify(sim.value).slice(0, 600));
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await conn.confirmTransaction(sig, "confirmed");
  console.log("sent with skipPreflight:", sig, "err:", JSON.stringify(conf.value.err));
}
main();
