// Experiment: can the table pay for its own commits (as a delegated fee payer), lifting MagicBlock's
// 10-commit limit for accounts without one? 12 rounds of: change the table (a rebuy bumps its
// ledger_seq), commit, then wait and read the table's L1 copy. Each round records whether the
// commit was accepted (with the error logs if not) and whether L1 caught up with the change.
// Writes results/commit-fee-payer-<ts>.json.
import { PublicKey, SendTransactionError } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { connection, loadKey, programFor, programOn, teeConnection, TEE_VALIDATOR, randomTableId } from "./lib";
import { BN, errName, sleep, tableApi, tokenOf } from "../tests/helpers";

const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1");
  const er = await teeConnection(deployer);
  const prog = programOn(er, deployer), progP1 = programOn(await teeConnection(p1), p1);
  const coder = programFor(deployer).coder.accounts as any;
  const [feeVault] = PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()], DLP);
  const T = tableApi(deployer, randomTableId());
  await T.create({ smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false });
  await T.delegate(); await sleep(4000);
  await T.open(prog, deployer.publicKey);
  await T.buyIn(progP1, p1.publicKey, 0, 2_000_000n);
  const out: any = { table: T.table.toBase58(), feeVault: feeVault.toBase58(), before: { tableLamports: await er.getBalance(T.table), feeVault: await er.getBalance(feeVault) }, rounds: [] };
  for (let i = 1; i <= 12; i++) {
    const r: any = { n: i };
    await T.buyIn(progP1, p1.publicKey, 0, 200_000n); // a rebuy changes the table (ledger_seq, ledger_hash)
    r.rollupSeq = Number(coder.decode("table", (await er.getAccountInfo(T.table))!.data).ledgerSeq);
    try { r.sig = await T.commit(prog, deployer.publicKey); r.accepted = true; }
    catch (e: any) { r.accepted = false; r.error = errName(e); r.logs = e instanceof SendTransactionError ? (await e.getLogs(er).catch(() => e.logs)) : e?.logs; r.raw = String(e?.message ?? e).slice(0, 300); }
    for (let w = 0; w < 15; w++) {
      await sleep(2000);
      r.l1Seq = Number(coder.decode("table", (await connection.getAccountInfo(T.table))!.data).ledgerSeq);
      if (r.l1Seq === r.rollupSeq) break;
    }
    r.reachedL1 = r.l1Seq === r.rollupSeq;
    out.rounds.push(r);
    console.log(JSON.stringify({ n: i, accepted: r.accepted, rollupSeq: r.rollupSeq, l1Seq: r.l1Seq, reachedL1: r.reachedL1, error: r.error }));
  }
  out.after = { tableLamports: await er.getBalance(T.table), feeVault: await er.getBalance(feeVault) };
  out.acceptedAndOnL1 = out.rounds.filter((r: any) => r.accepted && r.reachedL1).length;
  out.round11and12OnL1 = out.rounds[10].reachedL1 && out.rounds[11].reachedL1;
  await T.cashOut(progP1, p1.publicKey, 0).catch(() => {});
  await T.collectRake(prog, tokenOf(deployer.publicKey)).catch(() => {});
  await T.close(prog, deployer.publicKey).catch(() => {});
  const file = path.join(__dirname, "../results", `commit-fee-payer-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ acceptedAndOnL1: out.acceptedAndOnL1, round11and12OnL1: out.round11and12OnL1, before: out.before, after: out.after }));
}
main().catch((e) => { console.error(e); process.exit(1); });
