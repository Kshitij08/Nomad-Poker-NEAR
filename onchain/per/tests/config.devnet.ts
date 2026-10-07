// M1 devnet tests for poker-per config. Failing cases are caught in preflight simulation, so they
// cost nothing. Writes every outcome to results/m1-config-<ts>.json and exits non-zero on failure.
//
// The first initialization can only happen once per program, so on re-runs the "first init" cases
// are reported as SKIPPED (config already exists) rather than re-asserted.
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { connection, CONFIG_PDA, PROGRAM_ID, programFor, loadKey, explorer } from "../scripts/lib";

type Outcome = { name: string; status: "PASS" | "FAIL" | "SKIPPED"; detail: any };
const outcomes: Outcome[] = [];
const BN = (n: number | bigint) => new anchor.BN(n.toString());

async function expectOk(name: string, fn: () => Promise<string>, check?: () => Promise<string | null>) {
  try {
    const sig = await fn();
    const problem = check ? await check() : null;
    outcomes.push({ name, status: problem ? "FAIL" : "PASS", detail: { sig, explorer: explorer(sig), problem } });
  } catch (e: any) {
    outcomes.push({ name, status: "FAIL", detail: { unexpectedError: errName(e) } });
  }
}

async function expectErr(name: string, expected: string, fn: () => Promise<string>) {
  try {
    const sig = await fn();
    outcomes.push({ name, status: "FAIL", detail: { expectedError: expected, butSucceeded: sig } });
  } catch (e: any) {
    const got = errName(e);
    outcomes.push({ name, status: got.includes(expected) ? "PASS" : "FAIL", detail: { expected, got } });
  }
}

function errName(e: any): string {
  const code = e?.error?.errorCode?.code;
  if (code) return `${code} (${e.error.errorCode.number})`;
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
  const hit = logs.find((l) => /Error|failed|already in use/i.test(l));
  return hit ?? String(e?.message ?? e).slice(0, 300);
}

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1"), p2 = loadKey("p2");
  const asDeployer = programFor(deployer), asP1 = programFor(p1), asP2 = programFor(p2);
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));
  const fetchCfg = () => (asDeployer.account as any).config.fetch(CONFIG_PDA);
  const args = (o: Partial<{ devWallet: PublicKey; rakeBps: number; maxBuyIn: bigint; paused: boolean }> = {}) => ({
    devWallet: o.devWallet ?? deployer.publicKey, rakeBps: o.rakeBps ?? 500, maxBuyIn: BN(o.maxBuyIn ?? 1_000_000_000n), paused: o.paused ?? false,
  });
  const initAccts = (authority: PublicKey) => ({ authority, config: CONFIG_PDA, program: PROGRAM_ID, programData });

  const exists = !!(await connection.getAccountInfo(CONFIG_PDA));
  // Recovery: if an earlier run stopped halfway through the admin round-trip, p1 is still admin.
  if (exists) {
    const c = await fetchCfg();
    if (c.admin.equals(p1.publicKey)) {
      await asP1.methods.proposeAdmin(deployer.publicKey).accountsPartial({ admin: p1.publicKey, config: CONFIG_PDA }).rpc();
      await asDeployer.methods.acceptAdmin().accountsPartial({ newAdmin: deployer.publicKey, config: CONFIG_PDA }).rpc();
      console.log("recovered: admin handed back to the deployer after an interrupted earlier run");
    } else if (c.pendingAdmin) {
      await asDeployer.methods.proposeAdmin(null).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc();
      console.log("recovered: cleared a stale pending admin");
    }
  }
  if (!exists) {
    await expectErr("init by a key that is not the upgrade authority is rejected", "NotUpgradeAuthority",
      () => asP1.methods.initializeConfig(args()).accountsPartial(initAccts(p1.publicKey)).rpc());
    await expectErr("init with rake above 10% is rejected", "RakeTooHigh",
      () => asDeployer.methods.initializeConfig(args({ rakeBps: 1001 })).accountsPartial(initAccts(deployer.publicKey)).rpc());
    await expectErr("init with a zero stake cap is rejected", "InvalidStakeCap",
      () => asDeployer.methods.initializeConfig(args({ maxBuyIn: 0n })).accountsPartial(initAccts(deployer.publicKey)).rpc());
    await expectOk("init by the upgrade authority succeeds", () => asDeployer.methods.initializeConfig(args()).accountsPartial(initAccts(deployer.publicKey)).rpc(),
      async () => {
        const c = await fetchCfg();
        const ok = c.version === 2 && c.admin.equals(deployer.publicKey) && c.pendingAdmin === null && c.devWallet.equals(deployer.publicKey)
          && c.rakeBps === 500 && c.maxBuyIn.toString() === "1000000000" && c.paused === false;
        return ok ? null : `unexpected state ${JSON.stringify(c)}`;
      });
  } else {
    for (const n of ["init by a key that is not the upgrade authority is rejected", "init with rake above 10% is rejected", "init with a zero stake cap is rejected", "init by the upgrade authority succeeds"]) {
      outcomes.push({ name: n, status: "SKIPPED", detail: "config already initialized by an earlier run" });
    }
  }

  await expectErr("a second init is rejected", "already in use",
    () => asDeployer.methods.initializeConfig(args()).accountsPartial(initAccts(deployer.publicKey)).rpc());

  await expectErr("update by a non-admin is rejected", "NotAdmin",
    () => asP1.methods.updateConfig(args({ rakeBps: 100 })).accountsPartial({ admin: p1.publicKey, config: CONFIG_PDA }).rpc());
  await expectErr("update with rake above 10% is rejected", "RakeTooHigh",
    () => asDeployer.methods.updateConfig(args({ rakeBps: 1001 })).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc());
  await expectErr("update with a zero stake cap is rejected", "InvalidStakeCap",
    () => asDeployer.methods.updateConfig(args({ maxBuyIn: 0n })).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc());
  await expectErr("update with the all-zeros dev wallet is rejected", "InvalidDevWallet",
    () => asDeployer.methods.updateConfig(args({ devWallet: PublicKey.default })).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc());
  await expectErr("migrate on an already-current config is rejected", "AlreadyMigrated",
    () => asDeployer.methods.migrateConfig().accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc());

  const newDev = Keypair.generate().publicKey;
  await expectOk("admin updates rake, cap, dev wallet and pause flag",
    () => asDeployer.methods.updateConfig(args({ devWallet: newDev, rakeBps: 300, maxBuyIn: 2_000_000_000n, paused: true })).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc(),
    async () => {
      const c = await fetchCfg();
      return c.devWallet.equals(newDev) && c.rakeBps === 300 && c.maxBuyIn.toString() === "2000000000" && c.paused === true ? null : `unexpected state ${JSON.stringify(c)}`;
    });
  await expectOk("admin restores the default settings",
    () => asDeployer.methods.updateConfig(args()).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc(),
    async () => { const c = await fetchCfg(); return c.rakeBps === 500 && c.paused === false && c.devWallet.equals(deployer.publicKey) ? null : "restore failed"; });

  await expectErr("accept with no pending admin is rejected", "NoPendingAdmin",
    () => asP1.methods.acceptAdmin().accountsPartial({ newAdmin: p1.publicKey, config: CONFIG_PDA }).rpc());
  await expectErr("propose by a non-admin is rejected", "NotAdmin",
    () => asP1.methods.proposeAdmin(p1.publicKey).accountsPartial({ admin: p1.publicKey, config: CONFIG_PDA }).rpc());
  await expectOk("admin proposes p1", () => asDeployer.methods.proposeAdmin(p1.publicKey).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc(),
    async () => { const c = await fetchCfg(); return c.pendingAdmin?.equals(p1.publicKey) && c.admin.equals(deployer.publicKey) ? null : "pending not set"; });
  await expectErr("accept by someone other than the proposed key is rejected", "NotPendingAdmin",
    () => asP2.methods.acceptAdmin().accountsPartial({ newAdmin: p2.publicKey, config: CONFIG_PDA }).rpc());
  await expectOk("p1 accepts and becomes admin", () => asP1.methods.acceptAdmin().accountsPartial({ newAdmin: p1.publicKey, config: CONFIG_PDA }).rpc(),
    async () => { const c = await fetchCfg(); return c.admin.equals(p1.publicKey) && c.pendingAdmin === null ? null : "handover failed"; });
  await expectErr("old admin can no longer update", "NotAdmin",
    () => asDeployer.methods.updateConfig(args()).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc());
  await expectOk("p1 hands admin back to the deployer (propose)", () => asP1.methods.proposeAdmin(deployer.publicKey).accountsPartial({ admin: p1.publicKey, config: CONFIG_PDA }).rpc());
  await expectOk("deployer accepts and is admin again", () => asDeployer.methods.acceptAdmin().accountsPartial({ newAdmin: deployer.publicKey, config: CONFIG_PDA }).rpc(),
    async () => { const c = await fetchCfg(); return c.admin.equals(deployer.publicKey) && c.pendingAdmin === null ? null : "hand-back failed"; });

  const failed = outcomes.filter((o) => o.status === "FAIL").length;
  const summary = { program: PROGRAM_ID.toBase58(), config: CONFIG_PDA.toBase58(), ranAt: new Date().toISOString(), pass: outcomes.filter((o) => o.status === "PASS").length, fail: failed, skipped: outcomes.filter((o) => o.status === "SKIPPED").length, outcomes };
  const out = path.join(__dirname, "../results", `m1-config-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  for (const o of outcomes) console.log(`${o.status.padEnd(7)} ${o.name}${o.status === "FAIL" ? "  " + JSON.stringify(o.detail) : ""}`);
  console.log(`\n${summary.pass} passed, ${summary.fail} failed, ${summary.skipped} skipped -> ${path.relative(process.cwd(), out)}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
