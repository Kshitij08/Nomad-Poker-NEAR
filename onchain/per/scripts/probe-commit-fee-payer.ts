// Experiment: can the table pay for its own commits (as a delegated fee payer), lifting MagicBlock's
// 10-commit limit for accounts without one? Commits a fresh table 12 times, checking each commit
// reaches L1 (ledger_seq on L1 follows), and records the table's lamports in the rollup and the
// validator's magic fee vault around it. Writes results/commit-fee-payer-<ts>.json.
import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { connection, loadKey, programFor, programOn, teeConnection, TEE_VALIDATOR, randomTableId } from "./lib";
import { BN, errName, sleep, tableApi } from "../tests/helpers";

const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

async function main() {
  const deployer = loadKey("deployer");
  const er = await teeConnection(deployer);
  const prog = programOn(er, deployer);
  const coder = programFor(deployer).coder.accounts as any;
  const [feeVault] = PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()], DLP);
  const T = tableApi(deployer, randomTableId());
  await T.create({ smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false });
  await T.delegate(); await sleep(4000);
  await T.open(prog, deployer.publicKey);
  const out: any = { table: T.table.toBase58(), feeVault: feeVault.toBase58(), before: { tableLamports: await er.getBalance(T.table), feeVault: await er.getBalance(feeVault) }, commits: [] };
  for (let i = 1; i <= 12; i++) {
    const r: any = { n: i };
    try { r.sig = await T.commit(prog, deployer.publicKey); r.ok = true; } catch (e) { r.ok = false; r.error = errName(e); r.raw = String((e as any)?.message ?? e).slice(0, 200); }
    out.commits.push(r);
    await sleep(2500);
  }
  await sleep(8000);
  const l1 = (await connection.getAccountInfo(T.table))!;
  out.l1Owner = l1.owner.toBase58();
  out.after = { tableLamports: await er.getBalance(T.table), feeVault: await er.getBalance(feeVault) };
  out.okCount = out.commits.filter((c: any) => c.ok).length;
  out.commit11and12ok = out.commits[10].ok && out.commits[11].ok;
  await T.close(prog, deployer.publicKey);
  const file = path.join(__dirname, "../results", `commit-fee-payer-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, commits: out.commits.map((c: any) => (c.ok ? "ok" : c.error)) }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
