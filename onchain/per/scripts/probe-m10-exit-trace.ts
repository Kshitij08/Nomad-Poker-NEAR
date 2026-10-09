// M10: where did a vault_exit's money go? Prints the exit transaction's accounts with their owners and wSOL
// balances on Solana now, the transaction's logs, and the vault's balance in the rollup.
import { Keypair, PublicKey } from "@solana/web3.js";
import { connection, teeConnection } from "./lib";
import { vaultTokenOf } from "../client-web/vault";
(async () => {
  const [sig, walletArg] = process.argv.slice(2);
  const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const keys = tx!.transaction.message.staticAccountKeys;
  console.log("logs:", (tx!.meta!.logMessages ?? []).filter((l) => !l.includes("consumed")).slice(-14).join("\n  "));
  for (const k of keys) {
    const a = await connection.getAccountInfo(k);
    const bal = await connection.getTokenAccountBalance(k).then((b) => b.value.amount).catch(() => "-");
    console.log(k.toBase58().padEnd(45), (a?.owner.toBase58() ?? "none").slice(0, 12).padEnd(13), "lamports", String(a?.lamports ?? 0).padEnd(10), "token", bal);
  }
  const tee = await teeConnection(Keypair.generate());
  console.log("vault in rollup:", await tee.getTokenAccountBalance(vaultTokenOf(new PublicKey(walletArg))).then((b) => b.value.amount).catch((e) => String(e.message).slice(0, 60)));
})();
