// Reads a wallet's vault permission on Solana and in the rollup (byte 34: 0 = public, 1 = private).
import { Keypair, PublicKey } from "@solana/web3.js";
import { connection, loadKey, teeConnection } from "./lib";
import { openVaultAccounts } from "../client-web/vault";
(async () => {
  const a = openVaultAccounts(new PublicKey(process.argv[2]));
  const l1 = await connection.getAccountInfo(a.vaultPermission);
  console.log("permission", a.vaultPermission.toBase58());
  console.log("devnet:", l1 ? { owner: l1.owner.toBase58(), len: l1.data.length, byte34: l1.data[34] } : null);
  for (const [name, k] of [["deployer", loadKey("deployer")], ["fresh", Keypair.generate()]] as const) {
    const t = await (await teeConnection(k)).getAccountInfo(a.vaultPermission).catch((e) => String(e));
    console.log(`tee (${name} login):`, t && typeof t === "object" ? { owner: t.owner.toBase58(), len: t.data.length, byte34: t.data[34] } : t);
  }
  const esc = await (await teeConnection(loadKey("deployer"))).getAccountInfo(a.vaultEata).catch((e) => String(e));
  console.log("vault eata in tee:", esc && typeof esc === "object" ? { owner: esc.owner.toBase58(), len: esc.data.length } : esc);
})();
