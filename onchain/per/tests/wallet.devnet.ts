// M10: the wallet's state and exits. (1) Revoking play keys: one wallet transaction cancels every play key the
// wallet authorized; only messages naming the new key set work afterwards. (2) A fresh game vault: when an outsider
// blocks a wallet's vault before its first use (MagicBlock lets anyone hand a wallet's vault account to another
// validator: scripts/probe-m10-frontrun.ts), the wallet replaces it with one at a random seed and opens it in one
// transaction. (3) The exit (review H1): the game balance leaves through MagicBlock's shuttle with the vault as the
// owner, so an outsider blocking the wallet's own rollup account (probe-m10-h1-withdraw-block.ts) can't trap it.
// Writes results/wallet-<ts>.json.
import { randomBytes } from "crypto";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveEphemeralAta } from "@magicblock-labs/ephemeral-rollups-sdk";
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { delegateEphemeralAtaIx, initEphemeralAtaIx, permissionPdaFromAccount, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { CONFIG_PDA, connection, loadKey, programFor, programOn, randomTableId, teeConnection, TEE_VALIDATOR } from "../scripts/lib";
import { BN, CREATE_TABLE_CU, EPHEMERAL_VAULT, MAGIC_CONTEXT_ID, MAGIC_FEE_VAULT, Suite, escapePayerOf, handOf, rollup, sendL1, sleep, tableApi, tokenOf } from "./helpers";
import { DLP, ESPL, VaultSeed, decodeWalletState, depositToVaultIxs, openVaultAccounts, playKeyMessage, proofIx, vaultExitAccounts, vaultOf, vaultTokenOf, walletStateOf } from "../client-web/vault";

const S = new Suite("wallet");
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const OTHER_VALIDATOR = Keypair.generate().publicKey; // any validator but the TEE
const STAKES = { smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false };

async function newWallet(deployer: Keypair, sol: number) {
  const wallet = Keypair.generate();
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: wallet.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [deployer]);
  return wallet;
}
const state = async (w: PublicKey) => decodeWalletState((await connection.getAccountInfo(walletStateOf(w)))?.data);
const proof = (signer: Keypair, key: PublicKey, expires: number, keySet: number) => {
  const msg = playKeyMessage(key, expires, keySet);
  return proofIx(signer.publicKey, msg, nacl.sign.detached(msg, signer.secretKey));
};
async function preview(ixs: TransactionInstruction[], feePayer: PublicKey) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const v = (await connection.simulateTransaction(tx)).value;
  return { err: v.err, logs: v.err ? v.logs?.slice(-3) : undefined };
}

async function main() {
  const deployer = loadKey("deployer");

  // ---------------------------------------------------------------- 1. revoking play keys
  const P = await newWallet(deployer, 0.06);
  await sendL1(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), await programFor(P).methods.openVault().accountsPartial(openVaultAccounts(P.publicKey)).instruction()), [P]);
  await sendL1(new Transaction().add(...depositToVaultIxs(P.publicKey, 10_000_000n)), [P]);
  await sleep(10_000);
  const balance = async (wallet: PublicKey, key: Keypair, exp: number, keySet: number, gen: VaultSeed = null, signer?: Keypair) => {
    const er = programOn(await teeConnection(key), key);
    const tx = await er.methods.vaultBalance(BN(exp)).accountsPartial({ playKey: key.publicKey, wallet, walletState: walletStateOf(wallet), vault: vaultOf(wallet, gen), vaultToken: vaultTokenOf(wallet, gen), instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .preInstructions([proof(signer!, key.publicKey, exp, keySet)]).transaction();
    const conn = er.provider.connection;
    tx.feePayer = key.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(key);
    const v = (await conn.simulateTransaction(tx)).value as any;
    if (v.err) throw new Error(JSON.stringify(v.err) + " " + (v.logs ?? []).filter((l: string) => l.includes("Error")).join(" "));
    return Buffer.from(v.returnData.data[0], "base64").readBigUInt64LE(0).toString();
  };
  const k0 = Keypair.generate(), e0 = now() + DAY;
  S.check("before any revoke the wallet has no state (key set 0, vault 0)", (await state(P.publicKey)).keySet === 0, await state(P.publicKey));
  await S.ok("a key-set-0 play key (the M9 wording) reads the balance", () => balance(P.publicKey, k0, e0, 0, null, P));

  const revoke = async (w: Keypair) => programFor(w).methods.revokePlayKeys().accountsPartial({ wallet: w.publicKey, walletState: walletStateOf(w.publicKey) }).instruction();
  const rp = await preview([await revoke(P)], P.publicKey);
  S.check("revoke_play_keys previews cleanly in a wallet", !rp.err, rp);
  const before = await connection.getBalance(P.publicKey);
  await S.ok("the wallet revokes its play keys (one Solana transaction)", async () => sendL1(new Transaction().add(await revoke(P)), [P]));
  const firstRevokeCost = before - (await connection.getBalance(P.publicKey));
  S.check("its key set is now 1", (await state(P.publicKey)).keySet === 1, await state(P.publicKey));
  await sleep(8000);
  await S.err("the old play key no longer works (rollup copy updated)", "BadPlayKeyProof", () => balance(P.publicKey, k0, e0, 0, null, P));
  const k1 = Keypair.generate(), e1 = now() + DAY;
  await S.err("a new key signed with the old wording (key set 0) is refused", "BadPlayKeyProof", () => balance(P.publicKey, k1, e1, 0, null, P));
  await S.err("a new key naming a wrong key set (2) is refused", "BadPlayKeyProof", () => balance(P.publicKey, k1, e1, 2, null, P));
  await S.ok("a new key naming key set 1 works", () => balance(P.publicKey, k1, e1, 1, null, P));
  await S.err("someone else's state account can't stand in (an unrevoked wallet's)", "", async () => {
    const er = programOn(await teeConnection(k0), k0);
    return er.methods.vaultBalance(BN(e0)).accountsPartial({ playKey: k0.publicKey, wallet: P.publicKey, walletState: walletStateOf(Keypair.generate().publicKey), vault: vaultOf(P.publicKey), vaultToken: vaultTokenOf(P.publicKey), instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .preInstructions([proof(P, k0.publicKey, e0, 0)]).simulate().then(() => "simulated fine");
  });
  await S.ok("a second revoke (key set 2)", async () => sendL1(new Transaction().add(await revoke(P)), [P]));
  await sleep(8000);
  await S.err("the key-set-1 key is cancelled too", "BadPlayKeyProof", () => balance(P.publicKey, k1, e1, 1, null, P));
  const secondRevokeCost = 0;

  // ---------------------------------------------------------------- 2. a fresh vault when the first is blocked
  const Q = await newWallet(deployer, 0.08), outsider = await newWallet(deployer, 0.02);
  const v0 = vaultOf(Q.publicKey);
  const seedQ = Array.from(randomBytes(8));
  const [eata0] = PublicKey.findProgramAddressSync([v0.toBuffer(), WSOL.toBuffer()], ESPL);
  await S.ok("an outsider blocks Q's game vault before its first use (its account handed to another validator)", () =>
    sendL1(new Transaction().add(initEphemeralAtaIx(eata0, v0, WSOL, outsider.publicKey), delegateEphemeralAtaIx(outsider.publicKey, eata0, OTHER_VALIDATOR)), [outsider]));
  const openQ0 = await programFor(Q).methods.openVault().accountsPartial(openVaultAccounts(Q.publicKey)).instruction();
  const op0 = await preview([openQ0], Q.publicKey);
  S.check("opening the blocked vault is refused (VaultBlocked), so no money can go in", JSON.stringify(op0).includes("0x17") || JSON.stringify(op0).includes("VaultBlocked") || !!op0.err, op0);

  const dlp = (k: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("delegation"), k.toBuffer()], DLP)[0];
  const blockAccounts = (w: PublicKey, seed: VaultSeed) => {
    const [e] = PublicKey.findProgramAddressSync([vaultOf(w, seed).toBuffer(), WSOL.toBuffer()], ESPL);
    const perm = permissionPdaFromAccount(e);
    return { eataDelegationRecord: dlp(e), permission: perm, permissionDelegationRecord: dlp(perm), oldVaultToken: vaultTokenOf(w, seed) };
  };
  const newVault = async (w: Keypair, current: VaultSeed, next: number[]) => programFor(w).methods.newVault(next).accountsPartial({ wallet: w.publicKey, walletState: walletStateOf(w.publicKey), ...blockAccounts(w.publicKey, current) }).instruction();
  await S.err("a wallet whose vault works can't replace it (VaultNotBlocked)", "VaultNotBlocked", async () => sendL1(new Transaction().add(await newVault(P, null, Array.from(randomBytes(8)))), [P]));
  await S.err("the record of a different account can't be passed off as the current vault's", "VaultBlocked", async () => {
    const ix = await programFor(Q).methods.newVault(seedQ).accountsPartial({ wallet: Q.publicKey, walletState: walletStateOf(Q.publicKey), ...blockAccounts(P.publicKey, null) }).instruction();
    return sendL1(new Transaction().add(ix), [Q]);
  });
  await S.err("a fresh vault can't use the all-zero seed (the first vault's)", "VaultNotBlocked", async () => sendL1(new Transaction().add(await newVault(Q, null, [0, 0, 0, 0, 0, 0, 0, 0])), [Q]));
  const fresh = [await newVault(Q, null, seedQ), await programFor(Q).methods.openVault().accountsPartial(openVaultAccounts(Q.publicKey, seedQ)).instruction()];
  const fp = await preview(fresh, Q.publicKey);
  S.check("replace + open the fresh vault previews cleanly in a wallet (one transaction)", !fp.err, fp);
  const qBefore = await connection.getBalance(Q.publicKey);
  await S.ok("Q replaces the blocked vault and opens the fresh one in one transaction", () => sendL1(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...fresh), [Q]));
  const freshCost = qBefore - (await connection.getBalance(Q.publicKey));
  S.check("Q's state now names the fresh vault's random seed", JSON.stringify((await state(Q.publicKey)).vaultSeed) === JSON.stringify(seedQ), await state(Q.publicKey));
  await S.err("the fresh vault can't be replaced again while it works", "VaultNotBlocked", async () => sendL1(new Transaction().add(await newVault(Q, seedQ, Array.from(randomBytes(8)))), [Q]));
  await S.ok("Q deposits into the fresh vault", () => sendL1(new Transaction().add(...depositToVaultIxs(Q.publicKey, 10_000_000n, undefined, seedQ)), [Q]));
  await sleep(10_000);
  const kq = Keypair.generate(), eq = now() + DAY;
  const bq = await balance(Q.publicKey, kq, eq, 0, seedQ, Q).catch((e) => "ERR " + e.message);
  S.check("the fresh vault holds the deposit (read with Q's play key)", bq === "10000000", { balance: bq });
  await S.err("the blocked first vault can't be used in its place", "", () => balance(Q.publicKey, kq, eq, 0, null, Q));

  // Q hosts a table, buys in from the fresh vault, leaves, closes it with the leftover going to vault 1.
  const id = randomTableId(), T = tableApi(Q, id);
  const create = await programFor(Q).methods.createTable(BN(id), STAKES).accountsPartial({ creator: Q.publicKey, config: CONFIG_PDA, table: T.table, mint: WSOL, escrow: T.escrow, escrowEata: T.escrowEata }).instruction();
  const delegate = await programFor(Q).methods.delegateTable(BN(id), Q.publicKey).accountsPartial({ payer: Q.publicKey, table: T.table, escapePayer: escapePayerOf(T.table), validator: TEE_VALIDATOR }).instruction();
  await S.ok("Q hosts a table", () => sendL1(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_TABLE_CU + 100_000 }), create, delegate), [Q]));
  await sleep(5000);
  const er = programOn(await teeConnection(kq), kq);
  await S.ok("Q's play key opens it", () => T.open(er, kq.publicKey));
  const reader = Keypair.generate(), hand = handOf(T.table, 0);
  await S.ok("Q buys in from the fresh vault (play key)", () => er.methods.vaultBuyIn(0, BN(2_000_000n), reader.publicKey, BN(eq)).accountsPartial({
    playKey: kq.publicKey, wallet: Q.publicKey, walletState: walletStateOf(Q.publicKey), vault: vaultOf(Q.publicKey, seedQ), vaultToken: vaultTokenOf(Q.publicKey, seedQ), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand), invites: null, escrow: T.escrow, rollup,
  }).preInstructions([proof(Q, kq.publicKey, eq, 0)]).rpc());
  const rer = programOn(await teeConnection(reader), reader);
  await S.ok("Q leaves (table key) back into the fresh vault", () => rer.methods.vaultCashOut(0, BN(0)).accountsPartial({
    signer: reader.publicKey, wallet: Q.publicKey, walletState: walletStateOf(Q.publicKey), vault: vaultOf(Q.publicKey, seedQ), vaultToken: vaultTokenOf(Q.publicKey, seedQ), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand), escrow: T.escrow, rollup,
  }).rpc());
  const close = (creatorVaultToken: PublicKey) => er.methods.closeTableKeyed(BN(eq)).accountsPartial({
    signer: kq.publicKey, config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), deck: T.deck,
    escrow: T.escrow, creatorVaultToken, devToken: tokenOf(deployer.publicKey), record: T.record, log: T.log, logPermission: permissionPdaFromAccount(T.log),
    vault: EPHEMERAL_VAULT, permissionProgram: rollup.permissionProgram, magicFeeVault: MAGIC_FEE_VAULT, instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID, walletState: walletStateOf(Q.publicKey),
  }).preInstructions([proof(Q, kq.publicKey, eq, 0)]).rpc();
  await S.err("closing can't name the old (blocked) vault for leftovers", "", () => close(vaultTokenOf(Q.publicKey)));
  await S.ok("Q's play key closes it, naming the fresh vault for leftovers", () => close(vaultTokenOf(Q.publicKey, seedQ)));

  // ---------------------------------------------------------------- 3. the exit (review H1)
  const R = await newWallet(deployer, 0.06);
  await sendL1(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), await programFor(R).methods.openVault().accountsPartial(openVaultAccounts(R.publicKey)).instruction()), [R]);
  await sendL1(new Transaction().add(...depositToVaultIxs(R.publicKey, 10_000_000n)), [R]);
  await sleep(10_000);
  const [rEata] = deriveEphemeralAta(R.publicKey, NATIVE_MINT);
  await S.ok("an outsider blocks R's own rollup wSOL account (the M9 withdrawal can then never pay R)", () =>
    sendL1(new Transaction().add(initEphemeralAtaIx(rEata, R.publicKey, WSOL, outsider.publicKey), delegateEphemeralAtaIx(outsider.publicKey, rEata, OTHER_VALIDATOR)), [outsider]));
  const exitIx = async (w: Keypair, amount: bigint, seed?: VaultSeed, accounts?: any) => {
    const id = Math.floor(Math.random() * 2 ** 32);
    return programFor(w).methods.vaultExit(id, BN(amount)).accountsPartial(accounts ?? vaultExitAccounts(w.publicKey, id, seed)).instruction();
  };
  const ep = await preview([await exitIx(R, 6_000_000n)], R.publicKey);
  S.check("vault_exit previews cleanly in a wallet", !ep.err, ep);
  await S.err("another wallet can't exit with R's vault", "", async () => {
    const id = Math.floor(Math.random() * 2 ** 32);
    const acc = { ...vaultExitAccounts(R.publicKey, id), wallet: outsider.publicKey, walletState: walletStateOf(outsider.publicKey) };
    return sendL1(new Transaction().add(await programFor(outsider).methods.vaultExit(id, BN(1_000_000)).accountsPartial(acc).instruction()), [outsider]);
  });
  await S.ok("R takes 0.006 SOL out of the rollup (vault as the owner; R's blocked account isn't involved)", async () => sendL1(new Transaction().add(await exitIx(R, 6_000_000n)), [R]));
  let landed = 0n;
  for (let i = 0; i < 24 && landed === 0n; i++) {
    await sleep(5000);
    landed = BigInt(await connection.getBalance(vaultOf(R.publicKey)));
  }
  S.check("the 0.006 SOL arrives on the vault on Solana (MagicBlock pays the owner in SOL)", landed === 6_000_000n, { landed: landed.toString() });
  const rAta = getAssociatedTokenAddressSync(NATIVE_MINT, R.publicKey);
  const payout = async (w: Keypair, walletToken = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey)) =>
    programFor(w).methods.vaultPayout().accountsPartial({ wallet: w.publicKey, walletState: walletStateOf(w.publicKey), vault: vaultOf(w.publicKey), vaultToken: vaultTokenOf(w.publicKey), walletToken }).instruction();
  await S.err("the payout can't go to another wallet's account", "", async () =>
    sendL1(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(R.publicKey, getAssociatedTokenAddressSync(NATIVE_MINT, outsider.publicKey), outsider.publicKey, NATIVE_MINT), await payout(R, getAssociatedTokenAddressSync(NATIVE_MINT, outsider.publicKey))), [R]));
  const rBefore = await connection.getBalance(R.publicKey);
  const pp = await preview([createAssociatedTokenAccountIdempotentInstruction(R.publicKey, rAta, R.publicKey, NATIVE_MINT), await payout(R), createCloseAccountInstruction(rAta, R.publicKey, R.publicKey)], R.publicKey);
  S.check("payout + unwrap previews cleanly in a wallet", !pp.err, pp);
  await S.ok("R is paid as SOL (payout and unwrap in one transaction)", async () => sendL1(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(R.publicKey, rAta, R.publicKey, NATIVE_MINT), await payout(R), createCloseAccountInstruction(rAta, R.publicKey, R.publicKey)), [R]));
  const got = (await connection.getBalance(R.publicKey)) - rBefore;
  S.check("R's wallet gained the 0.006 SOL (less the fee)", got >= 6_000_000 - 10_000, { lamports: got });
  const kr = Keypair.generate(), er_ = now() + DAY;
  const left = await balance(R.publicKey, kr, er_, 0, null, R).catch((e) => "ERR " + e.message);
  S.check("the rest (0.004 SOL) is still R's game balance in the rollup", left === "4000000", { balance: left });

  S.finish({ revokedWallet: P.publicKey.toBase58(), freshVaultWallet: Q.publicKey.toBase58(), exitWallet: R.publicKey.toBase58(), firstRevokeCostLamports: firstRevokeCost, freshVaultCostLamports: freshCost, exitLamports: got });
}
main().catch((e) => { console.error(e); process.exit(1); });
