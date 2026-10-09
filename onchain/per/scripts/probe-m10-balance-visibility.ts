// M10 review M2: can a stranger's rollup login read token balances of game vaults and table escrows? (M8 saw 0
// for non-owners.) Writes results/m10-balance-visibility-<ts>.json.
import { Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { teeConnection } from "./lib";
import { escrowOf } from "../tests/helpers";
import { vaultTokenOf } from "../client-web/vault";
(async () => {
  const [table, wallet] = process.argv.slice(2).map((a) => new PublicKey(a));
  const stranger = await teeConnection(Keypair.generate());
  const read = async (k: PublicKey) => ({
    getTokenAccountBalance: await stranger.getTokenAccountBalance(k).then((b) => b.value.amount).catch((e) => "ERR " + String(e.message).slice(0, 80)),
    getAccountInfoAmount: await stranger.getAccountInfo(k).then((a) => (a && a.data.length >= 72 ? a.data.readBigUInt64LE(64).toString() : a ? `len ${a.data.length}` : "null")).catch((e) => "ERR " + String(e.message).slice(0, 80)),
  });
  const out = { ranAt: new Date().toISOString(), tableEscrow: { address: escrowOf(table).toBase58(), ...(await read(escrowOf(table))) }, gameVault: { address: vaultTokenOf(wallet).toBase58(), ...(await read(vaultTokenOf(wallet))) } };
  console.log(JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(__dirname, "../results", `m10-balance-visibility-${Date.now()}.json`), JSON.stringify(out, null, 2));
})();
