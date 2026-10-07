// Control for probe-commit-fee-payer.ts: does the devnet TEE actually enforce MagicBlock's 10-commit
// limit for an account with NO delegated fee payer? Uses the M0 spike program (its commit_table is
// paid by a wallet): a fresh spike table is changed (tick) and committed 12 times. The tick and the
// commit are separate steps, each commit's error logs are kept, and the table's L1 copy is read
// after each round to see whether the change arrived.
// Writes results/commit-limit-control-<ts>.json.
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { connection, loadKey, teeConnection, TEE_VALIDATOR } from "./lib";
import { errName, sleep } from "../tests/helpers";

const spikeIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "../../spikes/per/idl/per_spike.json"), "utf8"));
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

async function main() {
  const deployer = loadKey("deployer");
  const wallet = new anchor.Wallet(deployer);
  const l1 = new anchor.Program(spikeIdl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));
  const er = new anchor.Program(spikeIdl, new anchor.AnchorProvider(await teeConnection(deployer), wallet, { commitment: "confirmed", skipPreflight: true }));
  const id = BigInt.asUintN(64, BigInt("0x" + Buffer.from(Keypair.generate().secretKey.subarray(0, 8)).toString("hex")));
  const idBuf = Buffer.alloc(8); idBuf.writeBigUInt64LE(id);
  const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), idBuf], new PublicKey(spikeIdl.address));
  await l1.methods.initTable(new anchor.BN(id.toString()), new anchor.BN(1_000_000)).accountsPartial({ authority: deployer.publicKey, table }).rpc();
  await l1.methods.delegateTable(new anchor.BN(id.toString())).accountsPartial({ authority: deployer.publicKey, table, validator: TEE_VALIDATOR } as any).rpc();
  await sleep(4000);
  const out: any = { program: spikeIdl.address, table: table.toBase58(), commits: [] };
  for (let i = 1; i <= 12; i++) {
    const r: any = { n: i };
    try { await er.methods.tick().accountsPartial({ table }).rpc(); r.ticked = true; } catch (e) { r.ticked = false; r.tickError = errName(e); }
    r.rollupTicks = Number((await er.account.table.fetch(table) as any).ticks);
    try {
      r.sig = await er.methods.commitTable().accountsPartial({ payer: deployer.publicKey, table, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT }).rpc();
      r.ok = true;
    } catch (e: any) {
      r.ok = false; r.error = errName(e); r.raw = String(e?.message ?? e).slice(0, 300);
      r.logs = e instanceof SendTransactionError ? await e.getLogs(er.provider.connection).catch(() => e.logs) : e?.logs;
      if (!r.logs && e?.signature) r.logs = (await er.provider.connection.getTransaction(e.signature, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages;
    }
    for (let w = 0; w < 10; w++) { await sleep(2000); r.l1Ticks = Number((await l1.account.table.fetch(table) as any).ticks); if (r.l1Ticks === r.rollupTicks) break; }
    r.reachedL1 = r.l1Ticks === r.rollupTicks;
    out.commits.push(r);
    console.log(JSON.stringify({ n: i, ok: r.ok, rollupTicks: r.rollupTicks, l1Ticks: r.l1Ticks, reachedL1: r.reachedL1, error: r.error }));
  }
  out.okCount = out.commits.filter((c: any) => c.ok).length;
  out.limitEnforced = !out.commits[10].ok && !out.commits[11].ok && !out.commits[10].reachedL1 && !out.commits[11].reachedL1;
  const file = path.join(__dirname, "../results", `commit-limit-control-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, commits: out.commits.map((c: any) => (c.ok ? "ok" : `${c.error} ${c.raw}`)) }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
