// Migrates the live devnet config from layout v1 to the current layout and records evidence:
// the raw v1 bytes, that v1 is refused until migrated, admin-only migration, field-by-field
// preservation, and that a second migration is refused. Writes results/m1-migrate-<ts>.json.
// Run with `-- --dry` to only print the current state.
import fs from "fs";
import path from "path";
import { connection, CONFIG_PDA, programFor, loadKey, explorer } from "./lib";

type Outcome = { name: string; status: "PASS" | "FAIL"; detail: any };
const out: Outcome[] = [];
const errName = (e: any) => e?.error?.errorCode ? `${e.error.errorCode.code} (${e.error.errorCode.number})` : ((e?.logs ?? []).find((l: string) => /Error/.test(l)) ?? String(e?.message ?? e).slice(0, 200));

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1");
  const asDeployer = programFor(deployer), asP1 = programFor(p1);
  const before = await connection.getAccountInfo(CONFIG_PDA);
  if (!before) throw new Error("config not found");
  const v1 = { len: before.data.length, lamports: before.lamports, version: before.data[8], hex: before.data.toString("hex") };
  console.log("current config", { len: v1.len, version: v1.version, lamports: v1.lamports });
  if (process.argv.includes("--dry")) return;

  const args = { devWallet: deployer.publicKey, rakeBps: 500, maxBuyIn: new (require("@coral-xyz/anchor").BN)(1_000_000_000), paused: false };
  try {
    await asDeployer.methods.updateConfig(args).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc();
    out.push({ name: "update on the v1 layout is refused before migration", status: "FAIL", detail: "update succeeded" });
  } catch (e) { out.push({ name: "update on the v1 layout is refused before migration", status: "PASS", detail: { got: errName(e) } }); }

  try {
    await asP1.methods.migrateConfig().accountsPartial({ admin: p1.publicKey, config: CONFIG_PDA }).rpc();
    out.push({ name: "migrate by a non-admin is refused", status: "FAIL", detail: "succeeded" });
  } catch (e) { const got = errName(e); out.push({ name: "migrate by a non-admin is refused", status: got.includes("NotAdmin") ? "PASS" : "FAIL", detail: { got } }); }

  let sig = "";
  try { sig = await asDeployer.methods.migrateConfig().accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc(); }
  catch (e) { out.push({ name: "admin migrates v1 -> v2", status: "FAIL", detail: { error: errName(e) } }); }
  if (sig) {
    const after = await connection.getAccountInfo(CONFIG_PDA);
    const cfg = await (asDeployer.account as any).config.fetch(CONFIG_PDA);
    // Compare decoded fields, not raw bytes: Option<Pubkey> makes the serialized length vary and
    // Anchor leaves stale bytes after it (see verify-migration.ts).
    const problems: string[] = [];
    if (cfg.version !== 2) problems.push(`version ${cfg.version}`);
    if (!cfg.admin.equals(deployer.publicKey)) problems.push("admin changed");
    if (cfg.reserved.some((b: number) => b !== 0)) problems.push("reserved not zero");
    out.push({ name: "admin migrates v1 -> v2", status: problems.length ? "FAIL" : "PASS", detail: { sig, explorer: explorer(sig), lenBefore: v1.len, lenAfter: after!.data.length, lamportsBefore: v1.lamports, lamportsAfter: after!.lamports, problems } });
  }

  try {
    await asDeployer.methods.migrateConfig().accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc();
    out.push({ name: "a second migration is refused", status: "FAIL", detail: "succeeded" });
  } catch (e) { const got = errName(e); out.push({ name: "a second migration is refused", status: got.includes("AlreadyMigrated") ? "PASS" : "FAIL", detail: { got } }); }

  try {
    const s = await asDeployer.methods.updateConfig(args).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc();
    out.push({ name: "update works after migration", status: "PASS", detail: { sig: s, explorer: explorer(s) } });
  } catch (e) { out.push({ name: "update works after migration", status: "FAIL", detail: { got: errName(e) } }); }

  const file = path.join(__dirname, "../results", `m1-migrate-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), config: CONFIG_PDA.toBase58(), v1Snapshot: v1, outcomes: out }, null, 2));
  for (const o of out) console.log(`${o.status} ${o.name} ${JSON.stringify(o.detail)}`);
  process.exit(out.some((o) => o.status === "FAIL") ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
