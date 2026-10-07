// Simulates (never sends) an outsider attaching a permission to a table escrow's MagicBlock
// account, with flags 0xff and with flags 0, and prints the exact program errors/logs.
import { PublicKey, Transaction } from "@solana/web3.js";
import { createEataPermissionIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import { connection, loadKey } from "./lib";
import { escrowOf, ESPL } from "../tests/helpers";
import { NATIVE_MINT } from "@solana/spl-token";

async function main() {
  const table = new PublicKey(process.argv[2]);
  const p3 = loadKey("p3");
  const [eata] = PublicKey.findProgramAddressSync([table.toBuffer(), NATIVE_MINT.toBuffer()], ESPL);
  console.log("table", table.toBase58(), "escrow eATA", eata.toBase58(), "owner", (await connection.getAccountInfo(eata))?.owner.toBase58(), "escrow ATA", escrowOf(table).toBase58());
  for (const flags of [0xff, 0]) {
    const tx = new Transaction().add(createEataPermissionIx(eata, p3.publicKey, flags));
    tx.feePayer = p3.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(p3);
    const sim = await connection.simulateTransaction(tx);
    console.log(`flags=${flags}:`, JSON.stringify({ err: sim.value.err, logs: (sim.value.logs ?? []).filter((l) => /log|failed|error/i.test(l)).slice(0, 6) }));
  }
}
main();
