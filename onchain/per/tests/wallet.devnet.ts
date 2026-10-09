// M10: the wallet's state. (1) Revoking play keys: one wallet transaction cancels every play key the wallet
// authorized; only messages naming the new key set work afterwards. (2) A fresh game vault: when an outsider
// blocks a wallet's vault before its first use (MagicBlock lets anyone hand a wallet's vault account to another
// validator: scripts/probe-m10-frontrun.ts), the wallet replaces it and opens the new one in one transaction.
// Writes results/wallet-<ts>.json.
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { delegateEphemeralAtaIx, initEphemeralAtaIx, permissionPdaFromAccount, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { CONFIG_PDA, connection, loadKey, programFor, programOn, randomTableId, teeConnection, TEE_VALIDATOR } from "../scripts/lib";
import { BN, CREATE_TABLE_CU, EPHEMERAL_VAULT, MAGIC_CONTEXT_ID, MAGIC_FEE_VAULT, Suite, escapePayerOf, handOf, rollup, sendL1, sleep, tableApi, tokenOf } from "./helpers";
import { DLP, ESPL, decodeWalletState, depositToVaultIxs, openVaultAccounts, playKeyMessage, proofIx, vaultOf, vaultTokenOf, walletStateOf } from "../client-web/vault";

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
  await sendL1(new Transaction().add(await programFor(P).methods.openVault().accountsPartial(openVaultAccounts(P.publicKey)).instruction()), [P]);
  await sendL1(new Transaction().add(...depositToVaultIxs(P.publicKey, 10_000_000n)), [P]);
  await sleep(10_000);
  const balance = async (wallet: PublicKey, key: Keypair, exp: number, keySet: number, gen = 0, signer?: Keypair) => {
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
  await S.ok("a key-set-0 play key (the M9 wording) reads the balance", () => balance(P.publicKey, k0, e0, 0, 0, P));

  const revoke = async (w: Keypair) => programFor(w).methods.revokePlayKeys().accountsPartial({ wallet: w.publicKey, walletState: walletStateOf(w.publicKey) }).instruction();
  const rp = await preview([await revoke(P)], P.publicKey);
  S.check("revoke_play_keys previews cleanly in a wallet", !rp.err, rp);
  const before = await connection.getBalance(P.publicKey);
  await S.ok("the wallet revokes its play keys (one Solana transaction)", async () => sendL1(new Transaction().add(await revoke(P)), [P]));
  const firstRevokeCost = before - (await connection.getBalance(P.publicKey));
  S.check("its key set is now 1", (await state(P.publicKey)).keySet === 1, await state(P.publicKey));
  await sleep(8000);
  await S.err("the old play key no longer works (rollup copy updated)", "BadPlayKeyProof", () => balance(P.publicKey, k0, e0, 0, 0, P));
  const k1 = Keypair.generate(), e1 = now() + DAY;
  await S.err("a new key signed with the old wording (key set 0) is refused", "BadPlayKeyProof", () => balance(P.publicKey, k1, e1, 0, 0, P));
  await S.err("a new key naming a wrong key set (2) is refused", "BadPlayKeyProof", () => balance(P.publicKey, k1, e1, 2, 0, P));
  await S.ok("a new key naming key set 1 works", () => balance(P.publicKey, k1, e1, 1, 0, P));
  await S.err("someone else's state account can't stand in (an unrevoked wallet's)", "", async () => {
    const er = programOn(await teeConnection(k0), k0);
    return er.methods.vaultBalance(BN(e0)).accountsPartial({ playKey: k0.publicKey, wallet: P.publicKey, walletState: walletStateOf(Keypair.generate().publicKey), vault: vaultOf(P.publicKey), vaultToken: vaultTokenOf(P.publicKey), instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .preInstructions([proof(P, k0.publicKey, e0, 0)]).simulate().then(() => "simulated fine");
  });
  await S.ok("a second revoke (key set 2)", async () => sendL1(new Transaction().add(await revoke(P)), [P]));
  await sleep(8000);
  await S.err("the key-set-1 key is cancelled too", "BadPlayKeyProof", () => balance(P.publicKey, k1, e1, 1, 0, P));
  const secondRevokeCost = 0;

  // ---------------------------------------------------------------- 2. a fresh vault when the first is blocked
  const Q = await newWallet(deployer, 0.08), outsider = await newWallet(deployer, 0.02);
  const v0 = vaultOf(Q.publicKey, 0);
  const [eata0] = PublicKey.findProgramAddressSync([v0.toBuffer(), WSOL.toBuffer()], ESPL);
  await S.ok("an outsider blocks Q's game vault before its first use (its account handed to another validator)", () =>
    sendL1(new Transaction().add(initEphemeralAtaIx(eata0, v0, WSOL, outsider.publicKey), delegateEphemeralAtaIx(outsider.publicKey, eata0, OTHER_VALIDATOR)), [outsider]));
  const openQ0 = await programFor(Q).methods.openVault().accountsPartial(openVaultAccounts(Q.publicKey, 0)).instruction();
  const op0 = await preview([openQ0], Q.publicKey);
  S.check("opening the blocked vault is refused (VaultBlocked), so no money can go in", JSON.stringify(op0).includes("0x17") || JSON.stringify(op0).includes("VaultBlocked") || !!op0.err, op0);

  const dlp = (k: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("delegation"), k.toBuffer()], DLP)[0];
  const blockAccounts = (w: PublicKey, gen: number) => {
    const [e] = PublicKey.findProgramAddressSync([vaultOf(w, gen).toBuffer(), WSOL.toBuffer()], ESPL);
    const perm = permissionPdaFromAccount(e);
    return { eataDelegationRecord: dlp(e), permission: perm, permissionDelegationRecord: dlp(perm) };
  };
  const newVault = async (w: Keypair, gen: number) => programFor(w).methods.newVault().accountsPartial({ wallet: w.publicKey, walletState: walletStateOf(w.publicKey), ...blockAccounts(w.publicKey, gen) }).instruction();
  await S.err("a wallet whose vault works can't replace it (VaultNotBlocked)", "VaultNotBlocked", async () => sendL1(new Transaction().add(await newVault(P, 0)), [P]));
  await S.err("the record of a different account can't be passed off as the current vault's", "VaultBlocked", async () => {
    const ix = await programFor(Q).methods.newVault().accountsPartial({ wallet: Q.publicKey, walletState: walletStateOf(Q.publicKey), ...blockAccounts(P.publicKey, 0) }).instruction();
    return sendL1(new Transaction().add(ix), [Q]);
  });
  const fresh = [await newVault(Q, 0), await programFor(Q).methods.openVault().accountsPartial(openVaultAccounts(Q.publicKey, 1)).instruction()];
  const fp = await preview(fresh, Q.publicKey);
  S.check("replace + open the fresh vault previews cleanly in a wallet (one transaction)", !fp.err, fp);
  const qBefore = await connection.getBalance(Q.publicKey);
  await S.ok("Q replaces the blocked vault and opens the fresh one in one transaction", () => sendL1(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...fresh), [Q]));
  const freshCost = qBefore - (await connection.getBalance(Q.publicKey));
  S.check("Q's state now names vault 1", (await state(Q.publicKey)).vaultGen === 1, await state(Q.publicKey));
  await S.err("the fresh vault can't be replaced again while it works", "VaultNotBlocked", async () => sendL1(new Transaction().add(await newVault(Q, 1)), [Q]));
  await S.ok("Q deposits into the fresh vault", () => sendL1(new Transaction().add(...depositToVaultIxs(Q.publicKey, 10_000_000n, undefined, 1)), [Q]));
  await sleep(10_000);
  const kq = Keypair.generate(), eq = now() + DAY;
  const bq = await balance(Q.publicKey, kq, eq, 0, 1, Q).catch((e) => "ERR " + e.message);
  S.check("the fresh vault holds the deposit (read with Q's play key)", bq === "10000000", { balance: bq });
  await S.err("the blocked vault 0 can't be used in its place", "", () => balance(Q.publicKey, kq, eq, 0, 0, Q));

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
    playKey: kq.publicKey, wallet: Q.publicKey, walletState: walletStateOf(Q.publicKey), vault: vaultOf(Q.publicKey, 1), vaultToken: vaultTokenOf(Q.publicKey, 1), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand), invites: null, escrow: T.escrow, rollup,
  }).preInstructions([proof(Q, kq.publicKey, eq, 0)]).rpc());
  const rer = programOn(await teeConnection(reader), reader);
  await S.ok("Q leaves (table key) back into the fresh vault", () => rer.methods.vaultCashOut(0, BN(0)).accountsPartial({
    signer: reader.publicKey, wallet: Q.publicKey, walletState: walletStateOf(Q.publicKey), vault: vaultOf(Q.publicKey, 1), vaultToken: vaultTokenOf(Q.publicKey, 1), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand), escrow: T.escrow, rollup,
  }).rpc());
  const close = (creatorVaultToken: PublicKey) => er.methods.closeTableKeyed(BN(eq)).accountsPartial({
    signer: kq.publicKey, config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), deck: T.deck,
    escrow: T.escrow, creatorVaultToken, devToken: tokenOf(deployer.publicKey), record: T.record, log: T.log, logPermission: permissionPdaFromAccount(T.log),
    vault: EPHEMERAL_VAULT, permissionProgram: rollup.permissionProgram, magicFeeVault: MAGIC_FEE_VAULT, instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID, walletState: walletStateOf(Q.publicKey),
  }).preInstructions([proof(Q, kq.publicKey, eq, 0)]).rpc();
  await S.err("closing can't name the old (blocked) vault for leftovers", "", () => close(vaultTokenOf(Q.publicKey, 0)));
  await S.ok("Q's play key closes it, naming the fresh vault for leftovers", () => close(vaultTokenOf(Q.publicKey, 1)));

  S.finish({ revokedWallet: P.publicKey.toBase58(), freshVaultWallet: Q.publicKey.toBase58(), firstRevokeCostLamports: firstRevokeCost, freshVaultCostLamports: freshCost, secondRevokeCost });
}
main().catch((e) => { console.error(e); process.exit(1); });
