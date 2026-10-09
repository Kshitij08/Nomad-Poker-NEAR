// M9c: what a stranger's rollup login sees of the private-invite transactions (set list, buy-ins with a code).
import { Keypair } from "@solana/web3.js";
import { teeConnection } from "./lib";
(async () => {
  const stranger = Keypair.generate();
  const conn = await teeConnection(stranger);
  for (const [name, sig] of process.argv.slice(2).map((a) => a.split("="))) {
    const tx: any = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch((e: any) => ({ error: String(e.message ?? e).slice(0, 100) }));
    if (!tx || tx.error) { console.log(name, "->", tx?.error ?? "null"); continue; }
    const m = tx.transaction.message;
    const ixs = (m.compiledInstructions ?? m.instructions).map((i: any) => ({ program: i.programIdIndex, dataBytes: (i.data?.length ?? 0) }));
    console.log(name, "-> visible. accounts:", (m.staticAccountKeys ?? m.accountKeys).length, "instructions:", JSON.stringify(ixs), "logs:", tx.meta?.logMessages?.length ?? 0);
  }
})();
