// Can Phantom preview the rollup deposit and withdraw? Both are devnet transactions (MagicBlock SDK
// delegateSpl / withdrawSpl, exactly as the rollup-wallet page builds them). Simulates each on devnet
// the way a wallet does (no signature check), from a fresh funded wallet, and sends the deposit in
// between so the withdraw has something to take.
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { delegateSpl, withdrawSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";
import { connection, loadKey, TEE_VALIDATOR } from "./lib";
import { sendL1, sleep } from "../tests/helpers";

async function simulate(tx: Transaction, payer: Keypair) {
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  // No signers: web3.js sends it unsigned with signature checks off, as a wallet's preview does.
  const v = (await connection.simulateTransaction(tx)).value;
  return { err: v.err, units: v.unitsConsumed, lastLogs: (v.logs ?? []).slice(-3) };
}

(async () => {
  const deployer = loadKey("deployer");
  const owner = Keypair.generate();
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: owner.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL })), [deployer]);
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner.publicKey);
  const amount = 5_000_000n;
  const depositTx = () => delegateSpl(owner.publicKey, NATIVE_MINT, amount, { validator: TEE_VALIDATOR, initVaultIfMissing: true, initAtasIfMissing: true, payer: owner.publicKey })
    .then((ixs) => new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ata, owner.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: ata, lamports: Number(amount) }), createSyncNativeInstruction(ata), ...ixs));
  const out: any = { wallet: owner.publicKey.toBase58() };
  out.depositSimulation = await simulate(await depositTx(), owner);
  await sendL1(await depositTx(), [owner]);
  await sleep(8000);
  const withdraw = new Transaction().add(...(await withdrawSpl(owner.publicKey, NATIVE_MINT, amount, { validator: TEE_VALIDATOR, initAtasIfMissing: true, payer: owner.publicKey })));
  out.withdrawSimulation = await simulate(withdraw, owner);
  fs.writeFileSync(`results/wallet-simulation-l1-${Date.now()}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
