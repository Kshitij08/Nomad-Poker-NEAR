// Real experiment: does an outsider's flags-0 permission on a table escrow's MagicBlock account
// break the table? Create table -> outsider attaches permission -> delegate/open -> buy-in ->
// cash-out -> rake -> close. Writes results/escrow-permission-effect-<ts>.json.
import { Transaction } from "@solana/web3.js";
import { createEataPermissionIx, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";
import path from "path";
import { connection, loadKey, programOn, teeConnection, randomTableId } from "./lib";
import { BN, Suite, sleep, tableApi, sendL1, tokenOf } from "../tests/helpers";

const S = new Suite("escrow-permission-effect");
async function main() {
  const deployer = loadKey("deployer"), p2 = loadKey("p2"), p3 = loadKey("p3");
  const erD = programOn(await teeConnection(deployer), deployer), erP2 = programOn(await teeConnection(p2), p2);
  const T = tableApi(deployer, randomTableId());
  await S.ok("create table", () => T.create({ smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false }));
  await S.ok("outsider (p3) attaches a flags-0 permission to the table's escrow account", () => sendL1(new Transaction().add(createEataPermissionIx(T.escrowEata, p3.publicKey, 0)), [p3]));
  const perm = await connection.getAccountInfo(permissionPdaFromAccount(T.escrowEata));
  S.check("the permission account now exists on L1", !!perm, { owner: perm?.owner.toBase58(), bytes: perm?.data.length });
  await S.ok("delegate", () => T.delegate());
  await sleep(4000);
  await S.ok("open", () => T.open(erD, deployer.publicKey));
  await S.ok("p2 buys in", () => T.buyIn(erP2, p2.publicKey, 0, 2_000_000n));
  await S.ok("p2 cashes out", () => T.cashOut(erP2, p2.publicKey, 0));
  await S.ok("collect rake", () => T.collectRake(erD, tokenOf(deployer.publicKey)));
  await S.ok("close", () => T.close(erD, deployer.publicKey));
  S.finish({ table: T.table.toBase58() });
}
main().catch((e) => { console.error(e); process.exit(1); });
