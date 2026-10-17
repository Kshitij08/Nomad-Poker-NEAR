// What hosting a table costs its creator (the keeper), from devnet history: the keeper's SOL change in each
// create+delegate transaction, in the matching reclaim, and in everything else that touched the table. Read-only.
//   npx tsx scripts/host-cost.ts <keeper address> [how many recent transactions to scan, default 400]
import { PublicKey } from "@solana/web3.js";
import { connection } from "./lib";

async function main() {
  const keeper = new PublicKey(process.argv[2]);
  const limit = Number(process.argv[3] ?? 400);
  const sigs = await connection.getSignaturesForAddress(keeper, { limit });
  const created: { sig: string; delta: number; table: string }[] = [];
  const reclaimed: { sig: string; delta: number; table: string }[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    await new Promise((r) => setTimeout(r, 450)); // the public devnet RPC rate-limits getTransaction
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) continue;
    const logs = tx.meta.logMessages ?? [];
    const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
    const i = keys.indexOf(keeper.toBase58());
    if (i < 0) continue;
    const delta = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
    // The table is the third account of create_table (creator, config, table).
    if (logs.some((l) => l.includes("Instruction: CreateTable"))) created.push({ sig: s.signature, delta, table: keys[3] ?? "?" });
    if (logs.some((l) => l.includes("Instruction: ReclaimTable"))) reclaimed.push({ sig: s.signature, delta, table: keys[1] ?? "?" });
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  console.log(JSON.stringify({
    scanned: sigs.length,
    creates: created.length, avgCreate: avg(created.map((c) => c.delta)), minCreate: Math.min(...created.map((c) => c.delta)),
    reclaims: reclaimed.length, avgReclaim: avg(reclaimed.map((c) => c.delta)),
    examples: { created: created.slice(0, 3), reclaimed: reclaimed.slice(0, 3) },
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
