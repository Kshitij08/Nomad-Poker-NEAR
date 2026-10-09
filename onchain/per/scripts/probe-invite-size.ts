// Rent of an L1 invite list and what close_invites returned (M9c test check).
import { connection } from "./lib";
import { invitesOf } from "../tests/helpers";
import { PublicKey } from "@solana/web3.js";
(async () => {
  const t = new PublicKey(process.argv[2]);
  const sigs = await connection.getSignaturesForAddress(invitesOf(t), { limit: 5 });
  for (const s of sigs) {
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    console.log(s.signature.slice(0, 12), "fee", tx?.meta?.fee, "pre/post payer", tx?.meta?.preBalances[0], tx?.meta?.postBalances[0], "invites", tx?.meta?.preBalances, tx?.meta?.postBalances);
  }
  console.log("rent for 553:", await connection.getMinimumBalanceForRentExemption(553));
})();
