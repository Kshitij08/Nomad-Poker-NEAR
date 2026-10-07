// M7 one-time setup on devnet: funds the backend's keeper wallet and makes the backend's auditor
// key the config's auditor (admin = deployer). Safe to rerun.
import { LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { connection, loadKey, programFor, CONFIG_PDA } from "./lib";
import { sendL1 } from "../tests/helpers";

async function main() {
  const deployer = loadKey("deployer"), keeper = loadKey("keeper"), auditor = loadKey("auditor");
  const bal = await connection.getBalance(keeper.publicKey);
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: keeper.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL - bal })), [deployer]);
  }
  const l1 = programFor(deployer);
  const cfg: any = await (l1.account as any).config.fetch(CONFIG_PDA);
  if (!cfg.auditor.equals(auditor.publicKey)) await l1.methods.setAuditor(auditor.publicKey).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc();
  const after: any = await (l1.account as any).config.fetch(CONFIG_PDA);
  console.log(JSON.stringify({ keeper: keeper.publicKey.toBase58(), keeperSol: (await connection.getBalance(keeper.publicKey)) / LAMPORTS_PER_SOL, auditor: after.auditor.toBase58() }));
}
main().catch((e) => { console.error(e); process.exit(1); });
