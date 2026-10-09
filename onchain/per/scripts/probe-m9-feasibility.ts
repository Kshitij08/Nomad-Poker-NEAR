// M9 feasibility, before any program change:
//  1. Does the TEE rollup run the Ed25519 signature-check program (and reject a bad signature)? If so, a
//     wallet can authorize a play key by signing a message (no transaction, so no wallet preview).
//  2. Can a devnet deposit credit someone else's rollup balance (MagicBlock's encrypted-destination
//     deposit), first to a normal wallet and then to a program address (off-curve, like a game vault)?
import { Ed25519Program, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { transferSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
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
    return { sig, err: st.value.err };
  } catch (e: any) { return { err: String(e?.message ?? e).slice(0, 200) }; }
}

(async () => {
  const deployer = loadKey("deployer");
  const out: any = {};

  // 1. Ed25519 in the rollup.
  const playKey = Keypair.generate(), wallet = Keypair.generate();
  const tee = await teeConnection(playKey);
  const msg = Buffer.from(`poker-per: authorize play key ${playKey.publicKey.toBase58()}`);
  const good = Ed25519Program.createInstructionWithPublicKey({ publicKey: wallet.publicKey.toBytes(), message: msg, signature: nacl.sign.detached(msg, wallet.secretKey) });
  const badSig = nacl.sign.detached(msg, wallet.secretKey); badSig[0] ^= 1;
  const bad = Ed25519Program.createInstructionWithPublicKey({ publicKey: wallet.publicKey.toBytes(), message: msg, signature: badSig });
  out.ed25519 = { validSignature: await teeSend(tee, playKey, [good]), tamperedSignature: await teeSend(tee, playKey, [bad]) };

  // 2. Deposit to another owner's rollup balance.
  const payer = Keypair.generate();
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: payer.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [deployer]);
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  await sendL1(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata, lamports: 10_000_000 }), createSyncNativeInstruction(ata)), [payer]);
  const recipient = Keypair.generate();
  const vaultPda = PublicKey.findProgramAddressSync([Buffer.from("probe-vault"), payer.publicKey.toBuffer()], PROGRAM_ID)[0];
  const deposit = async (to: PublicKey) => {
    const before = await connection.getBalance(payer.publicKey);
    const ixs = await transferSpl(payer.publicKey, to, NATIVE_MINT, 3_000_000n, { visibility: "private", fromBalance: "base", toBalance: "ephemeral", validator: TEE_VALIDATOR, initVaultIfMissing: true } as any);
    const sim = (await connection.simulateTransaction(Object.assign(new Transaction().add(...ixs), { feePayer: payer.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash }))).value;
    if (sim.err) return { simulation: sim.err, logs: sim.logs?.slice(-4) };
    const sig = await sendL1(new Transaction().add(...ixs), [payer]);
    return { sig, previewOk: true, solSpent: (before - (await connection.getBalance(payer.publicKey))) / LAMPORTS_PER_SOL };
  };
  out.toWallet = { recipient: recipient.publicKey.toBase58(), ...(await deposit(recipient.publicKey)) };
  out.toProgramAddress = { recipient: vaultPda.toBase58(), offCurve: !PublicKey.isOnCurve(vaultPda.toBytes()), ...(await deposit(vaultPda)) };
  await sleep(15_000);
  const rTee = await teeConnection(recipient);
  out.toWallet.rollupBalanceSeenByRecipient = await rTee.getTokenAccountBalance(getAssociatedTokenAddressSync(NATIVE_MINT, recipient.publicKey)).then((b) => b.value.amount, (e) => String(e.message).slice(0, 120));
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultPda, true);
  const info = await tee.getAccountInfo(vaultAta).catch(() => null);
  out.toProgramAddress.rollupAccount = { address: vaultAta.toBase58(), exists: !!info, owner: info?.owner.toBase58(), dataLen: info?.data.length };
  fs.writeFileSync(`results/m9-feasibility-${Date.now()}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
