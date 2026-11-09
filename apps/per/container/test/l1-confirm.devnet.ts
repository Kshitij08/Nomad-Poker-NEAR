// Devnet check (not part of `npm test`): an L1 send through the container's `l1` connection confirms on the stage's
// RPC, whose devnet endpoint has no `signatureSubscribe` (chain.ts confirms by polling). A 1-lamport transfer from the
// keeper to itself (it pays a 5,000-lamport fee).
//   node --import tsx test/l1-confirm.devnet.ts    (env from ../.secrets.staging.json)
import { readFileSync } from "node:fs";
import { join } from "node:path";

const secrets = JSON.parse(readFileSync(join(__dirname, "..", "..", ".secrets.staging.json"), "utf8")) as Record<string, string>;
Object.assign(process.env, secrets, { D1_BRIDGE_URL: "http://127.0.0.1:9/unused" });

async function main() {
  const { SystemProgram, Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
  const { l1 } = await import("../src/chain");
  const { config } = await import("../src/config");
  const t0 = Date.now();
  const sig = await sendAndConfirmTransaction(l1, new Transaction().add(SystemProgram.transfer({ fromPubkey: config.keeper.publicKey, toPubkey: config.keeper.publicKey, lamports: 1 })), [config.keeper], { commitment: "confirmed" });
  console.log(`ok: confirmed in ${Date.now() - t0} ms on the stage's RPC (${sig})`);
}

main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
