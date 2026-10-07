// Diagnostic for the M4 upgrade problem: calls the `ping` instruction of the M3+ping build on L1
// and in the TEE (simulation only). 6037 = that build runs; 101 = instruction unknown (other build).
// Usage: npx tsx scripts/probe-ping.ts [repeat every N s] [for M min]
import { Transaction, TransactionInstruction, Connection } from "@solana/web3.js";
import { createHash } from "crypto";
import { connection, loadKey, teeConnection, PROGRAM_ID } from "./lib";

async function codeOn(c: Connection) {
  const payer = loadKey("deployer");
  const data = createHash("sha256").update("global:ping").digest().subarray(0, 8);
  const tx = new Transaction().add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [], data }));
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const sim = await c.simulateTransaction(tx);
  return (sim.value.err as any)?.InstructionError?.[1]?.Custom ?? JSON.stringify(sim.value.err);
}

async function main() {
  const every = Number(process.argv[2] ?? 0), minutes = Number(process.argv[3] ?? 0);
  const er = await teeConnection(loadKey("deployer"));
  const end = Date.now() + minutes * 60_000;
  do {
    const r = { at: new Date().toISOString(), l1: await codeOn(connection), tee: await codeOn(er) };
    console.log(JSON.stringify(r));
    if (!every || r.tee === 6037) break;
    await new Promise((res) => setTimeout(res, every * 1000));
  } while (Date.now() < end);
}
main().catch((e) => { console.error(e); process.exit(1); });
