// What a player pays in SOL for the M9 game balance: opening the vault (one time), a deposit, a second
// deposit, and the one-time withdrawal setup plus a withdrawal. Fresh devnet wallet, same instructions
// as the game (client-web/vault.ts mirrors PerVault.cs).
import { ComputeBudgetProgram } from "@solana/web3.js";
import { Keypair, LAMPORTS_PER_SOL, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import fs from "fs";
import { connection, loadKey, programFor, programOn, teeConnection } from "./lib";
import { BN, sendL1, sleep } from "../tests/helpers";
import { depositToVaultIxs, ensureWalletInRollupIxs, openVaultAccounts, playKeyMessage, proofIx, vaultOf, vaultTokenOf, walletTokenOf, withdrawToWalletIxs } from "../client-web/vault";

(async () => {
  const deployer = loadKey("deployer");
  const w = Keypair.generate();
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: w.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })), [deployer]);
  const bal = () => connection.getBalance(w.publicKey);
  const step = async (name: string, f: () => Promise<unknown>, moved = 0) => { const b = await bal(); await f(); const a = await bal(); return { step: name, solSpent: (b - a) / LAMPORTS_PER_SOL, beyondTheMoney: (b - a - moved) / LAMPORTS_PER_SOL }; };
  const out: any[] = [];
  out.push(await step("open the game balance (one time)", async () => sendL1(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), await programFor(w).methods.openVault().accountsPartial(openVaultAccounts(w.publicKey)).instruction()), [w])));
  out.push(await step("deposit 0.01 SOL (first)", () => sendL1(new Transaction().add(...depositToVaultIxs(w.publicKey, 10_000_000n)), [w]), 10_000_000));
  out.push(await step("deposit 0.01 SOL (second)", () => sendL1(new Transaction().add(...depositToVaultIxs(w.publicKey, 10_000_000n)), [w]), 10_000_000));
  out.push(await step("withdrawal setup (one time)", async () => sendL1(new Transaction().add(...(await ensureWalletInRollupIxs(w.publicKey))), [w])));
  await sleep(15_000);
  const key = Keypair.generate(), exp = Math.floor(Date.now() / 1000) + 86_400;
  const msg = playKeyMessage(key.publicKey, exp);
  await programOn(await teeConnection(key), key).methods.vaultWithdraw(BN(20_000_000n), BN(exp)).accountsPartial({
    playKey: key.publicKey, wallet: w.publicKey, vault: vaultOf(w.publicKey), vaultToken: vaultTokenOf(w.publicKey), walletToken: walletTokenOf(w.publicKey), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
  }).preInstructions([proofIx(w.publicKey, msg, nacl.sign.detached(msg, w.secretKey))]).rpc();
  const before = await bal();
  await sendL1(new Transaction().add(...(await withdrawToWalletIxs(w.publicKey, 20_000_000n))), [w]);
  let after = before;
  for (let i = 0; i < 12 && after - before < 19_000_000; i++) { await sleep(5000); after = await bal(); }
  out.push({ step: "withdraw 0.02 SOL", received: (after - before) / LAMPORTS_PER_SOL, cost: (20_000_000 - (after - before)) / LAMPORTS_PER_SOL });
  fs.writeFileSync(`results/vault-cost-${Date.now()}.json`, JSON.stringify({ wallet: w.publicKey.toBase58(), steps: out }, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
