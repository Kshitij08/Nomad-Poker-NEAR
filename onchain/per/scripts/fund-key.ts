// Creates a devnet key file (solana-keygen format) if it doesn't exist, and tops it up from the deployer.
// The key is never printed, only its address. Usage: npx tsx scripts/fund-key.ts <keyFile> <deployerKeyFile> <SOL>
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import fs from "fs";
import path from "path";

async function main() {
  const [file, deployerFile, sol] = process.argv.slice(2);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  }
  const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(deployerFile, "utf8"))));
  const l1 = new Connection("https://api.devnet.solana.com", "confirmed");
  const want = Math.round(Number(sol) * LAMPORTS_PER_SOL);
  const have = await l1.getBalance(key.publicKey);
  if (have < want) {
    await sendAndConfirmTransaction(l1, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: key.publicKey, lamports: want - have })), [deployer]);
  }
  console.log(`${key.publicKey.toBase58()}: ${(await l1.getBalance(key.publicKey)) / LAMPORTS_PER_SOL} SOL`);
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
