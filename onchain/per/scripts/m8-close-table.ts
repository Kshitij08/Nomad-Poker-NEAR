// Closes a devnet test table as its creator (deployer): collects rake, closes (history stays
// private, the table returns to Solana with its last hand's public record). Usage: <tableId>
import { loadKey, programOn, teeConnection } from "./lib";
import { tableApi, tokenOf } from "../tests/helpers";
(async () => {
  const deployer = loadKey("deployer");
  const T = tableApi(deployer, BigInt(process.argv[2]));
  const prog = programOn(await teeConnection(deployer), deployer);
  console.log("table", T.table.toBase58());
  console.log("rake", await T.collectRake(prog, tokenOf(deployer.publicKey)).catch((e) => "none (" + String(e).slice(0, 60) + ")"));
  console.log("close", await T.close(prog, deployer.publicKey));
})().catch((e) => { console.error(e); process.exit(1); });
