// Tops the test players' wSOL balances in the TEE rollup up to a target (default 12,000,000).
// Usage: npx tsx scripts/topup.ts [target] [names...]   e.g. npx tsx scripts/topup.ts 12000000 p1 p2
import { SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { loadKey, teeConnection, TEE_VALIDATOR } from "./lib";
import { sendL1, sleep, tokenOf } from "../tests/helpers";

async function main() {
  const [targetArg = "12000000", ...names] = process.argv.slice(2);
  const target = BigInt(targetArg);
  for (const name of names.length ? names : ["p1", "p2", "p3"]) {
    const kp = loadKey(name);
    const er = await teeConnection(kp);
    let bal = 0n;
    try { bal = BigInt((await er.getTokenAccountBalance(tokenOf(kp.publicKey))).value.amount); } catch { /* none yet */ }
    if (bal >= target) { console.log(name, "has", bal.toString()); continue; }
    const amt = target - bal, ata = tokenOf(kp.publicKey);
    const ixs = await delegateSpl(kp.publicKey, NATIVE_MINT, amt, { validator: TEE_VALIDATOR, initVaultIfMissing: true, initAtasIfMissing: true, payer: kp.publicKey });
    await sendL1(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata, lamports: Number(amt) }), createSyncNativeInstruction(ata), ...ixs), [kp]);
    console.log(name, "topped up by", amt.toString());
  }
  await sleep(6000);
}
main().catch((e) => { console.error(e); process.exit(1); });
