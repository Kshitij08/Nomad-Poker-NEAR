// Feasibility check for the escrow-freeze defence, using a plain wallet W as the eATA owner:
//  1. an outsider attaches a flags-0 permission to W's ephemeral ATA (the attack),
//  2. W, as the permission's AUTHORITY member, sets its members to None (public) without the eATA signing,
//  3. an outsider's create is then a no-op, because the permission already exists.
// Writes results/eata-permission-public-<ts>.json.
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createEataPermissionIx, initEphemeralAtaIx, permissionPdaFromAccount, PERMISSION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import { connection, loadKey } from "./lib";
import { ESPL, sendL1 } from "../tests/helpers";

// UpdatePermission: discriminator 1 (u64 LE), then MembersArgs with Option tag 0 = None (public).
const makePublicIx = (authority: PublicKey, permissioned: PublicKey) => new TransactionInstruction({
  programId: PERMISSION_PROGRAM_ID,
  keys: [
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: permissioned, isSigner: false, isWritable: false },
    { pubkey: permissionPdaFromAccount(permissioned), isSigner: false, isWritable: true },
  ],
  data: Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0]),
});

async function main() {
  const deployer = loadKey("deployer"), outsider = loadKey("p3");
  const w = Keypair.generate();
  const out: any = { ranAt: new Date().toISOString(), owner: w.publicKey.toBase58() };
  const [eata] = PublicKey.findProgramAddressSync([w.publicKey.toBuffer(), NATIVE_MINT.toBuffer()], ESPL);
  const perm = permissionPdaFromAccount(eata);
  out.eata = eata.toBase58(); out.permission = perm.toBase58();
  out.fund_and_init = await sendL1(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: w.publicKey, lamports: 10_000_000 }),
    initEphemeralAtaIx(eata, w.publicKey, NATIVE_MINT, deployer.publicKey)), [deployer]);
  out.attack = await sendL1(new Transaction().add(createEataPermissionIx(eata, outsider.publicKey, 0)), [outsider]);
  const before = (await connection.getAccountInfo(perm))!.data;
  out.permission_after_attack = { bytes: before.length, hex: before.toString("hex") };
  try {
    out.make_public = await sendL1(new Transaction().add(makePublicIx(w.publicKey, eata)), [w]);
  } catch (e: any) { out.make_public = { error: String(e), logs: e.logs }; }
  const after = (await connection.getAccountInfo(perm))!.data;
  out.permission_after_make_public = { bytes: after.length, hex: after.toString("hex") };
  try {
    out.attack_again = await sendL1(new Transaction().add(createEataPermissionIx(eata, outsider.publicKey, 0)), [outsider]);
  } catch (e: any) { out.attack_again = { error: String(e), logs: e.logs }; }
  const final = (await connection.getAccountInfo(perm))!.data;
  out.permission_unchanged_by_second_attack = final.equals(after);
  const file = path.join(__dirname, "../results", `eata-permission-public-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
