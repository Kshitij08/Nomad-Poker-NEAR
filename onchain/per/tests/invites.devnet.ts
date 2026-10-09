// M9c: private invite lists and invite links. A new invite-only table keeps its list in the rollup,
// set by the host's play key (no wallet prompt, no L1 rent), unreadable by anyone; an invite link's
// secret code lets its holder sit down. Tables hosted before keep their L1 list, which still works
// and whose rent the host can now take back. Writes results/invites-<ts>.json.
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { createHash, randomBytes } from "crypto";
import nacl from "tweetnacl";
import { CONFIG_PDA, connection, loadKey, PROGRAM_ID, programFor, programOn, randomTableId, teeConnection, TEE_VALIDATOR } from "../scripts/lib";
import { BN, CREATE_TABLE_CU, errName, EPHEMERAL_VAULT, MAGIC_CONTEXT_ID, MAGIC_FEE_VAULT, Suite, escapePayerOf, handOf, inviteHash, invitesOf, rollup, sendL1, sleep, tableApi, tokenOf } from "./helpers";
import { depositToVaultIxs, openVaultAccounts, playKeyMessage, proofIx, vaultOf, vaultTokenOf } from "../client-web/vault";
import { MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

const S = new Suite("invites");
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const STAKES = { smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6 };
const privateInvitesOf = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("invites_p"), t.toBuffer()], PROGRAM_ID)[0];
const entry = (t: PublicKey, w: PublicKey) => Array.from(createHash("sha256").update(t.toBuffer()).update(w.toBuffer()).digest().subarray(0, 16));
const randomTablePda = () => PublicKey.findProgramAddressSync([Buffer.from("table"), Keypair.generate().publicKey.toBuffer(), Buffer.alloc(8)], PROGRAM_ID)[0];
const codeHash = (t: PublicKey, code: Buffer) => Array.from(createHash("sha256").update(Buffer.from("invite-code")).update(t.toBuffer()).update(code).digest());

async function newPlayer(deployer: Keypair, sol: number) {
  const wallet = Keypair.generate(), key = Keypair.generate();
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: wallet.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [deployer]);
  return { wallet, key, exp: now() + DAY, er: programOn(await teeConnection(key), key) };
}
type P = Awaited<ReturnType<typeof newPlayer>>;
const proof = (signer: Keypair, key: PublicKey, expires: number) => {
  const msg = playKeyMessage(key, expires);
  return proofIx(signer.publicKey, msg, nacl.sign.detached(msg, signer.secretKey));
};
async function preview(ixs: TransactionInstruction[], feePayer: PublicKey) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const v = (await connection.simulateTransaction(tx)).value;
  return { err: v.err, logs: v.err ? v.logs?.slice(-4) : undefined };
}
const size = async (ixs: TransactionInstruction[], payer: PublicKey) => {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
};

async function main() {
  const deployer = loadKey("deployer");
  const H = await newPlayer(deployer, 0.12), I = await newPlayer(deployer, 0.05), U = await newPlayer(deployer, 0.05), L = await newPlayer(deployer, 0.05), W = await newPlayer(deployer, 0.05);
  for (const p of [H, I, U, L, W]) {
    await sendL1(new Transaction().add(await programFor(p.wallet).methods.openVault().accountsPartial(openVaultAccounts(p.wallet.publicKey)).instruction()), [p.wallet]);
    await sendL1(new Transaction().add(...depositToVaultIxs(p.wallet.publicKey, 10_000_000n)), [p.wallet]);
  }
  await sleep(12_000);

  const host = async (id: bigint) => {
    const T = tableApi(H.wallet, id);
    const create = await programFor(H.wallet).methods.createTable(BN(id), { ...STAKES, inviteOnly: true })
      .accountsPartial({ creator: H.wallet.publicKey, config: CONFIG_PDA, table: T.table, mint: new PublicKey("So11111111111111111111111111111111111111112"), escrow: T.escrow, escrowEata: T.escrowEata }).instruction();
    const delegate = await programFor(H.wallet).methods.delegateTable(BN(id), H.wallet.publicKey)
      .accountsPartial({ payer: H.wallet.publicKey, table: T.table, escapePayer: escapePayerOf(T.table), validator: TEE_VALIDATOR }).instruction();
    return { T, cu: ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_TABLE_CU + 100_000 }), create, delegate };
  };

  // ---- A new invite-only table: one wallet approval, then everything else by the play key.
  const newId = randomTableId(), legacyId = randomTableId();
  const nt = await host(newId);
  const balBefore = await connection.getBalance(H.wallet.publicKey);
  await S.ok("host creates and hands over an invite-only table in one transaction (the only wallet approval)", () => sendL1(new Transaction().add(nt.cu, nt.create, nt.delegate), [H.wallet]));
  await sleep(5000);
  await S.ok("host's play key opens it", () => nt.T.open(H.er, H.key.publicKey));

  const setKeyed = (signer: P, T: ReturnType<typeof tableApi>, hashes: number[][] | null, code: number[] | null, messageSigner?: Keypair) => async () =>
    signer.er.methods.setInvitesKeyed(BN(signer.exp), hashes, code).accountsPartial({
      playKey: signer.key.publicKey, table: T.table, invites: privateInvitesOf(T.table), invitesPermission: permissionPdaFromAccount(privateInvitesOf(T.table)),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, rollup,
    }).preInstructions([proof(messageSigner ?? signer.wallet, signer.key.publicKey, signer.exp)]).rpc();

  // The largest list must fit one transaction with the wallet's signed message.
  const sixteen = [H.wallet.publicKey, I.wallet.publicKey, ...Array.from({ length: 14 }, () => Keypair.generate().publicKey)].map((w) => entry(nt.T.table, w));
  const code = randomBytes(16);
  const fullIx = await H.er.methods.setInvitesKeyed(BN(H.exp), sixteen, codeHash(nt.T.table, code)).accountsPartial({
    playKey: H.key.publicKey, table: nt.T.table, invites: privateInvitesOf(nt.T.table), invitesPermission: permissionPdaFromAccount(privateInvitesOf(nt.T.table)),
    instructions: SYSVAR_INSTRUCTIONS_PUBKEY, rollup }).instruction();
  const fullBytes = await size([proof(H.wallet, H.key.publicKey, H.exp), fullIx], H.key.publicKey);
  S.check("a full list (16 wallets) and a link code fit one play-key transaction", fullBytes <= 1232, { bytes: fullBytes });

  await S.err("another wallet's play key can't set H's invites", "BadPlayKeyProof", setKeyed(I, nt.T, [entry(nt.T.table, I.wallet.publicKey)], null));
  await S.err("a play key signed for by another wallet can't either", "BadPlayKeyProof", setKeyed(U, nt.T, [entry(nt.T.table, U.wallet.publicKey)], null, U.wallet));
  // The first call creates the list empty: its transaction arrives before the list's permission exists, so
  // the TEE might not withhold it (M9c review).
  await S.err("a first call that already carries the list is refused (InvitesNotReady)", "InvitesNotReady", setKeyed(H, nt.T, sixteen, null));
  await S.ok("host's play key creates the empty private list", setKeyed(H, nt.T, null, null));
  await S.ok("creating it again is harmless", setKeyed(H, nt.T, null, null));
  let dataSig = "";
  await S.ok("host's play key sets the private list (16 wallets incl. H and I) and the link code: no wallet, no L1 rent", async () => (dataSig = await setKeyed(H, nt.T, sixteen, codeHash(nt.T.table, code))()));
  await sleep(3000);
  for (const [who, p] of [["stranger", U], ["invited player", I]] as const) {
    // The TEE answers with an empty shell (no accounts, no instructions, no logs) for a withheld transaction.
    const tx: any = await (await teeConnection(p.key)).getTransaction(dataSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch((e: any) => ({ error: String(e.message ?? e).slice(0, 80) }));
    const m = tx?.transaction?.message;
    const shown = m ? { accounts: (m.staticAccountKeys ?? m.accountKeys ?? []).length, instructions: (m.compiledInstructions ?? m.instructions ?? []).length, logs: tx.meta?.logMessages?.length ?? 0 } : null;
    S.check(`the ${who} gets nothing of the transaction that set the list`, !tx || !!tx.error || (shown!.accounts === 0 && shown!.instructions === 0 && shown!.logs === 0), { got: tx?.error ?? shown });
  }
  const hostCost = balBefore - (await connection.getBalance(H.wallet.publicKey));
  S.check("nothing about the list is on Solana", !(await connection.getAccountInfo(invitesOf(nt.T.table))) && !(await connection.getAccountInfo(privateInvitesOf(nt.T.table))), {});

  // Privacy: the list has no readers. Neither a stranger nor the host can read it from the rollup.
  for (const [who, p] of [["stranger", U], ["host", H]] as const) {
    const info = await (await teeConnection(p.key)).getAccountInfo(privateInvitesOf(nt.T.table)).catch((e: any) => ({ error: String(e.message ?? e).slice(0, 80) }) as any);
    S.check(`the ${who} can't read the private invite list from the rollup`, !info || !!info.error || !info.data?.length || info.data.every((b: number) => b === 0), { got: info && (info.error ?? info.data?.length) });
  }

  const buyIn = (p: P, T: ReturnType<typeof tableApi>, seat: number, invites: PublicKey | null, withCode?: Buffer) => {
    const hand = handOf(T.table, seat), reader = Keypair.generate();
    const accounts = {
      playKey: p.key.publicKey, wallet: p.wallet.publicKey, vault: vaultOf(p.wallet.publicKey), vaultToken: vaultTokenOf(p.wallet.publicKey), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand),
      invites, escrow: T.escrow, rollup,
    };
    const m = withCode
      ? p.er.methods.vaultBuyInCode(seat, BN(2_000_000n), reader.publicKey, BN(p.exp), Array.from(withCode))
      : p.er.methods.vaultBuyIn(seat, BN(2_000_000n), reader.publicKey, BN(p.exp));
    const b = m.accountsPartial(accounts).preInstructions([proof(p.wallet, p.key.publicKey, p.exp)]);
    return { reader, sig: () => b.rpc(), ix: () => b.instruction() };
  };
  const PI = privateInvitesOf(nt.T.table);
  // Membership oracle (M9c review): a stranger simulates a buy-in for the invited I with a forged proof of
  // I's signature. If the TEE's simulation skipped the Ed25519 check, NotInvited vs. not would tell who's invited.
  {
    const forgedMsg = playKeyMessage(U.key.publicKey, U.exp);
    const forged = proofIx(I.wallet.publicKey, forgedMsg, nacl.sign.detached(forgedMsg, U.wallet.secretKey));
    const hand = handOf(nt.T.table, 5), reader = Keypair.generate();
    const ix = await U.er.methods.vaultBuyIn(5, BN(2_000_000n), reader.publicKey, BN(U.exp)).accountsPartial({
      playKey: U.key.publicKey, wallet: I.wallet.publicKey, vault: vaultOf(I.wallet.publicKey), vaultToken: vaultTokenOf(I.wallet.publicKey), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      config: CONFIG_PDA, table: nt.T.table, ledger: nt.T.ledger, ledgerPermission: permissionPdaFromAccount(nt.T.ledger), hand, handPermission: permissionPdaFromAccount(hand),
      invites: PI, escrow: nt.T.escrow, rollup }).instruction();
    const conn = await teeConnection(U.key);
    const tx = new Transaction().add(forged, ix);
    tx.feePayer = U.key.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sim = await conn.simulateTransaction(tx).then((r) => r.value).catch((e: any) => ({ err: String(e.message ?? e).slice(0, 120), logs: [] as string[] }));
    const said = JSON.stringify(sim.err) + (sim.logs ?? []).join(" ");
    S.check("a simulated buy-in with a forged signature fails at the signature check, saying nothing about the list", !!sim.err && !said.includes("NotInvited") && JSON.stringify(sim.err).includes("[0,"), { err: sim.err });
  }
  await S.err("uninvited U can't buy in", "NotInvited", () => buyIn(U, nt.T, 1, PI).sig());
  await S.err("U can't buy in with a wrong code", "NotInvited", () => buyIn(U, nt.T, 1, PI, randomBytes(16)).sig());
  await S.err("U can't pass another account as the invite list", "NotInvited", () => buyIn(U, nt.T, 1, tokenOf(deployer.publicKey)).sig());
  const iSeat = buyIn(I, nt.T, 0, PI);
  await S.ok("invited I buys in (private list)", () => iSeat.sig());
  const uSeat = buyIn(U, nt.T, 1, PI, code);
  const codeBytes = await size([proof(U.wallet, U.key.publicKey, U.exp), await uSeat.ix()], U.key.publicKey);
  S.check("a buy-in with the link code fits one transaction", codeBytes <= 1232, { bytes: codeBytes });
  const codeSig = await S.ok("U buys in with the invite link's code", () => uSeat.sig());
  {
    const tx: any = await (await teeConnection(L.key)).getTransaction(codeSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    const m = tx?.transaction?.message;
    S.check("a stranger gets nothing of the buy-in that carried the code", !m || ((m.staticAccountKeys ?? m.accountKeys ?? []).length === 0 && (m.compiledInstructions ?? m.instructions ?? []).length === 0), { shown: !!m });
  }

  // A new link replaces the old one; the wallet list stays.
  const code2 = randomBytes(16);
  await S.ok("host makes a new link (list kept)", setKeyed(H, nt.T, null, codeHash(nt.T.table, code2)));
  await S.err("another table's private list doesn't admit here (W with code2, naming a random table's list)", "NotInvited", () => buyIn(W, nt.T, 3, privateInvitesOf(randomTablePda()), code2).sig());
  await S.err("the old link's code no longer works (L)", "NotInvited", () => buyIn(L, nt.T, 2, PI, code).sig());
  const lSeat = buyIn(L, nt.T, 2, PI, code2);
  await S.ok("the new link's code works (L)", () => lSeat.sig());
  await S.ok("host removes the link (zeros)", setKeyed(H, nt.T, null, new Array(32).fill(0)));
  await S.err("with no link, an all-zero code doesn't work (W)", "NotInvited", () => buyIn(W, nt.T, 3, PI, Buffer.alloc(16)).sig());
  await S.err("nor the last link's code (W)", "NotInvited", () => buyIn(W, nt.T, 3, PI, code2).sig());

  // ---- A table hosted before M9c: its L1 list still admits, and its rent comes back.
  const lt = await host(legacyId);
  await S.ok("legacy: host creates an invite-only table", () => sendL1(new Transaction().add(lt.cu, lt.create), [H.wallet]));
  const setL1 = await programFor(H.wallet).methods.setInvites(BN(legacyId), [inviteHash(lt.T.table, I.wallet.publicKey), inviteHash(lt.T.table, W.wallet.publicKey)])
    .accountsPartial({ creator: H.wallet.publicKey, table: lt.T.table, invites: invitesOf(lt.T.table) }).instruction();
  await S.ok("legacy: L1 invite list (I, W) and hand over", () => sendL1(new Transaction().add(setL1, lt.delegate), [H.wallet]));
  await sleep(5000);
  await S.ok("legacy: opened", () => lt.T.open(H.er, H.key.publicKey));
  const liSeat = buyIn(I, lt.T, 0, invitesOf(lt.T.table));
  await S.ok("legacy: I buys in with the L1 list", () => liSeat.sig());
  await S.err("legacy: U still refused", "NotInvited", () => buyIn(U, lt.T, 1, invitesOf(lt.T.table)).sig());
  await S.err("legacy: a table with a Solana list can't also get a private one (OldInviteList)", "OldInviteList", setKeyed(H, lt.T, null, null));
  const closeInv = (creator: Keypair, id: bigint, table: PublicKey) => programFor(creator).methods.closeInvites(BN(id))
    .accountsPartial({ creator: creator.publicKey, table, invites: invitesOf(table) }).instruction();
  await S.err("another wallet can't close H's invite list", "", async () => sendL1(new Transaction().add(await closeInv(U.wallet, legacyId, lt.T.table)), [U.wallet]));
  const ci = await closeInv(H.wallet, legacyId, lt.T.table);
  const cp = await preview([ci], H.wallet.publicKey);
  S.check("close_invites previews cleanly in a wallet", !cp.err, cp);
  const listRent = (await connection.getAccountInfo(invitesOf(lt.T.table)))?.lamports ?? 0;
  const rentBack0 = await connection.getBalance(H.wallet.publicKey);
  await S.ok("host closes the L1 invite list", () => sendL1(new Transaction().add(ci), [H.wallet]));
  const inviteRentBack = (await connection.getBalance(H.wallet.publicKey)) - rentBack0;
  S.check("all of its rent comes back to the host (less the fee)", listRent > 0 && inviteRentBack === listRent - 5000, { listRent, back: inviteRentBack });
  // Does the rollup's copy of the closed list stop admitting? (It's a clone of a Solana account.)
  await sleep(8000);
  let wLegacy: ReturnType<typeof buyIn> | null = buyIn(W, lt.T, 2, invitesOf(lt.T.table));
  try { await wLegacy.sig(); S.known("legacy: after close_invites the rollup's copy stops admitting (W, on the closed list)", true, { admitted: true }); }
  catch (e: any) { S.check("legacy: after close_invites the rollup's copy stops admitting (W, on the closed list)", errName(e).includes("NotInvited"), { got: errName(e) }); wLegacy = null; }

  // ---- Everyone leaves; the host closes both tables.
  const cashOut = async (reader: Keypair, p: P, T: ReturnType<typeof tableApi>, seat: number) => {
    const er = programOn(await teeConnection(reader), reader), hand = handOf(T.table, seat);
    return er.methods.vaultCashOut(seat, BN(0)).accountsPartial({
      signer: reader.publicKey, wallet: p.wallet.publicKey, vault: vaultOf(p.wallet.publicKey), vaultToken: vaultTokenOf(p.wallet.publicKey), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand), escrow: T.escrow, rollup,
    }).rpc();
  };
  await S.ok("I, U and L leave", async () => {
    await cashOut(iSeat.reader, I, nt.T, 0); await cashOut(uSeat.reader, U, nt.T, 1); await cashOut(lSeat.reader, L, nt.T, 2);
    if (wLegacy) await cashOut(wLegacy.reader, W, lt.T, 2);
    return cashOut(liSeat.reader, I, lt.T, 0);
  });
  const closeKeyed = (T: ReturnType<typeof tableApi>) => async () => H.er.methods.closeTableKeyed(BN(H.exp)).accountsPartial({
    signer: H.key.publicKey, config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), deck: T.deck,
    escrow: T.escrow, creatorVaultToken: vaultTokenOf(H.wallet.publicKey), devToken: tokenOf(deployer.publicKey),
    record: T.record, log: T.log, logPermission: permissionPdaFromAccount(T.log), vault: EPHEMERAL_VAULT, permissionProgram: rollup.permissionProgram,
    magicFeeVault: MAGIC_FEE_VAULT, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
  }).preInstructions([proof(H.wallet, H.key.publicKey, H.exp)]).rpc();
  await S.ok("host closes both tables (play key)", async () => { await closeKeyed(nt.T)(); return closeKeyed(lt.T)(); });
  // Refused either way: TableNotOpen while the rollup still has it, AccountOwnedByWrongProgram once it's back on Solana.
  await S.err("the closed table's list can't be changed", "", setKeyed(H, nt.T, [], null));
  let back = false;
  for (let i = 0; i < 24 && !back; i++) {
    await sleep(5000);
    const [a, b] = await connection.getMultipleAccountsInfo([nt.T.table, lt.T.table]);
    back = !!a && !!b && a.owner.equals(PROGRAM_ID) && b.owner.equals(PROGRAM_ID);
  }
  S.check("both closed tables return to Solana", back, {});
  const before = await connection.getBalance(H.wallet.publicKey);
  await S.ok("host reclaims both tables' rent", async () => sendL1(new Transaction().add(
    await programFor(H.wallet).methods.reclaimTable(BN(newId)).accountsPartial({ creator: H.wallet.publicKey, table: nt.T.table, escapePayer: escapePayerOf(nt.T.table) }).instruction(),
    await programFor(H.wallet).methods.reclaimTable(BN(legacyId)).accountsPartial({ creator: H.wallet.publicKey, table: lt.T.table, escapePayer: escapePayerOf(lt.T.table) }).instruction()), [H.wallet]));
  const reclaimed = (await connection.getBalance(H.wallet.publicKey)) - before;

  S.finish({ host: H.wallet.publicKey.toBase58(), table: nt.T.table.toBase58(), legacyTable: lt.T.table.toBase58(),
    hostCostLamports: hostCost, reclaimedBothLamports: reclaimed, inviteRentBackLamports: inviteRentBack, fullListBytes: fullBytes, codeBuyInBytes: codeBytes });
}
main().catch((e) => { console.error(e); process.exit(1); });
