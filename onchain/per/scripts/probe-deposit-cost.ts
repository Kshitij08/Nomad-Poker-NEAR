// Why does a 0.005 SOL deposit into the rollup cost ~0.011 SOL? Runs the exact deposit the
// rollup-wallet page sends (MagicBlock SDK delegateSpl, idempotent path) from a fresh devnet wallet,
// then itemizes: every account the transaction created or funded, its rent, and the fee.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";
import { connection, loadKey, TEE_VALIDATOR } from "./lib";
import { sendL1 } from "../tests/helpers";

async function deposit(owner: Keypair, lamports: bigint) {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner.publicKey);
  const ixs = await delegateSpl(owner.publicKey, NATIVE_MINT, lamports, { validator: TEE_VALIDATOR, initVaultIfMissing: true, initAtasIfMissing: true, payer: owner.publicKey });
  const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ata, owner.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: ata, lamports: Number(lamports) }), createSyncNativeInstruction(ata), ...ixs);
  const sig = await sendL1(tx, [owner]);
  const t = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const keys = t!.transaction.message.getAccountKeys().staticAccountKeys;
  const pre = t!.meta!.preBalances, post = t!.meta!.postBalances;
  const changes = keys.map((k, i) => ({ account: k.toBase58(), before: pre[i], after: post[i], delta: post[i] - pre[i] })).filter((c) => c.delta !== 0);
  return { sig, fee: t!.meta!.fee, changes, instructions: ixs.length + 3 };
}

(async () => {
  const deployer = loadKey("deployer");
  const owner = Keypair.generate();
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: owner.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL })), [deployer]);
  const start = await connection.getBalance(owner.publicKey);
  const first = await deposit(owner, 5_000_000n);
  const afterFirst = await connection.getBalance(owner.publicKey);
  const second = await deposit(owner, 5_000_000n);
  const afterSecond = await connection.getBalance(owner.publicKey);
  const out = {
    wallet: owner.publicKey.toBase58(),
    firstDeposit: { spentLamports: start - afterFirst, beyondTheDeposit: start - afterFirst - 5_000_000, ...first },
    secondDeposit: { spentLamports: afterFirst - afterSecond, beyondTheDeposit: afterFirst - afterSecond - 5_000_000, ...second },
  };
  fs.writeFileSync(`results/deposit-cost-${Date.now()}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
