// Traces a deposit: the transaction's result and logs on Solana, the wallet's state, and its game vault in the rollup.
import { Keypair, PublicKey } from "@solana/web3.js";
import { connection, teeConnection } from "./lib";
import { decodeWalletState, vaultOf, vaultTokenOf, walletStateOf } from "../client-web/vault";
(async () => {
  const [sig, walletArg] = process.argv.slice(2);
  const w = new PublicKey(walletArg);
  const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  console.log("tx err:", JSON.stringify(tx?.meta?.err), "slot", tx?.slot, "time", tx?.blockTime && new Date(tx.blockTime * 1000).toISOString());
  console.log((tx?.meta?.logMessages ?? []).filter((l) => /log:|failed|error/i.test(l)).slice(0, 25).join("\n"));
  const st = decodeWalletState((await connection.getAccountInfo(walletStateOf(w)))?.data);
  console.log("wallet state:", JSON.stringify(st));
  const tee = await teeConnection(Keypair.generate());
  for (const seed of [null, st.vaultSeed]) {
    const vt = vaultTokenOf(w, seed);
    console.log("vault", vaultOf(w, seed).toBase58(), "token", vt.toBase58(), "rollup balance:", await tee.getTokenAccountBalance(vt).then((b) => b.value.amount).catch((e) => "ERR " + String(e.message).slice(0, 70)));
  }
  console.log("wallet SOL:", (await connection.getBalance(w)) / 1e9);
})();
