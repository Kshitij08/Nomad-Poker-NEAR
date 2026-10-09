// Can the rollup still return a table's escrow permission and deck? Reads them for a table created
// and checked before 9 Oct (when the enclave restarted), with the creator's login and with none.
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { loadKey, teeConnection, TEE_URL } from "./lib";
import { ESPL, deckOf, rawRead } from "../tests/helpers";
import fs from "fs";
(async () => {
  const table = new PublicKey(process.argv[2]);
  const eata = PublicKey.findProgramAddressSync([table.toBuffer(), NATIVE_MINT.toBuffer()], ESPL)[0];
  const perm = permissionPdaFromAccount(eata);
  const tee = await teeConnection(loadKey("deployer"));
  const out: any = { table: table.toBase58(), at: new Date().toISOString() };
  for (const [name, k] of [["escrowPermission", perm], ["deck", deckOf(table)], ["table", table]] as const) {
    const withLogin = await tee.getAccountInfo(k).catch((e) => String(e));
    const noLogin = await rawRead(TEE_URL, k).catch((e) => String(e));
    out[name] = { address: k.toBase58(), creatorLogin: withLogin && typeof withLogin === "object" ? { owner: withLogin.owner.toBase58(), len: withLogin.data.length } : withLogin, noLogin };
  }
  fs.writeFileSync(`results/rollup-reads-${Date.now()}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})();
