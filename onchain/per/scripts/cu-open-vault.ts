// M10: compute used by open_vault (it now reads the wallet state and derives the vault from its seed).
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { connection, loadKey, programFor } from "./lib";
import { sendL1 } from "../tests/helpers";
import { openVaultAccounts } from "../client-web/vault";
(async () => {
  const deployer = loadKey("deployer");
  const used: number[] = [];
  for (let i = 0; i < 6; i++) {
    const w = Keypair.generate();
    await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: w.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL })), [deployer]);
    const ix = await programFor(w).methods.openVault().accountsPartial(openVaultAccounts(w.publicKey)).instruction();
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix);
    tx.feePayer = w.publicKey; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const v = (await connection.simulateTransaction(tx)).value;
    used.push(v.unitsConsumed ?? -1);
  }
  console.log("open_vault compute units:", used.join(", "), "max", Math.max(...used));
})();
