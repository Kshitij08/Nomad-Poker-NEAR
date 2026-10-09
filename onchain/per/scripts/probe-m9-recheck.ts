// Re-checks the recipients of probe-m9-feasibility's deposits a while later.
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { connection, teeConnection } from "./lib";

(async () => {
  const tee = await teeConnection(Keypair.generate());
  for (const owner of process.argv.slice(2).map((s) => new PublicKey(s))) {
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
    const r = await tee.getAccountInfo(ata).catch((e) => String(e));
    const l1 = await connection.getAccountInfo(ata);
    console.log(owner.toBase58(), "rollup ATA", ata.toBase58(), r && typeof r === "object" ? { owner: r.owner.toBase58(), len: r.data.length } : r, "devnet:", l1 ? l1.owner.toBase58() : "none");
  }
})();
