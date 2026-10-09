// M9b: hosting a table from the game. The host's wallet signs only Solana transactions it can preview
// (create + hand over to the rollup, the invite list, reclaiming the rent); opening and closing in the
// rollup are signed by the host's play key, and the backend's keeper can close a table left empty and
// idle. Covers invite-only tables and the attacks on closing. Writes results/host-<ts>.json.
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { CONFIG_PDA, connection, loadKey, programFor, programOn, randomTableId, teeConnection, TEE_VALIDATOR } from "../scripts/lib";
import { BN, CREATE_TABLE_CU, EPHEMERAL_VAULT, MAGIC_CONTEXT_ID, MAGIC_FEE_VAULT, Suite, escapePayerOf, handOf, inviteHash, invitesOf, rollup, sendL1, sleep, tableApi, tokenOf } from "./helpers";
import { depositToVaultIxs, openVaultAccounts, playKeyMessage, proofIx, vaultOf, vaultTokenOf } from "../client-web/vault";
import { MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

const S = new Suite("host");
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const STAKES = { smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6 };

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
const size = async (ixs: TransactionInstruction[], payer: Keypair) => {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash; tx.sign(payer);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
};

async function main() {
  const deployer = loadKey("deployer");
  const H = await newPlayer(deployer, 0.15), I = await newPlayer(deployer, 0.06), U = await newPlayer(deployer, 0.06);
  for (const p of [H, I, U]) {
    await sendL1(new Transaction().add(await programFor(p.wallet).methods.openVault().accountsPartial(openVaultAccounts(p.wallet.publicKey)).instruction()), [p.wallet]);
    await sendL1(new Transaction().add(...depositToVaultIxs(p.wallet.publicKey, 10_000_000n)), [p.wallet]);
  }
  await sleep(12_000);

  // ---- The host creates tables: create + hand over to the rollup (L1, the host's wallet signs).
  const hostIxs = async (id: bigint, inviteOnly: boolean) => {
    const T = tableApi(H.wallet, id);
    const create = await programFor(H.wallet).methods.createTable(BN(id), { ...STAKES, inviteOnly })
      .accountsPartial({ creator: H.wallet.publicKey, config: CONFIG_PDA, table: T.table, mint: new PublicKey("So11111111111111111111111111111111111111112"), escrow: T.escrow, escrowEata: T.escrowEata }).instruction();
    const delegate = await programFor(H.wallet).methods.delegateTable(BN(id), H.wallet.publicKey)
      .accountsPartial({ payer: H.wallet.publicKey, table: T.table, escapePayer: escapePayerOf(T.table), validator: TEE_VALIDATOR }).instruction();
    return { T, cu: ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_TABLE_CU + 100_000 }), create, delegate };
  };
  const pubId = randomTableId(), invId = randomTableId();
  const pub = await hostIxs(pubId, false), inv = await hostIxs(invId, true);
  const createPreview = await preview([pub.cu, pub.create], H.wallet.publicKey);
  S.check("create_table previews cleanly in a wallet", !createPreview.err, createPreview);
  const oneTx = await size([pub.cu, pub.create, pub.delegate], H.wallet).catch(() => 9999);
  S.check("create + hand over fit one transaction (one Phantom approval)", oneTx <= 1232, { bytes: oneTx });
  const balBefore = await connection.getBalance(H.wallet.publicKey);
  if (oneTx <= 1232) await S.ok("host creates and hands over a public table in one transaction", () => sendL1(new Transaction().add(pub.cu, pub.create, pub.delegate), [H.wallet]));
  else {
    await S.ok("host creates a public table", () => sendL1(new Transaction().add(pub.cu, pub.create), [H.wallet]));
    const dp = await preview([pub.delegate], H.wallet.publicKey);
    S.check("delegate_table previews cleanly in a wallet", !dp.err, dp);
    await S.ok("host hands it over to the rollup", () => sendL1(new Transaction().add(pub.delegate), [H.wallet]));
  }
  const hostCost = balBefore - (await connection.getBalance(H.wallet.publicKey));

  // Invite-only: the invite list is an L1 account of hashes (table, wallet).
  await S.ok("host creates an invite-only table", () => sendL1(new Transaction().add(inv.cu, inv.create), [H.wallet]));
  const setInv = await programFor(H.wallet).methods.setInvites(BN(invId), [inviteHash(inv.T.table, I.wallet.publicKey)])
    .accountsPartial({ creator: H.wallet.publicKey, table: inv.T.table, invites: invitesOf(inv.T.table) }).instruction();
  const invPreview = await preview([setInv], H.wallet.publicKey);
  S.check("set_invites previews cleanly in a wallet", !invPreview.err, invPreview);
  await S.ok("host invites I", () => sendL1(new Transaction().add(setInv, inv.delegate), [H.wallet]));
  await sleep(5000);

  // ---- Opening is in the rollup and permissionless: the host's play key pays nothing and signs.
  await S.ok("host's play key opens both tables (no wallet)", async () => { await pub.T.open(H.er, H.key.publicKey); return inv.T.open(H.er, H.key.publicKey); });
  const tFresh: any = await (programOn(await teeConnection(deployer), deployer).account as any).table.fetch(pub.T.table);
  S.check("opening stamps the table's activity with rollup time (the abandoned rule counts from the open)", Math.abs(Number(tFresh.lastActivityTs) - now()) < 120, { lastActivityTs: Number(tFresh.lastActivityTs), now: now() });

  // ---- Buy-ins from game balances; invite-only enforced.
  const buyIn = (p: P, T: ReturnType<typeof tableApi>, seat: number, invites: PublicKey | null) => {
    const hand = handOf(T.table, seat), reader = Keypair.generate();
    return { reader, sig: () => p.er.methods.vaultBuyIn(seat, BN(2_000_000n), reader.publicKey, BN(p.exp)).accountsPartial({
      playKey: p.key.publicKey, wallet: p.wallet.publicKey, vault: vaultOf(p.wallet.publicKey), vaultToken: vaultTokenOf(p.wallet.publicKey), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand),
      invites, escrow: T.escrow, rollup,
    }).preInstructions([proof(p.wallet, p.key.publicKey, p.exp)]).rpc() };
  };
  await S.err("uninvited U can't buy in at the invite-only table", "NotInvited", () => buyIn(U, inv.T, 0, invitesOf(inv.T.table)).sig());
  const iSeat = buyIn(I, inv.T, 0, invitesOf(inv.T.table));
  await S.ok("invited I buys in at the invite-only table", () => iSeat.sig());
  const uSeat = buyIn(U, pub.T, 0, null);
  await S.ok("U buys in at the public table", () => uSeat.sig());

  // ---- Closing.
  const closeKeyed = (signerKey: Keypair, T: ReturnType<typeof tableApi>, expires: number, signerOfMessage?: Keypair, creatorVault = true) => async () => {
    const er = programOn(await teeConnection(signerKey), signerKey);
    return er.methods.closeTableKeyed(BN(expires)).accountsPartial({
      signer: signerKey.publicKey, config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), deck: T.deck,
      escrow: T.escrow, creatorVaultToken: creatorVault ? vaultTokenOf(H.wallet.publicKey) : null, devToken: tokenOf(deployer.publicKey),
      record: T.record, log: T.log, logPermission: permissionPdaFromAccount(T.log), vault: EPHEMERAL_VAULT, permissionProgram: rollup.permissionProgram,
      magicFeeVault: MAGIC_FEE_VAULT, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
    }).preInstructions(expires ? [proof(signerOfMessage ?? signerKey, signerKey.publicKey, expires)] : []).rpc();
  };
  await S.err("host's play key can't close while someone is seated", "TableNotEmpty", closeKeyed(H.key, inv.T, H.exp, H.wallet));
  const cashOut = async (reader: Keypair, p: P, T: ReturnType<typeof tableApi>, seat: number) => {
    const er = programOn(await teeConnection(reader), reader), hand = handOf(T.table, seat);
    return er.methods.vaultCashOut(seat, BN(0)).accountsPartial({
      signer: reader.publicKey, wallet: p.wallet.publicKey, vault: vaultOf(p.wallet.publicKey), vaultToken: vaultTokenOf(p.wallet.publicKey), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand), escrow: T.escrow, rollup,
    }).rpc();
  };
  await S.ok("I leaves (table key)", () => cashOut(iSeat.reader, I, inv.T, 0));
  await S.err("a stranger can't close a table that isn't abandoned (expires 0)", "TableActive", closeKeyed(Keypair.generate(), inv.T, 0));
  await S.err("I's play key (I's signature) can't close H's table", "BadPlayKeyProof", closeKeyed(I.key, inv.T, I.exp, I.wallet));
  await S.err("a forged signature for H can't close it", "0x2", async () => {
    const er = programOn(await teeConnection(U.key), U.key);
    const msg = playKeyMessage(U.key.publicKey, U.exp), sig = nacl.sign.detached(msg, U.wallet.secretKey);
    return er.methods.closeTableKeyed(BN(U.exp)).accountsPartial({
      signer: U.key.publicKey, config: CONFIG_PDA, table: inv.T.table, ledger: inv.T.ledger, ledgerPermission: permissionPdaFromAccount(inv.T.ledger), deck: inv.T.deck,
      escrow: inv.T.escrow, creatorVaultToken: vaultTokenOf(H.wallet.publicKey), devToken: tokenOf(deployer.publicKey), record: inv.T.record, log: inv.T.log,
      logPermission: permissionPdaFromAccount(inv.T.log), vault: EPHEMERAL_VAULT, permissionProgram: rollup.permissionProgram, magicFeeVault: MAGIC_FEE_VAULT,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
    }).preInstructions([proofIx(H.wallet.publicKey, msg, sig)]).rpc();
  });
  await S.ok("host's play key closes the empty invite-only table (rake collected first; table pays the commit)", closeKeyed(H.key, inv.T, H.exp, H.wallet));

  // ---- Reclaim on L1 once the table is back and closed.
  let back = false;
  for (let i = 0; i < 18 && !back; i++) {
    await sleep(5000);
    const info = await connection.getAccountInfo(inv.T.table);
    back = !!info && info.owner.equals(programFor(H.wallet).programId);
  }
  S.check("the closed table returns to Solana", back, {});
  const reclaimIx = await programFor(H.wallet).methods.reclaimTable(BN(invId)).accountsPartial({ creator: H.wallet.publicKey, table: inv.T.table, escapePayer: escapePayerOf(inv.T.table) }).instruction();
  const rp = await preview([reclaimIx], H.wallet.publicKey);
  S.check("reclaim_table previews cleanly in a wallet", !rp.err, rp);
  const beforeReclaim = await connection.getBalance(H.wallet.publicKey);
  await S.ok("host reclaims the rent", () => sendL1(new Transaction().add(reclaimIx), [H.wallet]));
  const reclaimed = (await connection.getBalance(H.wallet.publicKey)) - beforeReclaim;

  // ---- The keeper's path: anyone may close a table left empty and idle for the escape delay.
  await S.ok("U leaves the public table", () => cashOut(uSeat.reader, U, pub.T, 0));
  await S.err("a stranger can't close a freshly emptied table (expires 0)", "TableActive", closeKeyed(Keypair.generate(), pub.T, 0));
  const l1 = programFor(deployer);
  const cfg = (escapeIdleSecs: number) => l1.methods.updateConfig({ devWallet: deployer.publicKey, rakeBps: 500, maxBuyIn: BN(1_000_000_000), paused: false, escapeIdleSecs })
    .accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc();
  await S.ok("test only: escape delay set to 60 s (abandoned = 6 delays = 6 minutes)", () => cfg(60));
  await sleep(60_000);
  await S.err("after 1 minute (one escape delay) it isn't abandoned yet", "TableActive", closeKeyed(Keypair.generate(), pub.T, 0));
  await sleep(320_000);
  // The backend's keeper watches for the same rule and may close it first: either way it must close.
  await S.ok("after 6 minutes empty and idle, anyone (the keeper) closes it", async () => {
    try { return await closeKeyed(Keypair.generate(), pub.T, 0)(); }
    catch (e: any) {
      for (let i = 0; i < 12; i++) {
        const info = await connection.getAccountInfo(pub.T.table);
        if (info && info.owner.equals(programFor(H.wallet).programId)) return "closed by the keeper first";
        await sleep(5000);
      }
      throw e;
    }
  });
  await S.ok("escape delay restored to the default", () => cfg(0));

  S.finish({ host: H.wallet.publicKey.toBase58(), publicTable: pub.T.table.toBase58(), inviteTable: inv.T.table.toBase58(),
    hostCostLamports: hostCost, reclaimedLamports: reclaimed, createAndDelegateBytes: oneTx });
}
main().catch(async (e) => {
  console.error(e);
  // Never leave the test escape delay in the shared config.
  const d = loadKey("deployer");
  await programFor(d).methods.updateConfig({ devWallet: d.publicKey, rakeBps: 500, maxBuyIn: BN(1_000_000_000), paused: false, escapeIdleSecs: 0 })
    .accountsPartial({ admin: d.publicKey, config: CONFIG_PDA }).rpc().catch(() => {});
  process.exit(1);
});
