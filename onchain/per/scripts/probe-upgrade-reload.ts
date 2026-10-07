// Does the TEE rollup pick up program upgrades? Simulates a call to a throwaway program that fails
// with Custom(VERSION), on L1 and in the TEE, and prints which version each one runs.
// Usage: npx tsx scripts/probe-upgrade-reload.ts <program id> [repeat every N s] [for M min] [stop at version]
import { PublicKey, Transaction, TransactionInstruction, Connection } from "@solana/web3.js";
import { connection, loadKey, teeConnection } from "./lib";

async function versionOn(c: Connection, program: PublicKey) {
  const payer = loadKey("deployer");
  const tx = new Transaction().add(new TransactionInstruction({ programId: program, keys: [], data: Buffer.alloc(0) }));
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const sim = await c.simulateTransaction(tx);
  return (sim.value.err as any)?.InstructionError?.[1]?.Custom ?? JSON.stringify(sim.value.err);
}

async function main() {
  const program = new PublicKey(process.argv[2]);
  const every = Number(process.argv[3] ?? 0), minutes = Number(process.argv[4] ?? 0), stopAt = process.argv[5];
  const er = await teeConnection(loadKey("deployer"));
  const end = Date.now() + minutes * 60_000;
  do {
    const r = { at: new Date().toISOString(), l1: await versionOn(connection, program), tee: await versionOn(er, program) };
    console.log(JSON.stringify(r));
    if (!every || String(r.tee) === stopAt) break;
    await new Promise((res) => setTimeout(res, every * 1000));
  } while (Date.now() < end);
}
main().catch((e) => { console.error(e); process.exit(1); });
