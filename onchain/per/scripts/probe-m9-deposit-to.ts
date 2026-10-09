// Follow-up to probe-m9-feasibility: an encrypted-destination deposit left the money in MagicBlock's
// shuttle when the recipient had no rollup token account. Here the recipient's rollup account is created
// first (ensureMagicAtaDestination, sent to the TEE), then the same deposit is sent, for a normal wallet
// and for a program address. Reports what the recipient's rollup account holds afterwards.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ensureMagicAtaDestinationIx, transferSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";
import { connection, loadKey, PROGRAM_ID, teeConnection, TEE_VALIDATOR } from "./lib";
import { sendL1, sleep } from "../tests/helpers";

async function teeSend(conn: any, signer: Keypair, ixs: any[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(signer);
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const st = await conn.confirmTransaction(sig, "confirmed");
    const logs = (await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null))?.meta?.logMessages?.slice(-4);
    return { sig, err: st.value.err, logs };
  } catch (e: any) { return { err: String(e?.message ?? e).slice(0, 300) }; }
}

(async () => {
  const deployer = loadKey("deployer");
  const payer = Keypair.generate();
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: payer.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [deployer]);
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  await sendL1(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata, lamports: 10_000_000 }), createSyncNativeInstruction(ata)), [payer]);
  const tee = await teeConnection(payer);
  const recipient = Keypair.generate();
  const vaultPda = PublicKey.findProgramAddressSync([Buffer.from("probe-vault2"), payer.publicKey.toBuffer()], PROGRAM_ID)[0];
  const out: any = {};
  for (const [name, to] of [["wallet", recipient.publicKey], ["programAddress", vaultPda]] as const) {
    const r: any = { recipient: to.toBase58() };
    r.ensureInRollup = await teeSend(tee, payer, [ensureMagicAtaDestinationIx(payer.publicKey, to, NATIVE_MINT)]);
    const ixs = await transferSpl(payer.publicKey, to, NATIVE_MINT, 3_000_000n, { visibility: "private", fromBalance: "base", toBalance: "ephemeral", validator: TEE_VALIDATOR } as any);
    r.depositSig = await sendL1(new Transaction().add(...ixs), [payer]);
    out[name] = r;
  }
  for (let i = 0; i < 6; i++) {
    await sleep(10_000);
    for (const name of ["wallet", "programAddress"]) {
      const a = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(out[name].recipient), true);
      const info = await tee.getAccountInfo(a).catch(() => null);
      out[name].rollupAta = { address: a.toBase58(), exists: !!info, amount: info && info.data.length >= 72 ? info.data.readBigUInt64LE(64).toString() : null, after: `${(i + 1) * 10}s` };
    }
    if (out.wallet.rollupAta.amount === "3000000" && out.programAddress.rollupAta.amount === "3000000") break;
  }
  const rTee = await teeConnection(recipient);
  out.wallet.balanceSeenByRecipient = await rTee.getTokenAccountBalance(getAssociatedTokenAddressSync(NATIVE_MINT, recipient.publicKey)).then((b) => b.value.amount, (e) => String(e.message).slice(0, 120));
  fs.writeFileSync(`results/m9-deposit-to-${Date.now()}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
