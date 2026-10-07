// After a deploy: does the TEE rollup run a build that has instruction <name>? Simulates calling it
// with no accounts. 101 (InstructionFallbackNotFound) = the TEE still runs an older build; any
// other error (normally 3005, not enough accounts) = the instruction exists. Simulation only.
// Usage: npx tsx scripts/tee-has-instruction.ts <snake_case_name> [poll every N s] [for M min]
import { Transaction, TransactionInstruction, Connection } from "@solana/web3.js";
import { createHash } from "crypto";
import { connection, loadKey, teeConnection, PROGRAM_ID } from "./lib";

async function code(c: Connection, name: string) {
  const payer = loadKey("deployer");
  const tx = new Transaction().add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [], data: createHash("sha256").update(`global:${name}`).digest().subarray(0, 8) }));
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const sim = await c.simulateTransaction(tx);
  return (sim.value.err as any)?.InstructionError?.[1]?.Custom ?? JSON.stringify(sim.value.err);
}

async function main() {
  const [name, every = "0", minutes = "0"] = process.argv.slice(2);
  const er = await teeConnection(loadKey("deployer"));
  const end = Date.now() + Number(minutes) * 60_000;
  do {
    const r = { at: new Date().toISOString(), l1: await code(connection, name), tee: await code(er, name) };
    console.log(JSON.stringify({ ...r, teeHasIt: r.tee !== 101 }));
    if (r.tee !== 101 || !Number(every)) break;
    await new Promise((res) => setTimeout(res, Number(every) * 1000));
  } while (Date.now() < end);
}
main().catch((e) => { console.error(e); process.exit(1); });
