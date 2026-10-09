// Where does MagicBlock's delegation record keep the validator? Reads the record of an account known
// to be delegated to the TEE validator (a vault's token account) and finds the validator's bytes.
import { PublicKey } from "@solana/web3.js";
import { connection, TEE_VALIDATOR } from "./lib";
import { openVaultAccounts } from "../client-web/vault";
(async () => {
  const a = openVaultAccounts(new PublicKey(process.argv[2]));
  for (const [name, rec] of [["vault token account", a.vaultDelegationRecord], ["its permission", a.vaultPermissionDelegationRecord]] as const) {
    const info = await connection.getAccountInfo(rec);
    const d = info!.data, v = TEE_VALIDATOR.toBuffer();
    const at = [...Array(d.length - 31).keys()].filter((i) => d.subarray(i, i + 32).equals(v));
    console.log(name, "record", rec.toBase58(), "len", d.length, "validator at", at, "owner", info!.owner.toBase58());
  }
})();
