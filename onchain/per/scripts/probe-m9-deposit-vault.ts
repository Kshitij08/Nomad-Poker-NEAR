// Can the deposit that works today (MagicBlock delegateSpl: shuttle + merge) land in a token account owned
// by a program address (a per-wallet game vault) instead of the depositor's own? Same instructions as
// delegateSpl, with the vault's account as the merge destination. Previews it on devnet, sends it, then
// reads the vault's rollup token account.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as sdk from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";
import { connection, loadKey, PROGRAM_ID, teeConnection, TEE_VALIDATOR } from "./lib";
import { sendL1, sleep } from "../tests/helpers";

const s: any = sdk;

(async () => {
  const deployer = loadKey("deployer");
  const wallet = Keypair.generate();
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: wallet.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [deployer]);
  // argv[2] = "keypair": the destination is a normal key we hold, so its login can read the result.
  const holder = Keypair.generate();
  const vault = process.argv[2] === "keypair" ? holder.publicKey : PublicKey.findProgramAddressSync([Buffer.from("probe-vault3"), wallet.publicKey.toBuffer()], PROGRAM_ID)[0];
  const walletAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true);
  const amount = 3_000_000n;
  const shuttleId = Math.floor(Math.random() * 2 ** 32);
  const [shuttleEata] = s.deriveShuttleEphemeralAta(wallet.publicKey, NATIVE_MINT, shuttleId);
  const [shuttleAta] = s.deriveShuttleAta(shuttleEata, NATIVE_MINT);
  const shuttleWalletAta = s.deriveShuttleWalletAta(NATIVE_MINT, shuttleEata);
  const [vaultEata] = s.deriveEphemeralAta(vault, NATIVE_MINT);
  const W = wallet.publicKey;
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(W, walletAta, W, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: W, toPubkey: walletAta, lamports: Number(amount) }), createSyncNativeInstruction(walletAta),
    createAssociatedTokenAccountIdempotentInstruction(W, vaultAta, vault, NATIVE_MINT),
    s.initEphemeralAtaIx(vaultEata, vault, NATIVE_MINT, W),
    s.delegateEphemeralAtaIx(W, vaultEata, TEE_VALIDATOR),
    s.setupAndDelegateShuttleEphemeralAtaWithMergeIx(W, shuttleEata, shuttleAta, W, walletAta, vaultAta, shuttleWalletAta, NATIVE_MINT, shuttleId, amount, TEE_VALIDATOR),
  );
  const out: any = { wallet: W.toBase58(), vault: vault.toBase58(), vaultAta: vaultAta.toBase58() };
  tx.feePayer = W; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = (await connection.simulateTransaction(tx)).value;
  out.preview = { err: sim.err, logs: sim.err ? sim.logs?.slice(-5) : undefined };
  if (!sim.err) {
    const before = await connection.getBalance(W);
    out.sig = await sendL1(tx, [wallet]);
    out.solSpent = (before - (await connection.getBalance(W))) / LAMPORTS_PER_SOL;
    const tee = await teeConnection(process.argv[2] === "keypair" ? holder : Keypair.generate());
    for (let i = 1; i <= 6; i++) {
      await sleep(10_000);
      const info = await tee.getAccountInfo(vaultAta).catch(() => null);
      out.vaultInRollup = { exists: !!info, owner: info?.owner.toBase58(), rawAmount: info && info.data.length >= 72 ? info.data.readBigUInt64LE(64).toString() : null, tokenOwner: info ? new PublicKey(info.data.subarray(32, 64)).toBase58() : null, after: `${i * 10}s` };
      if (process.argv[2] === "keypair") out.vaultInRollup.balanceSeenByHolder = await tee.getTokenAccountBalance(vaultAta).then((b) => b.value.amount, (e) => String(e.message).slice(0, 100));
      if (out.vaultInRollup.exists || out.vaultInRollup.balanceSeenByHolder === amount.toString()) break;
    }
  }
  fs.writeFileSync(`results/m9-deposit-vault-${Date.now()}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
