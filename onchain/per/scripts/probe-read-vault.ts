// Reads a wallet's game-vault token balance in the rollup (vault 0). Usage: probe-read-vault.ts <wallet>
import { Keypair, PublicKey } from "@solana/web3.js";
import { teeConnection } from "./lib";
import { vaultTokenOf } from "../client-web/vault";
(async () => {
  const tee = await teeConnection(Keypair.generate());
  const w = new PublicKey(process.argv[2]);
  console.log(await tee.getTokenAccountBalance(vaultTokenOf(w)).then((b) => b.value.amount).catch((e) => "ERR " + String(e.message).slice(0, 120)));
})();
