// M9: game vault and play keys on devnet. The wallet signs only L1 transactions (open_vault, deposit,
// withdrawal: each previewed here exactly as a wallet does) and one message per play key. Everything in
// the rollup is signed by the play key or the seat's table key. Covers the money path end to end plus
// the attacks the review gate names. Writes results/vault-<ts>.json.
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createEataPermissionIx, delegateEataPermissionIx, initEphemeralAtaIx, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import nacl from "tweetnacl";
import { CONFIG_PDA, connection, loadKey, programFor, programOn, randomTableId, teeConnection, TEE_VALIDATOR } from "../scripts/lib";
import { BN, DLP, Suite, handOf, rollup, sendL1, sleep, tableApi, tokenOf } from "./helpers";
import { depositToVaultIxs, ensureWalletInRollupIxs, openVaultAccounts, playKeyMessage, proofIx, vaultOf, vaultTokenOf, walletTokenOf, withdrawToWalletIxs } from "../client-web/vault";

const S = new Suite("vault");
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

/** A wallet with a funded L1 balance and its play key. */
async function newPlayer(deployer: Keypair, sol: number) {
  const wallet = Keypair.generate(), key = Keypair.generate();
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: wallet.publicKey, lamports: sol * LAMPORTS_PER_SOL })), [deployer]);
  return { wallet, key, er: programOn(await teeConnection(key), key) };
}

/** `signer`'s Ed25519-checked signature authorizing `key` until `expires`. The program accepts it
 *  only for the wallet that signed (the check's public key must be the instruction's wallet). */
const proof = (signer: Keypair, key: PublicKey, expires: number) => {
  const msg = playKeyMessage(key, expires);
  return proofIx(signer.publicKey, msg, nacl.sign.detached(msg, signer.secretKey));
};

/** Previews a transaction the way a wallet does: simulated on Solana, unsigned, no signature checks. */
async function preview(ixs: TransactionInstruction[], feePayer: PublicKey) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const v = (await connection.simulateTransaction(tx)).value;
  return { err: v.err, logs: v.err ? v.logs?.slice(-4) : undefined };
}

async function main() {
  const deployer = loadKey("deployer"), p3 = loadKey("p3");
  const A = await newPlayer(deployer, 0.08), B = await newPlayer(deployer, 0.08);
  const expA = now() + 7 * DAY, expB = now() + 7 * DAY;
  const W = (p: { wallet: Keypair }) => p.wallet.publicKey;

  // ---- L1: open the vault and deposit. Both must preview cleanly in a wallet.
  const openIx = async (p: { wallet: Keypair }) => programFor(p.wallet).methods.openVault().accountsPartial(openVaultAccounts(W(p))).instruction();
  const openPreview = await preview([await openIx(A)], W(A));
  S.check("open_vault previews cleanly on Solana (no wallet warning)", !openPreview.err, openPreview);
  await S.ok("A opens its vault", async () => sendL1(new Transaction().add(await openIx(A)), [A.wallet]));
  const accts = openVaultAccounts(W(A));
  const eata = await connection.getAccountInfo(accts.vaultEata), perm = await connection.getAccountInfo(accts.vaultPermission);
  S.check("vault's token account and its permission are delegated to the rollup", eata?.owner.equals(DLP) === true && perm?.owner.equals(DLP) === true, { eata: eata?.owner.toBase58(), permission: perm?.owner.toBase58() });
  await S.ok("open_vault again is harmless (idempotent)", async () => sendL1(new Transaction().add(await openIx(A)), [A.wallet]));
  await S.ok("B opens its vault", async () => sendL1(new Transaction().add(await openIx(B)), [B.wallet]));

  const depositPreview = await preview(depositToVaultIxs(W(A), 20_000_000n), W(A));
  S.check("deposit into the vault previews cleanly on Solana", !depositPreview.err, depositPreview);
  await S.ok("A deposits 0.02 SOL into its vault", () => sendL1(new Transaction().add(...depositToVaultIxs(W(A), 20_000_000n)), [A.wallet]));
  await S.ok("B deposits 0.02 SOL into its vault", () => sendL1(new Transaction().add(...depositToVaultIxs(W(B), 20_000_000n)), [B.wallet]));

  const balance = async (p: typeof A, exp: number, signer: Keypair = p.wallet, wallet = W(p)) => {
    const tx = await p.er.methods.vaultBalance(BN(exp)).accountsPartial({ playKey: p.key.publicKey, wallet, vault: vaultOf(wallet), vaultToken: vaultTokenOf(wallet), instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .preInstructions([proof(signer, p.key.publicKey, exp)]).transaction();
    const conn = p.er.provider.connection;
    tx.feePayer = p.key.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(p.key);
    const v = (await conn.simulateTransaction(tx)).value as any;
    if (v.err) throw new Error(JSON.stringify(v.err));
    return Buffer.from(v.returnData.data[0], "base64").readBigUInt64LE(0);
  };
  let balA = 0n;
  for (let i = 0; i < 12 && balA !== 20_000_000n; i++) { await sleep(5000); balA = await balance(A, expA).catch(() => -1n); }
  // The rollup copies a delegated account from its Solana snapshot when it first needs it, so the
  // snapshot is what it will hold. Byte 34 is the member list's Option tag: 0 = public.
  const permL1 = await connection.getAccountInfo(accts.vaultPermission);
  const permTee = await (await teeConnection(deployer)).getAccountInfo(accts.vaultPermission);
  S.check("the vault's permission was made public before it was handed to the rollup (nobody can make it private)",
    !!permL1 && permL1.data[34] === 0 && (!permTee || permTee.data[34] === 0), { snapshot: permL1?.data[34], inRollup: permTee ? permTee.data[34] : "not copied yet" });
  S.check("the deposit lands in the vault in the rollup (read with the play key)", balA === 20_000_000n, { balA: balA.toString() });
  S.check("vault balance needs the wallet's signature: B's key with A's wallet but B's signature is refused", await balance(B, expB, B.wallet, W(A)).then(() => false, () => true), {});

  // ---- Front-running (the M3 escrow-freeze lesson): an outsider claims a wallet's vault permission
  // before the wallet opens its vault. Anyone can create a flags-0 permission on any ephemeral token
  // account, and anyone can delegate it.
  {
    const C = await newPlayer(deployer, 0.05), c = openVaultAccounts(W(C));
    await S.ok("outsider pre-creates C's vault token account and a flags-0 permission on it", () =>
      sendL1(new Transaction().add(initEphemeralAtaIx(c.vaultEata, c.vault, NATIVE_MINT, p3.publicKey), createEataPermissionIx(c.vaultEata, p3.publicKey, 0)), [p3]));
    await S.ok("C opens its vault anyway", async () => sendL1(new Transaction().add(await openIx(C)), [C.wallet]));
    const pc = await connection.getAccountInfo(c.vaultPermission);
    S.check("C's vault permission ends up public and delegated (the vault, its authority, made it public)", pc?.owner.equals(DLP) === true && pc.data[34] === 0, { owner: pc?.owner.toBase58(), byte34: pc?.data[34] });
    await S.ok("C deposits", () => sendL1(new Transaction().add(...depositToVaultIxs(W(C), 5_000_000n)), [C.wallet]));
    let bc = -1n; const expC = now() + DAY;
    for (let i = 0; i < 12 && bc !== 5_000_000n; i++) { await sleep(5000); bc = await balance(C, expC).catch(() => -1n); }
    S.check("C's vault works", bc === 5_000_000n, { balance: bc.toString() });

    const D = await newPlayer(deployer, 0.05), d = openVaultAccounts(W(D));
    const r = await sendL1(new Transaction().add(initEphemeralAtaIx(d.vaultEata, d.vault, NATIVE_MINT, p3.publicKey), createEataPermissionIx(d.vaultEata, p3.publicKey, 0),
      delegateEataPermissionIx(p3.publicKey, d.vaultEata, TEE_VALIDATOR)), [p3]).then(() => "sent", (e: any) => "rejected: " + String(e.message ?? e).slice(0, 120));
    const openD = await sendL1(new Transaction().add(await openIx(D)), [D.wallet]).then(() => "opened", (e: any) => "failed: " + String(e.message ?? e).slice(0, 120));
    let bd = -1n, depositD = "skipped";
    if (openD === "opened") {
      depositD = await sendL1(new Transaction().add(...depositToVaultIxs(W(D), 5_000_000n)), [D.wallet]).then(() => "sent", (e: any) => "failed: " + String(e.message ?? e).slice(0, 120));
      const expD = now() + DAY;
      for (let i = 0; i < 8 && bd !== 5_000_000n; i++) { await sleep(5000); bd = await balance(D, expD).catch(() => -1n); }
    }
    S.known("LIMIT: an outsider who also delegates a wallet's vault permission before the wallet's first open_vault can block that vault (MagicBlock lets anyone delegate it)",
      r === "sent" && bd !== 5_000_000n, { outsider: r, openVault: openD, deposit: depositD, balanceAfter: bd.toString() });
  }

  // ---- A table; buy-ins from the vault, signed by play keys.
  const T = tableApi(deployer, randomTableId());
  const erD = programOn(await teeConnection(deployer), deployer);
  await S.ok("create, delegate and open a table", async () => {
    await T.create({ smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false });
    await T.delegate(); await sleep(4000);
    return T.open(erD, deployer.publicKey);
  });
  const readerA = Keypair.generate(), readerB = Keypair.generate();
  const buyIn = (p: typeof A, seat: number, amount: bigint, reader: PublicKey, exp: number, o: { proofIxs?: TransactionInstruction[]; wallet?: PublicKey } = {}) => {
    const wallet = o.wallet ?? W(p), hand = handOf(T.table, seat);
    return p.er.methods.vaultBuyIn(seat, BN(amount), reader, BN(exp)).accountsPartial({
      playKey: p.key.publicKey, wallet, vault: vaultOf(wallet), vaultToken: vaultTokenOf(wallet), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand),
      invites: null, escrow: T.escrow, rollup,
    }).preInstructions(o.proofIxs ?? [proof(p.wallet, p.key.publicKey, exp)]).rpc();
  };

  await S.err("no wallet signature check before the buy-in: refused", "BadPlayKeyProof", () => buyIn(A, 0, 2_000_000n, readerA.publicKey, expA, { proofIxs: [] }));
  await S.err("signature check not directly before the buy-in: refused", "BadPlayKeyProof",
    () => buyIn(A, 0, 2_000_000n, readerA.publicKey, expA, { proofIxs: [proof(A.wallet, A.key.publicKey, expA), ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })] }));
  await S.err("message signed for a different play key: refused", "BadPlayKeyProof",
    () => buyIn(A, 0, 2_000_000n, readerA.publicKey, expA, { proofIxs: [proof(A.wallet, Keypair.generate().publicKey, expA)] }));
  await S.err("message signed with a different expiry: refused", "BadPlayKeyProof",
    () => buyIn(A, 0, 2_000_000n, readerA.publicKey, expA, { proofIxs: [proof(A.wallet, A.key.publicKey, expA + 60)] }));
  await S.err("expired authorization: refused", "PlayKeyExpired", () => buyIn(A, 0, 2_000_000n, readerA.publicKey, now() - 120));
  await S.err("authorization beyond 30 days: refused", "PlayKeyExpired", () => buyIn(A, 0, 2_000_000n, readerA.publicKey, now() + 40 * DAY));
  await S.err("A's play key, with A's signature, buying in from B's vault: refused", "BadPlayKeyProof",
    () => buyIn(A, 0, 2_000_000n, readerA.publicKey, expA, { wallet: W(B), proofIxs: [proof(A.wallet, A.key.publicKey, expA)] }));

  {
    const hand = handOf(T.table, 0);
    const tx = await A.er.methods.vaultBuyIn(0, BN(4_000_000n), readerA.publicKey, BN(expA)).accountsPartial({
      playKey: A.key.publicKey, wallet: W(A), vault: vaultOf(W(A)), vaultToken: vaultTokenOf(W(A)), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand),
      invites: null, escrow: T.escrow, rollup,
    }).preInstructions([proof(A.wallet, A.key.publicKey, expA)]).transaction();
    tx.feePayer = A.key.publicKey; tx.recentBlockhash = (await A.er.provider.connection.getLatestBlockhash()).blockhash; tx.sign(A.key);
    const size = tx.serialize().length;
    S.check("a play-key buy-in fits Solana's 1,232-byte limit with room to spare", size <= 1_150, { bytes: size, limit: 1232 });
    const signers = tx.signatures.map((x) => x.publicKey.toBase58());
    S.check("only the play key signs the buy-in (the wallet never signs a rollup transaction)", signers.length === 1 && signers[0] === A.key.publicKey.toBase58(), { signers });
  }
  await S.ok("A buys in 0.004 SOL from its vault (play key signs; no wallet)", () => buyIn(A, 0, 4_000_000n, readerA.publicKey, expA));
  await S.ok("B buys in 0.004 SOL from its vault", () => buyIn(B, 1, 4_000_000n, readerB.publicKey, expB));
  S.check("A's vault went down by the buy-in", (await balance(A, expA)) === 16_000_000n, { balA: (await balance(A, expA)).toString() });

  // ---- Cash-outs into the vault.
  const readerConn = async (k: Keypair) => programOn(await teeConnection(k), k);
  const cashOutAs = async (signer: Keypair, seat: number, wallet: PublicKey, exp: number, signerOfMessage?: Keypair) => {
    const er = await readerConn(signer);
    const hand = handOf(T.table, seat);
    return er.methods.vaultCashOut(seat, BN(exp)).accountsPartial({
      signer: signer.publicKey, wallet, vault: vaultOf(wallet), vaultToken: vaultTokenOf(wallet), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand), escrow: T.escrow, rollup,
    }).preInstructions(exp ? [proof(signerOfMessage!, signer.publicKey, exp)] : []).rpc();
  };
  await S.err("B's table key cashing out A's seat: refused", "NotSeatKey", () => cashOutAs(readerB, 0, W(A), 0));
  await S.err("B's play key (B's signature) cashing out A's seat into A's vault: refused", "NotSeatKey", () => cashOutAs(B.key, 0, W(A), expB, B.wallet));
  await S.err("cashing A's seat out into B's vault: refused", "NotSeated", () => cashOutAs(readerA, 0, W(B), 0));
  const before = await balance(A, expA);
  await S.ok("A's table key cashes A out into A's vault (no wallet)", () => cashOutAs(readerA, 0, W(A), 0));
  const afterA = await balance(A, expA);
  S.check("A's vault got the stack back (buy-in minus rake)", afterA > before && afterA - before <= 4_000_000n, { before: before.toString(), after: afterA.toString() });
  await S.ok("lost table key: B's play key cashes B's seat out", () => cashOutAs(B.key, 1, W(B), expB, B.wallet));

  // ---- Withdraw: play key moves vault -> wallet's rollup balance; the wallet withdraws on Solana.
  const ensurePreview = await preview(await ensureWalletInRollupIxs(W(A)), W(A));
  S.check("making the wallet's rollup account previews cleanly", !ensurePreview.err, ensurePreview);
  await S.ok("A's wallet account is set up in the rollup (L1)", async () => sendL1(new Transaction().add(...(await ensureWalletInRollupIxs(W(A)))), [A.wallet]));
  await sleep(5000);
  const withdraw = (p: typeof A, amount: bigint, exp: number, o: { walletToken?: PublicKey; wallet?: PublicKey; signer?: Keypair } = {}) => {
    const wallet = o.wallet ?? W(p);
    return p.er.methods.vaultWithdraw(BN(amount), BN(exp)).accountsPartial({
      playKey: p.key.publicKey, wallet, vault: vaultOf(wallet), vaultToken: vaultTokenOf(wallet), walletToken: o.walletToken ?? walletTokenOf(wallet), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    }).preInstructions([proof(o.signer ?? p.wallet, p.key.publicKey, exp)]).rpc();
  };
  await S.err("withdrawing A's vault to another wallet's account: refused", "ConstraintAddress", () => withdraw(A, 1_000_000n, expA, { walletToken: walletTokenOf(W(B)) }));
  await S.err("B's play key withdrawing from A's vault: refused", "BadPlayKeyProof", () => withdraw(B, 1_000_000n, expB, { wallet: W(A), signer: B.wallet }));
  const amount = await balance(A, expA);
  await S.ok("A's play key moves the whole vault to A's rollup balance", () => withdraw(A, amount, expA));
  S.check("A's vault is empty", (await balance(A, expA)) === 0n, {});
  const walletRollup = await (await teeConnection(A.wallet)).getTokenAccountBalance(walletTokenOf(W(A))).then((b) => BigInt(b.value.amount), () => -1n);
  S.check("A's own rollup balance holds it (read with A's login)", walletRollup === amount, { walletRollup: walletRollup.toString(), amount: amount.toString() });
  const wPreview = await preview(await withdrawToWalletIxs(W(A), amount), W(A));
  S.check("the withdrawal to Solana previews cleanly", !wPreview.err, wPreview);
  const l1Before = await connection.getBalance(W(A));
  await S.ok("A withdraws to Solana (L1)", async () => sendL1(new Transaction().add(...(await withdrawToWalletIxs(W(A), amount))), [A.wallet]));
  let l1After = l1Before, wsol = 0n;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    l1After = await connection.getBalance(W(A));
    wsol = await connection.getTokenAccountBalance(tokenOf(W(A))).then((b) => BigInt(b.value.amount), () => 0n);
    if (BigInt(l1After - l1Before) >= amount - 1_000_000n) break;
  }
  // MagicBlock's withdrawal unwraps: it arrives as SOL, less MagicBlock's withdrawal cost (~0.0005 SOL).
  S.check("the money arrives in A's wallet on Solana as SOL", BigInt(l1After - l1Before) >= amount - 1_000_000n, { amount: amount.toString(), solBefore: l1Before, solAfter: l1After, wsol: wsol.toString() });

  // ---- The old wallet-signed path still works.
  const erP3 = programOn(await teeConnection(p3), p3);
  await S.ok("wallet-signed buy-in still works (p3)", () => T.buyIn(erP3, p3.publicKey, 2, 2_000_000n));
  await S.ok("wallet-signed cash-out still works (p3)", () => T.cashOut(erP3, p3.publicKey, 2));
  await S.ok("collect rake and close the table", async () => { await T.collectRake(erD, tokenOf(deployer.publicKey)); return T.close(erD, deployer.publicKey); });

  S.finish({ table: T.table.toBase58(), walletA: W(A).toBase58(), walletB: W(B).toBase58(), vaultA: vaultOf(W(A)).toBase58() });
}
main().catch((e) => { console.error(e); process.exit(1); });
