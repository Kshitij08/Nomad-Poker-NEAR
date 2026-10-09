// Regression test for the M3 escrow-freeze finding. Before the fix, any wallet could attach a
// flags-0 permission to a table escrow's ephemeral token account, and the TEE RPC then refused every
// buy-in, cash-out and rake transaction with 403. create_table now claims that permission itself,
// makes it public and delegates it to the TEE. This runs every outsider move we know of, then a full
// table round trip. Writes results/escrow-freeze-<ts>.json.
import { Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createEataPermissionIx, delegateEataPermissionIx, initEphemeralAtaIx, resetEataPermissionIx, permissionPdaFromAccount, PERMISSION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { connection, loadKey, programOn, teeConnection, randomTableId, TEE_VALIDATOR } from "../scripts/lib";
import { BN, DLP, Suite, dlpPda, sleep, tableApi, sendL1, tokenOf } from "./helpers";

// Permission account layout: [0] discriminator, [1] bump, [2..34] permissioned account, [34] Option tag
// of the member list (0 = None = public; a public permission has no members, not even an authority).
const PRIVATE_FLAG_OFFSET = 34;
const makePublicIx = (authority: PublicKey, permissioned: PublicKey) => new TransactionInstruction({
  programId: PERMISSION_PROGRAM_ID,
  keys: [
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: permissioned, isSigner: false, isWritable: false },
    { pubkey: permissionPdaFromAccount(permissioned), isSigner: false, isWritable: true },
  ],
  data: Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0]),
});
// UpdatePermission with one member (the attacker) holding every flag: tries to take the permission private.
const makePrivateIx = (attacker: PublicKey, permissioned: PublicKey) => new TransactionInstruction({
  programId: PERMISSION_PROGRAM_ID,
  keys: [
    { pubkey: attacker, isSigner: true, isWritable: false },
    { pubkey: permissioned, isSigner: false, isWritable: false },
    { pubkey: permissionPdaFromAccount(permissioned), isSigner: false, isWritable: true },
  ],
  data: Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0x1f]), attacker.toBuffer()]),
});

const S = new Suite("escrow-freeze");
async function main() {
  const deployer = loadKey("deployer"), p2 = loadKey("p2"), p3 = loadKey("p3");
  const erD = programOn(await teeConnection(deployer), deployer), erP2 = programOn(await teeConnection(p2), p2);
  const T = tableApi(deployer, randomTableId());
  const perm = permissionPdaFromAccount(T.escrowEata);
  const snapshot = async () => {
    const a = await connection.getAccountInfo(perm);
    return a ? { owner: a.owner.toBase58(), data: Buffer.from(a.data) } : null;
  };

  await S.ok("create table", () => T.create({ smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false }));
  await sleep(3000);
  const after = await snapshot();
  S.check("escrow permission exists and is delegated (owned by the delegation program)", after?.owner === DLP.toBase58(), { owner: after?.owner });
  const tee = await (await teeConnection(deployer)).getAccountInfo(perm);
  // Since 9 Oct MagicBlock's RPC hides permission accounts (their fix of leak 1), so the rollup copy may
  // be unreadable. The rollup copies it from the delegated Solana snapshot, which is checked instead.
  S.check("the escrow permission is public (Solana snapshot; the rollup copy, if readable)", after!.data[PRIVATE_FLAG_OFFSET] === 0 && (!tee || tee.data[PRIVATE_FLAG_OFFSET] === 0),
    { snapshot: after!.data[PRIVATE_FLAG_OFFSET], inRollup: tee ? tee.data[PRIVATE_FLAG_OFFSET] : "hidden by MagicBlock's RPC" });

  // Outsider moves. Each must fail or change nothing.
  const tryL1 = async (ix: TransactionInstruction, signers: Keypair[]) => {
    try { await sendL1(new Transaction().add(ix), signers); return "sent"; } catch (e: any) { return "rejected: " + String(e.message ?? e).slice(0, 120); }
  };
  const r1 = await tryL1(createEataPermissionIx(T.escrowEata, p3.publicKey, 0), [p3]);
  const r2 = await tryL1(resetEataPermissionIx(T.escrowEata, p3.publicKey, 0), [p3]);
  const r3 = await tryL1(delegateEataPermissionIx(p3.publicKey, T.escrowEata, Keypair.generate().publicKey), [p3]);
  const r4 = await tryL1(makePrivateIx(p3.publicKey, T.escrowEata), [p3]);
  const r5 = await tryL1(makePublicIx(p3.publicKey, T.escrowEata), [p3]);
  const later = await snapshot();
  S.check("outsider create (flags 0), reset, delegate-elsewhere and two direct updates leave the L1 permission unchanged",
    !!later && later.owner === after?.owner && later.data.equals(after!.data), { create: r1, reset: r2, delegateElsewhere: r3, updatePrivate: r4, updatePublic: r5 });
  const erP3 = await teeConnection(p3);
  const r6 = await sendAndConfirmTransaction(erP3, new Transaction().add(makePrivateIx(p3.publicKey, T.escrowEata)), [p3], { skipPreflight: true })
    .then(() => "landed", (e: any) => "rejected: " + String(e.message ?? e).slice(0, 120));
  const teeLater = await (await teeConnection(deployer)).getAccountInfo(perm);
  S.check("outsider update inside the rollup is rejected (or, if the copy is readable, leaves it public)",
    r6.startsWith("rejected") && (!teeLater || (teeLater.data[PRIVATE_FLAG_OFFSET] === 0 && (!tee || teeLater.data.equals(tee.data)))), { result: r6, inRollup: teeLater ? teeLater.data[PRIVATE_FLAG_OFFSET] : "hidden by MagicBlock's RPC" });

  // The table still works end to end.
  await S.ok("delegate", () => T.delegate());
  await sleep(4000);
  await S.ok("open", () => T.open(erD, deployer.publicKey));
  await S.ok("p2 buys in", () => T.buyIn(erP2, p2.publicKey, 0, 2_000_000n));
  await S.ok("p2 cashes out", () => T.cashOut(erP2, p2.publicKey, 0));
  await S.ok("collect rake", () => T.collectRake(erD, tokenOf(deployer.publicKey)));
  await S.ok("close", () => T.close(erD, deployer.publicKey));

  // Cost of the fix: the public permission can't be closed, so its rent and delegation records stay.
  const locked = await Promise.all([perm, dlpPda("delegation", perm), dlpPda("delegation-metadata", perm)].map((k) => connection.getBalance(k)));
  S.check("measure rent left locked per table by the public escrow permission", locked[0] > 0,
    { permission: locked[0], delegationRecord: locked[1], delegationMetadata: locked[2], totalSol: locked.reduce((a, b) => a + b, 0) / 1e9 });

  // An outsider who learns a table id before it's created can block that one creation.
  const U = tableApi(deployer, randomTableId());
  await S.ok("outsider pre-claims a known future table's escrow: initialise, flags-0 permission, delegate the permission", () => sendL1(new Transaction().add(
    initEphemeralAtaIx(U.escrowEata, U.table, NATIVE_MINT, p3.publicKey),
    createEataPermissionIx(U.escrowEata, p3.publicKey, 0),
    delegateEataPermissionIx(p3.publicKey, U.escrowEata, TEE_VALIDATOR)), [p3]));
  await S.err("creating that exact table then fails as a whole", "", () => U.create({ smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false }));
  S.check("...and no table account exists for that id (creator retries with a fresh id)", (await connection.getAccountInfo(U.table)) === null, { table: U.table.toBase58() });

  S.finish({ table: T.table.toBase58(), escrowEata: T.escrowEata.toBase58(), escrowPermission: perm.toBase58(), blockedTable: U.table.toBase58() });
}
main().catch((e) => { console.error(e); process.exit(1); });
