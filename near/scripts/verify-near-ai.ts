#!/usr/bin/env node
// Checks that a private model really chose a NEAR-AI agent's profile in a settled session, from the table's own
// record, and (with --attest) that the model's signing address is bound to its TEE attestation.
//
//   node scripts/verify-near-ai.ts <session_id> [--attest] [--report]
//   node scripts/verify-near-ai.ts --signer <model>      # attestation of a model's signing address(es), for set_near_ai_signer
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { view, TABLE } from "./lib.mjs";
import { verifyNearAiProof, checkAttestation, NEAR_AI_API, type NearAiProof, type Check } from "../feeder/src/nearai.ts";

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { attest: { type: "boolean", default: false }, report: { type: "boolean", default: false }, signer: { type: "string" } } });
const line = (c: Check) => `  ${c.ok ? "ok  " : "FAIL"} ${c.what}: ${c.detail}`;

if (a.signer) {
  // Ask for the model's reports with a fresh nonce, then check each signing address it names.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, "0")).join("");
  const body = await fetch(`${NEAR_AI_API}/attestation/report?model=${encodeURIComponent(a.signer)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`, { headers: { Accept: "application/json", "x-no-aliasing": "true" } }).then((r) => r.json());
  const addrs = [...new Set((body.model_attestations ?? []).map((x: any) => String(x.signing_address).toLowerCase()))] as string[];
  console.log(`${a.signer}: ${addrs.length} signing address(es) in its attestation reports`);
  for (const addr of addrs) {
    const r = await checkAttestation(a.signer, addr);
    console.log(`${r.ok ? "attested" : "NOT VERIFIED"} ${addr}`);
    r.checks.forEach((c) => console.log(line(c)));
  }
  console.log("Full Intel TDX (DCAP) and NVIDIA checks: https://cloud.near.ai/verify or https://github.com/nearai/nearai-cloud-verifier");
  process.exit(0);
}

const sid = positionals[0];
if (!sid) throw new Error("give a session id");
const rec: any = await view("get_session_record", { session_id: sid });
if (!rec) throw new Error(`no record for ${sid} on ${TABLE}`);
const proofs: NearAiProof[] = rec.near_ai ?? [];
const signers: any[] = (await view("get_near_ai_signers")) ?? [];
const allowed = (m: string) => (signers.find((s) => s.model === m)?.signing_addresses ?? []) as string[];
console.log(`${sid}: ${proofs.length} NEAR-AI proof(s)`);
const out: string[] = [];
let ok = true;
for (const p of proofs) {
  const r = verifyNearAiProof(p, allowed(p.model));
  const pos = rec.seat_order ? rec.seat_order.indexOf(p.seat) : p.seat;
  console.log(`${r.ok ? "verified" : "NOT VERIFIED"}: ${p.agent_id} (table position ${pos}) played a profile chosen by ${p.model}`);
  r.checks.forEach((c) => console.log(line(c)));
  out.push(`### ${p.agent_id} (table position ${pos}): ${r.ok ? "verified" : "NOT VERIFIED"}\n\nModel \`${p.model}\`, chat \`${p.chat_id}\`, signer \`${p.signing_address}\`.\n\n| Check | Result | Detail |\n| --- | --- | --- |\n${r.checks.map((c) => `| ${c.what} | ${c.ok ? "ok" : "**FAIL**"} | ${String(c.detail).replace(/\|/g, "\\|")} |`).join("\n")}`);
  ok &&= r.ok;
  if (a.attest) {
    const att = await checkAttestation(p.model, p.signing_address);
    console.log(`  attestation: ${att.ok ? "bound" : "NOT VERIFIED"}`);
    att.checks.forEach((c) => console.log("  " + line(c)));
    out.push(`Attestation (fresh nonce, ${new Date().toISOString()}):\n\n| Check | Result | Detail |\n| --- | --- | --- |\n${att.checks.map((c) => `| ${c.what} | ${c.ok ? "ok" : "**FAIL**"} | ${String(c.detail).slice(0, 160)} |`).join("\n")}`);
    ok &&= att.ok;
  }
}
if (a.report) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "reports");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `near-ai-${sid}.md`), `# NEAR-AI proofs: ${sid}\n\nFrom \`get_session_record("${sid}")\` on \`${TABLE}\`, checked with \`near/scripts/verify-near-ai.ts\`.\n\n${out.join("\n\n")}\n\nThe TDX quote's signature chain and the GPU evidence: https://cloud.near.ai/verify.\n`);
}
process.exitCode = ok ? 0 : 1;
