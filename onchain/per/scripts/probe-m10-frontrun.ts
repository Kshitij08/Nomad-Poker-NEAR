// M10: what an outsider can do to someone else's MagicBlock ephemeral token account (eATA) before its owner
// sets it up, and whether the owner can recover. Throwaway keys; MagicBlock's token program only.
//   1. Can an outsider create the eATA and delegate it to a validator other than the TEE?
//   2. Can an outsider create a private permission on it and delegate that to the TEE?
//   3. Can the owner reset that permission to public (in the rollup, where it's delegated)? Can the outsider?
// Writes results/m10-frontrun-<ts>.json.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createEataPermissionIx, delegateEataPermissionIx, delegateEphemeralAtaIx, deriveEphemeralAta, initEphemeralAtaIx, permissionPdaFromAccount, resetEataPermissionIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";
import path from "path";
import { connection, loadKey, teeConnection, TEE_VALIDATOR } from "./lib";
import { sendL1, sleep, errName } from "../tests/helpers";

const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const OTHER_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"); // MagicBlock's public devnet ER validator
const out: any[] = [];
const note = (name: string, ok: boolean, detail: any) => { out.push({ name, ok, detail }); console.log(`${ok ? "YES" : "NO "}  ${name}  ${JSON.stringify(detail).slice(0, 200)}`); };
const tryIt = async (f: () => Promise<string>) => { try { return { ok: true, sig: await f() }; } catch (e: any) { return { ok: false, err: errName(e) }; } };

async function main() {
  const deployer = loadKey("deployer");
  const owner = Keypair.generate(), outsider = Keypair.generate();
  for (const k of [owner, outsider])
    await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: k.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [deployer]);

  // Case 1: outsider creates the owner's eATA and delegates it to another validator.
  const owner1 = Keypair.generate().publicKey;
  const [eata1] = deriveEphemeralAta(owner1, WSOL);
  const c1 = await tryIt(() => sendL1(new Transaction().add(initEphemeralAtaIx(eata1, owner1, WSOL, outsider.publicKey), delegateEphemeralAtaIx(outsider.publicKey, eata1, OTHER_VALIDATOR)), [outsider]));
  note("1. an outsider can create someone's eATA and delegate it to a non-TEE validator", c1.ok, c1);

  // Case 2: outsider creates the owner's eATA, a private permission on it, and delegates both to the TEE.
  const [eata] = deriveEphemeralAta(owner.publicKey, WSOL);
  const c2a = await tryIt(() => sendL1(new Transaction().add(initEphemeralAtaIx(eata, owner.publicKey, WSOL, outsider.publicKey), delegateEphemeralAtaIx(outsider.publicKey, eata, TEE_VALIDATOR)), [outsider]));
  note("2a. outsider creates the owner's eATA and delegates it to the TEE", c2a.ok, c2a);
  const c2b = await tryIt(() => sendL1(new Transaction().add(createEataPermissionIx(eata, outsider.publicKey, 1)), [outsider]));
  note("2b. outsider creates a private (flags 1) permission on it", c2b.ok, c2b);
  const perm = permissionPdaFromAccount(eata);
  const c2c = await tryIt(() => sendL1(new Transaction().add(delegateEataPermissionIx(outsider.publicKey, eata, TEE_VALIDATOR)), [outsider]));
  note("2c. outsider delegates that permission to the TEE", c2c.ok, c2c);
  const pInfo = await connection.getAccountInfo(perm);
  note("   permission on Solana now", !!pInfo, { owner: pInfo?.owner.toBase58(), byte34: pInfo?.data[34] });
  await sleep(8000);

  // Case 3: reset in the rollup (where the permission is delegated), by the outsider, then by the owner.
  const send = async (signer: Keypair) => {
    const conn = await teeConnection(signer);
    const tx = new Transaction().add(resetEataPermissionIx(eata, signer.publicKey, 0));
    tx.feePayer = signer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(signer);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, "confirmed");
    const st = await conn.getSignatureStatus(sig);
    if (st.value?.err) throw new Error(JSON.stringify(st.value.err));
    return sig;
  };
  const c3a = await tryIt(() => send(outsider));
  note("3a. the outsider can reset the permission in the rollup", c3a.ok, c3a);
  const c3b = await tryIt(() => send(owner));
  note("3b. the owner can reset the permission to public in the rollup", c3b.ok, c3b);
  if (c3b.ok) {
    const conn = await teeConnection(owner);
    const p = await conn.getAccountInfo(perm).catch(() => null);
    note("   rollup permission after the owner's reset", !!p, { byte34: p?.data?.[34], len: p?.data?.length });
  }

  const file = path.join(__dirname, "../results", `m10-frontrun-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), owner: owner.publicKey.toBase58(), outsider: outsider.publicKey.toBase58(), eata: eata.toBase58(), outcomes: out }, null, 2));
  console.log("->", path.relative(process.cwd(), file));
}
main().catch((e) => { console.error(e); process.exit(1); });
