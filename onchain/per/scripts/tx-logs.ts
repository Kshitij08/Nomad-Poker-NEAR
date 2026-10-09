// Prints a devnet transaction's program logs, token balance changes and accounts.
import { connection } from "./lib";
(async () => {
  const t = await connection.getTransaction(process.argv[2], { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!t) { console.log("not found"); return; }
  console.log((t.meta?.logMessages ?? []).filter((l) => !l.includes("consumed")).join("\n"));
  const keys = t.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
  for (const b of t.meta?.postTokenBalances ?? []) {
    const pre = t.meta?.preTokenBalances?.find((p) => p.accountIndex === b.accountIndex)?.uiTokenAmount.amount ?? "0";
    console.log("token", keys[b.accountIndex], "owner", b.owner, pre, "->", b.uiTokenAmount.amount);
  }
})();
