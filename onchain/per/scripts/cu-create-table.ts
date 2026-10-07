// Measures create_table's compute use across random table ids (simulation only, nothing is sent).
// Anchor finds every PDA bump in the instruction by search, and the search cost depends on the id,
// so the total varies from table to table. Usage: npx tsx scripts/cu-create-table.ts [samples]
import { ComputeBudgetProgram } from "@solana/web3.js";
import { connection, loadKey, randomTableId } from "./lib";
import { BN, tableApi } from "../tests/helpers";

async function main() {
  const deployer = loadKey("deployer");
  const n = Number(process.argv[2] ?? 30);
  const params = { smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false };
  const used: number[] = [];
  for (let i = 0; i < n; i++) {
    const T = tableApi(deployer, randomTableId());
    const tx = await T.createTx(params);
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx.feePayer = deployer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(deployer);
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) { console.log("sim error", JSON.stringify(sim.value.err), (sim.value.logs ?? []).slice(-3)); continue; }
    used.push(sim.value.unitsConsumed!);
  }
  used.sort((a, b) => a - b);
  const over = used.filter((u) => u > 200_000).length;
  console.log(JSON.stringify({ samples: used.length, min: used[0], median: used[used.length >> 1], max: used[used.length - 1], over200k: over, all: used }));
}
main().catch((e) => { console.error(e); process.exit(1); });
