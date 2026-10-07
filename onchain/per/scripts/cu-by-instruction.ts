// Compute units actually used by this program's recent L1 transactions, grouped by instruction.
// Usage: npx tsx scripts/cu-by-instruction.ts [how many recent transactions, default 150] [tee]
// With "tee", reads the TEE rollup instead, logged in as the deployer.
import { Connection } from "@solana/web3.js";
import { connection as l1, loadKey, PROGRAM_ID, teeConnection } from "./lib";

async function main() {
  const n = Number(process.argv[2] ?? 150);
  const connection: Connection = process.argv[3] === "tee" ? await teeConnection(loadKey("deployer")) : l1;
  const sigs = await connection.getSignaturesForAddress(PROGRAM_ID, { limit: n });
  const by: Record<string, number[]> = {};
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    const name = (tx?.meta?.logMessages ?? []).find((l) => l.startsWith("Program log: Instruction: "))?.slice(26) ?? "?";
    (by[name] ??= []).push(tx?.meta?.computeUnitsConsumed ?? 0);
  }
  for (const [k, v] of Object.entries(by)) console.log(k.padEnd(28), `n=${v.length}`.padEnd(6), `max=${Math.max(...v)}`, `min=${Math.min(...v)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
