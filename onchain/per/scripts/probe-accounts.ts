// Shows whether accounts exist on the TEE and on devnet, and who owns them.
import { Keypair, PublicKey } from "@solana/web3.js";
import { connection, teeConnection } from "./lib";
(async () => {
  const tee = await teeConnection(Keypair.generate());
  for (const a of process.argv.slice(2)) {
    const k = new PublicKey(a);
    const [t, l] = await Promise.all([tee.getAccountInfo(k).catch((e) => String(e).slice(0, 80)), connection.getAccountInfo(k)]);
    const fmt = (x: any) => (x && typeof x === "object" ? `${x.owner.toBase58().slice(0, 8)} len=${x.data.length} lamports=${x.lamports}` : String(x));
    console.log(a.slice(0, 8), "| tee:", fmt(t), "| devnet:", fmt(l));
  }
})();
