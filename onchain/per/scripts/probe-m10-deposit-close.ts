// M10 cost: does a deposit still land in the game vault if the wallet's wSOL account (created to wrap the SOL)
// is closed at the end of the same transaction? That would return its ~0.002 SOL rent on every first deposit.
// Writes results/m10-deposit-close-<ts>.json.
import { ComputeBudgetProgram } from "@solana/web3.js";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import { connection, loadKey, programFor } from "./lib";
import { sendL1, sleep } from "../tests/helpers";
import { depositToVaultIxs, openVaultAccounts, vaultTokenOf } from "../client-web/vault";
import { teeConnection } from "./lib";

async function main() {
  const deployer = loadKey("deployer");
  const w = Keypair.generate();
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: w.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [deployer]);
  await sendL1(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), await programFor(w).methods.openVault().accountsPartial(openVaultAccounts(w.publicKey)).instruction()), [w]);
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey);
  const before = await connection.getBalance(w.publicKey);
  let ok = true, err = "";
  try {
    await sendL1(new Transaction().add(...depositToVaultIxs(w.publicKey, 10_000_000n), createCloseAccountInstruction(ata, w.publicKey, w.publicKey)), [w]);
  } catch (e: any) { ok = false; err = String(e.message ?? e).slice(0, 300); }
  const spent = before - (await connection.getBalance(w.publicKey));
  const ataLeft = await connection.getAccountInfo(ata);
  await sleep(12_000);
  const tee = await teeConnection(w);
  const vt = await tee.getTokenAccountBalance(vaultTokenOf(w.publicKey)).then((b) => b.value.amount).catch((e) => "ERR " + String(e.message).slice(0, 80));
  const out = { wallet: w.publicKey.toBase58(), depositWithClose: ok, err, spentLamports: spent, beyondTheMoney: spent - 10_000_000, walletAtaLeft: !!ataLeft, vaultBalanceInRollup: vt };
  console.log(out);
  fs.writeFileSync(path.join(__dirname, "../results", `m10-deposit-close-${Date.now()}.json`), JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
