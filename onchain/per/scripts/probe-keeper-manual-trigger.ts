// Is the table's Hydra crank valid? Acts as the cranker ourselves: sends Hydra `Trigger` followed by
// the scheduled `tick` in one transaction. If it lands, the crank (and tick) work, and a crank that
// never runs on its own means no cranker serves this rollup. Writes results/keeper-manual-<ts>.json.
import { ComputeBudgetProgram, Transaction, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY, sendAndConfirmTransaction } from "@solana/web3.js";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { loadKey, programFor, programOn, teeConnection, randomTableId } from "./lib";
import { BN, errName, sleep, tableApi, tokenOf, HYDRA_EPHEMERAL, MAGIC_FEE_VAULT, MAGIC_CONTEXT_ID, rollup } from "../tests/helpers";
import { MAGIC_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1"), p2 = loadKey("p2");
  const er = { d: await teeConnection(deployer), p1: await teeConnection(p1), p2: await teeConnection(p2) };
  const prog = { d: programOn(er.d, deployer), p1: programOn(er.p1, p1), p2: programOn(er.p2, p2) };
  const coder = programFor(deployer).coder.accounts as any;
  const T = tableApi(deployer, randomTableId());
  await T.create({ smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false });
  await T.delegate(); await sleep(4000);
  await T.open(prog.d, deployer.publicKey);
  await T.buyIn(prog.p1, p1.publicKey, 0, 2_000_000n);
  await T.buyIn(prog.p2, p2.publicKey, 2, 2_000_000n);
  await T.scheduleKeeper(prog.d, deployer.publicKey, 100, 0, 0);
  await T.commitSeed(prog.p1, p1.publicKey, 0, randomBytes(32));
  await T.commitSeed(prog.p2, p2.publicKey, 2, randomBytes(32));
  await T.startHand(prog.d, deployer.publicKey);
  for (let i = 0; i < 100; i++) { if (coder.decode("table", (await er.d.getAccountInfo(T.table, "processed"))!.data).handState === 2) break; await sleep(100); }
  const executed = async () => Number((await er.d.getAccountInfo(T.crank))!.data.readBigUInt64LE(32 + 32 + 8 + 8 + 8 + 8));
  const out: any = { table: T.table.toBase58(), crank: T.crank.toBase58(), executedBefore: await executed() };
  const tickIx = await prog.d.methods.tick().accountsPartial({
    hand: { table: T.table, ledger: T.ledger, deck: T.deck, record: T.record, log: T.log, magicFeeVault: MAGIC_FEE_VAULT, magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID },
    logPermission: permissionPdaFromAccount(T.log), rollup,
  } as any).instruction();
  const trigger = new TransactionInstruction({ programId: HYDRA_EPHEMERAL, keys: [
    { pubkey: T.crank, isSigner: false, isWritable: true }, { pubkey: deployer.publicKey, isSigner: true, isWritable: true }, { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ], data: Buffer.from([1]) });
  try {
    out.manualTrigger = await sendAndConfirmTransaction(er.d, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), trigger, tickIx), [deployer], { skipPreflight: true });
  } catch (e) { out.manualTrigger = "FAILED " + errName(e) + " " + String((e as any)?.message ?? e).slice(0, 300); }
  await sleep(2000);
  const t = coder.decode("table", (await er.d.getAccountInfo(T.table))!.data);
  out.executedAfter = await executed();
  out.handStateAfter = t.handState; // 3 = PLAYING: tick began the hand
  out.crankValid = out.executedAfter === out.executedBefore + 1 && t.handState === 3;
  await T.cancelKeeper(prog.d, deployer.publicKey).catch(() => {});
  for (let i = 0; i < 20 && coder.decode("table", (await er.d.getAccountInfo(T.table))!.data).handState !== 0; i++) { await T.tick(prog.d).catch(() => {}); await sleep(3000); }
  await T.cashOut(prog.p1, p1.publicKey, 0).catch(() => {}); await T.cashOut(prog.p2, p2.publicKey, 2).catch(() => {});
  await T.collectRake(prog.d, tokenOf(deployer.publicKey)).catch(() => {}); await T.close(prog.d, deployer.publicKey).catch(() => {});
  const file = path.join(__dirname, "../results", `keeper-manual-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
