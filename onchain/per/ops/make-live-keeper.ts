// Creates the live private-tables backend's keeper key (once, next to the devnet keys, outside the repo; never
// printed) and funds it from the deployer with devnet SOL for table rent.
// Usage (from per/): npx tsx ops/make-live-keeper.ts <keysDir> <SOL>
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import fs from "fs";
import path from "path";

async function main() {
  const [keysDir, sol] = process.argv.slice(2);
  const file = path.join(keysDir, "live-keeper.json");
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(keysDir, "deployer.json"), "utf8"))));
  const l1 = new Connection("https://api.devnet.solana.com", "confirmed");
  const want = Math.round(Number(sol) * LAMPORTS_PER_SOL);
  const have = await l1.getBalance(keeper.publicKey);
  if (have < want) {
    await sendAndConfirmTransaction(l1, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: keeper.publicKey, lamports: want - have })), [deployer]);
  }
  console.log(`live keeper ${keeper.publicKey.toBase58()}: ${(await l1.getBalance(keeper.publicKey)) / LAMPORTS_PER_SOL} SOL`);
}
main().catch((e) => { console.error(e); process.exit(1); });
