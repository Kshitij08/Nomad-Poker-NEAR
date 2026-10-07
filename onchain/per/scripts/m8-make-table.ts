// Creates, delegates and opens a fresh 6-seat devnet table (deployer as creator) for the M8 client
// harness and the Unity client. Prints its address and id.
import { loadKey, programOn, teeConnection, randomTableId } from "./lib";
import { BN, sleep, tableApi } from "../tests/helpers";

(async () => {
  const deployer = loadKey("deployer");
  const id = randomTableId();
  const T = tableApi(deployer, id);
  await T.create({ smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false });
  await T.delegate();
  await sleep(4000);
  await T.open(programOn(await teeConnection(deployer), deployer), deployer.publicKey);
  console.log(JSON.stringify({ table: T.table.toBase58(), tableId: id.toString() }));
})().catch((e) => { console.error(e); process.exit(1); });
