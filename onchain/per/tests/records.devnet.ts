// M6 on devnet: hand records published to Solana, the verifier CLI on a real hand (and on tampered
// copies), the auditor reading finished hands' logs only, a byte scan of everything this table put
// on Solana, the escrow leftover swept at close, and reclaiming the closed table's rent.
//   POKER_PER_KEYS=... npx tsx tests/records.devnet.ts
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createTransferInstruction } from "@solana/spl-token";
import { delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { randomBytes } from "crypto";
import { connection, programFor, programOn, loadKey, teeConnection, TEE_VALIDATOR, PROGRAM_ID, CONFIG_PDA, randomTableId } from "../scripts/lib";
import { BN, KIND, Suite, escapePayerOf, sleep, tableApi, rawRead, readerFor, sendL1, tokenOf, connUrl } from "./helpers";
import { fetchRecord, downloadLog, report } from "../scripts/verify-hand";
import { recoverBetFromLogHash } from "./attack";

const S = new Suite("m6-records");
const HAND_DEALT = 2;
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1"), p2 = loadKey("p2"), p3 = loadKey("p3");
  const l1 = programFor(deployer);
  const coder = l1.coder.accounts as any;
  const params = { smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false };

  const er = { deployer: await teeConnection(deployer), p1: await teeConnection(p1), p2: await teeConnection(p2), p3: await teeConnection(p3) };
  for (const [name, kp] of [["p1", p1], ["p2", p2], ["p3", p3], ["deployer", deployer]] as [keyof typeof er, any][]) {
    let bal = 0n;
    try { bal = BigInt((await er[name].getTokenAccountBalance(tokenOf(kp.publicKey))).value.amount); } catch { /* none yet */ }
    if (bal < 5_000_000n) {
      const amt = 5_000_000n - bal, ata = tokenOf(kp.publicKey);
      const ixs = await delegateSpl(kp.publicKey, NATIVE_MINT, amt, { validator: TEE_VALIDATOR, initVaultIfMissing: true, initAtasIfMissing: true, payer: kp.publicKey });
      await S.ok(`top-up ${name} to 0.005 wSOL in the rollup`, () => sendL1(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata, lamports: Number(amt) }), createSyncNativeInstruction(ata), ...ixs), [kp]));
    }
  }
  await sleep(6000);
  const prog = { deployer: programOn(er.deployer, deployer), p1: programOn(er.p1, p1), p2: programOn(er.p2, p2), p3: programOn(er.p3, p3) };
  const readers = { p1: readerFor(p1.publicKey), p2: readerFor(p2.publicKey) };
  const rd = { p1: await teeConnection(readers.p1), p2: await teeConnection(readers.p2) };
  const auditor = Keypair.generate();
  const auditorConn = await teeConnection(auditor);
  const canRead = async (c: any, account: PublicKey) => (await rawRead(connUrl(c), account)).visible;

  const tableId = randomTableId();
  const T = tableApi(deployer, tableId);
  const readTable = async () => coder.decode("table", (await er.deployer.getAccountInfo(T.table, "processed"))!.data);
  const readLedger = async () => coder.decode("ledger", (await rawRead(connUrl(rd.p1), T.ledger)).data!);
  const bySeat: Record<number, [any, PublicKey]> = { 0: [prog.p1, p1.publicKey], 3: [prog.p2, p2.publicKey] };
  const waitDealt = async (hand: number) => {
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const t = await readTable();
      if (t.handState === HAND_DEALT && Number(t.handNo) === hand) return true;
      await sleep(100);
    }
    return false;
  };
  // A raise to a distinctive total (734,000), then a fold: the byte scan looks for that bet.
  const BET = 734_000n;
  const playHand = async (hand: number, duringPlay?: () => Promise<void>) => {
    await S.ok(`hand ${hand}: p1 and p2 commit seeds`, async () => { await T.commitSeed(prog.p1, p1.publicKey, 0, randomBytes(32)); return T.commitSeed(prog.p2, p2.publicKey, 3, randomBytes(32)); });
    await S.ok(`hand ${hand}: start (VRF requested)`, () => T.startHand(prog.p3, p3.publicKey));
    S.check(`hand ${hand}: dealt by the VRF callback`, await waitDealt(hand), {});
    await S.ok(`hand ${hand}: begin (blinds)`, () => T.beginHand(prog.p3, p3.publicKey));
    if (duringPlay) await duringPlay();
    let seat = (await readLedger()).game.toAct;
    await S.ok(`hand ${hand}: seat ${seat} raises to ${BET}`, () => T.act(bySeat[seat][0], bySeat[seat][1], seat, KIND.raise, BET));
    seat = (await readLedger()).game.toAct;
    await S.ok(`hand ${hand}: seat ${seat} folds, the hand ends`, () => T.act(bySeat[seat][0], bySeat[seat][1], seat, KIND.fold));
  };

  // ---- setup (the backend's auditor is put back at the end)
  // Restore the backend's auditor at the end (its key file), not whatever was set before this run: a
  // run that crashed between the two would otherwise leave its test key in the shared config (9 Oct).
  const previousAuditor: PublicKey = loadKey("auditor").publicKey;
  await S.ok("admin sets a fresh auditor key", () => l1.methods.setAuditor(auditor.publicKey).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc());
  await S.ok("create + delegate a 6-seat table", async () => { await T.create(params); return T.delegate(); });
  await sleep(4000);
  await S.ok("open", () => T.open(prog.deployer, deployer.publicKey));
  await S.err("a player can't pick the auditor's key as their reader key (it would read live hands)", "InvalidReader",
    () => T.buyIn(prog.p1, p1.publicKey, 0, 2_000_000n, { reader: auditor.publicKey }));
  await S.ok("p1 sits in seat 0, p2 in seat 3", async () => { await T.buyIn(prog.p1, p1.publicKey, 0, 2_000_000n); return T.buyIn(prog.p2, p2.publicKey, 3, 2_000_000n); });
  await S.err("open_log before any hand has finished is refused", "NoFinishedHand", () => T.openLog(prog.p3));

  // ---- hand 1, with the auditor shut out during play
  await playHand(1, async () => {
    await S.err("hand 1: open_log while the hand is being played is refused", "HandInProgress", () => T.openLog(prog.p3));
    S.check("hand 1: during play the auditor can't read the log; the players can", !(await canRead(auditorConn, T.log)) && (await canRead(rd.p1, T.log)) && (await canRead(rd.p2, T.log)), {});
  });
  const t1 = await readTable();
  S.check("hand 1 over: the table holds hand 1's record (lastRecord)", Number(t1.lastRecord.handNo) === 1 && t1.lastRecord.logLen > 0, { handNo: t1.lastRecord.handNo.toString(), logLen: t1.lastRecord.logLen });
  S.check("hand 1 over: still no auditor access until open_log", !(await canRead(auditorConn, T.log)), {});
  await S.ok("an outsider (p3) opens hand 1's log to the auditor", () => T.openLog(prog.p3));
  const tableLamports = async () => (await er.deployer.getAccountInfo(T.table, "processed"))!.lamports;
  const lam0 = await tableLamports();
  await S.ok("a second open_log for the same hand succeeds without doing anything", () => T.openLog(prog.p3));
  S.check("...and costs the table nothing", (await tableLamports()) === lam0, { before: lam0, after: await tableLamports() });
  await sleep(1500);
  const auditLog = await downloadLog(auditorConn, T.table);
  const playerLog = await downloadLog(rd.p1, T.table);
  S.check("the auditor now reads hand 1's log, and so do its players still", !!auditLog && auditLog.handNo === "1" && !!playerLog && JSON.stringify(playerLog) === JSON.stringify(auditLog), { actions: auditLog?.len });
  const ledger1 = await readLedger();
  const stacks1 = [0, 3].map((s) => BigInt(ledger1.seats[s].stack.toString()));

  // ---- the verifier CLI on the real hand, and on tampered copies
  const r1 = await fetchRecord(T.table);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m6-"));
  const logFile = path.join(dir, "hand1-log.json");
  fs.writeFileSync(logFile, JSON.stringify(auditLog));
  const cli = (args: string[]) => {
    try { return { code: 0, out: execFileSync("npx", ["tsx", "scripts/verify-hand.ts", ...args], { cwd: path.join(__dirname, ".."), encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e: any) { return { code: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") }; }
  };
  const run1 = cli([T.table.toBase58(), "--log", logFile]);
  S.check("verifier CLI: hand 1 (rollup record + the auditor's log) verifies", run1.code === 0 && /"ok": true/.test(run1.out), { exit: run1.code, output: run1.out.trim().split("\n").slice(0, 14).join(" ") });
  const tamperedLog = JSON.parse(JSON.stringify(auditLog));
  const raised = tamperedLog.entries.findIndex((e: any) => BigInt(e.committed) === BET);
  tamperedLog.entries[raised >= 0 ? raised : tamperedLog.entries.length - 1].committed = "600000";
  fs.writeFileSync(path.join(dir, "tampered-log.json"), JSON.stringify(tamperedLog));
  const run2 = cli([T.table.toBase58(), "--log", path.join(dir, "tampered-log.json")]);
  S.check("verifier CLI: the same log with the raise changed (734,000 -> 600,000) fails", run2.code === 1 && /doesn't hash to the record's log hash/.test(run2.out), { exit: run2.code });
  const dropped = { ...auditLog!, entries: auditLog!.entries.slice(0, -1) };
  S.check("verifier: a log with its last action dropped fails", !report(r1!, dropped).ok, { problems: report(r1!, dropped).problems });
  const swapped = { ...r1!, cards: [...r1!.cards] };
  [swapped.cards[0], swapped.cards[1]] = [swapped.cards[1], swapped.cards[0]];
  S.check("verifier: a record with two cards swapped fails", !report(swapped).ok, { problems: report(swapped).problems });
  const otherSeed = { ...r1!, seeds: r1!.seeds.map((s, i) => (i === 0 ? randomBytes(32) : s)) };
  S.check("verifier: a record with a changed seed fails", !report(otherSeed).ok, { problems: report(otherSeed).problems });

  // ---- publish to Solana
  const commitSig = await S.ok("the creator commits the table (the keeper's job in M7)", () => T.commit(prog.deployer, deployer.publicKey));
  let onL1: any = null;
  const l1TableData: Buffer[] = [];
  for (let i = 0; i < 40 && Number(onL1?.lastRecord?.handNo ?? 0) !== 1; i++) {
    const info = await connection.getAccountInfo(T.table, "confirmed");
    onL1 = info ? coder.decode("table", info.data) : null;
    if (info) l1TableData[0] = Buffer.from(info.data);
    if (Number(onL1?.lastRecord?.handNo ?? 0) !== 1) await sleep(1500);
  }
  const l1Sigs = await connection.getSignaturesForAddress(T.table, { limit: 20 }, "confirmed");
  S.check("hand 1's record reached Solana in the table account", Number(onL1?.lastRecord?.handNo ?? 0) === 1, { l1Commit: l1Sigs[0] ? explorer(l1Sigs[0].signature) : null, rollupCommitTx: commitSig });
  // An observer with only the record on Solana tries every likely log for this short hand.
  const l1Rec = await fetchRecord(T.table, { l1: true });
  const brute = recoverBetFromLogHash(l1Rec!, { small: 100_000n, big: 200_000n }, 2_500_000n);
  S.check("brute force: the 734,000 raise can't be recovered from the record on Solana (every amount up to 2,500,000 tried)", brute.found === null && brute.tried > 0, brute);
  const run3 = cli([T.table.toBase58(), "--l1", "--log", logFile]);
  S.check("verifier CLI: hand 1 verifies from the copy on Solana (--l1) too", run3.code === 0 && /"ok": true/.test(run3.out), { exit: run3.code, output: run3.out.trim().split("\n").slice(0, 14).join(" ") });

  // ---- hand 2: the auditor loses hand 1's log once hand 2 begins
  await playHand(2, async () => {
    S.check("hand 2 in play: the auditor can no longer read the log (hand 1's entries were cleared, readers replaced)", !(await canRead(auditorConn, T.log)), {});
    await S.err("hand 2: open_log during play is refused", "HandInProgress", () => T.openLog(prog.p3));
  });
  await S.ok("the auditor is given hand 2's log", () => T.openLog(prog.p3));
  await sleep(1500);
  const auditLog2 = await downloadLog(auditorConn, T.table);
  const r2 = await fetchRecord(T.table);
  S.check("hand 2's log (as the auditor reads it) verifies against hand 2's record", !!auditLog2 && !!r2 && report(r2, auditLog2, r1!.button).ok, { problems: r2 && auditLog2 ? report(r2, auditLog2, r1!.button).problems : ["missing"] });
  await S.err("set_auditor by a non-admin is refused", "NotAdmin", () => programFor(p3).methods.setAuditor(p3.publicKey).accountsPartial({ admin: p3.publicKey, config: CONFIG_PDA }).rpc());

  // ---- leaving, a donation, close
  const ledger2 = await readLedger();
  const stacks2 = [0, 3].map((s) => BigInt(ledger2.seats[s].stack.toString()));
  await S.ok("p1 and p2 cash out", async () => { await T.cashOut(prog.p1, p1.publicKey, 0); return T.cashOut(prog.p2, p2.publicKey, 3); });
  await S.ok("collect rake", () => T.collectRake(prog.deployer, tokenOf(deployer.publicKey)));
  const DONATION = 12_345n;
  await S.ok("an outsider (p3) sends 12,345 straight to the escrow in the rollup (a donation)", () =>
    sendAndConfirmTransaction(er.p3, new Transaction().add(createTransferInstruction(tokenOf(p3.publicKey), T.escrow, p3.publicKey, DONATION)), [p3], { skipPreflight: true }));
  await sleep(1500);
  const creatorTok0 = BigInt((await er.deployer.getTokenAccountBalance(tokenOf(deployer.publicKey))).value.amount);
  await S.ok("creator closes the table", () => T.close(prog.deployer, deployer.publicKey));
  await sleep(2000);
  const creatorTok1 = BigInt((await er.deployer.getTokenAccountBalance(tokenOf(deployer.publicKey))).value.amount);
  S.check("close swept the 12,345 donation to the creator's rollup balance", creatorTok1 - creatorTok0 === DONATION, { delta: (creatorTok1 - creatorTok0).toString() });

  // ---- reclaim on Solana
  let back: any = null;
  for (let i = 0; i < 60; i++) {
    const info = await connection.getAccountInfo(T.table, "confirmed");
    if (info && info.owner.equals(PROGRAM_ID)) { back = coder.decode("table", info.data); l1TableData[1] = Buffer.from(info.data); break; }
    await sleep(2000);
  }
  S.check("the closed table is back on Solana, CLOSED, with hand 2's record", back?.status === 2 && Number(back?.lastRecord?.handNo) === 2, { status: back?.status, lastHand: back?.lastRecord?.handNo?.toString() });
  await S.err("a stranger can't reclaim it (the address is derived from the creator)", "ConstraintSeeds", () => T.reclaim(p3));
  const tableRent = (await connection.getAccountInfo(T.table))!.lamports, escapeLeft = await connection.getBalance(escapePayerOf(T.table));
  const before = await connection.getBalance(deployer.publicKey);
  const reclaimSig = await S.ok("the creator reclaims the table", () => T.reclaim());
  const after = await connection.getBalance(deployer.publicKey);
  const tomb = await connection.getAccountInfo(T.table);
  const fee = 5000;
  S.check("reclaim returned the table rent (all but an empty account's) and the escape payer's leftovers",
    after - before + fee === tableRent - tomb!.lamports + escapeLeft && (await connection.getBalance(escapePayerOf(T.table))) === 0,
    { returned: after - before + fee, tableRent, keptForEmptyAccount: tomb?.lamports, escapePayerLeft: escapeLeft, tx: explorer(reclaimSig) });
  S.check("the table account remains, empty and owned by the program", !!tomb && tomb.data.length === 0 && tomb.owner.equals(PROGRAM_ID), { dataLen: tomb?.data.length });
  await S.err("a second reclaim is refused", "TableNotClosed", () => T.reclaim());
  await S.err("the same table id can't be created again (the table address is already in use)", T.table.toBase58(), () => T.create(params));

  // ---- every byte this table put on Solana
  const sigs = await connection.getSignaturesForAddress(T.table, { limit: 200 }, "confirmed");
  const secrets: [string, Buffer][] = [
    ["p1 wallet", p1.publicKey.toBuffer()], ["p2 wallet", p2.publicKey.toBuffer()],
    ["p1 reader key", readers.p1.publicKey.toBuffer()], ["p2 reader key", readers.p2.publicKey.toBuffer()],
    ["the 734,000 raise", u64(BET)],
    ...stacks1.map((v, i) => [`stack after hand 1 (seat ${[0, 3][i]})`, u64(v)] as [string, Buffer]),
    ...stacks2.map((v, i) => [`stack after hand 2 (seat ${[0, 3][i]})`, u64(v)] as [string, Buffer]),
  ];
  const found: string[] = [];
  // Control: public-by-design values the same scan must find, so "found nothing" means something.
  const controls: [string, Buffer][] = [["the creator's wallet", deployer.publicKey.toBuffer()], ["the 200,000 big blind", u64(200_000n)]];
  const controlHits = new Set<string>();
  const has = (blob: Buffer, bytes: Buffer) => blob.includes(bytes) || (bytes.length === 32 && blob.includes(Buffer.from(new PublicKey(bytes).toBase58())));
  let scanned = 0;
  for (const s of sigs) {
    const tx: any = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx) continue;
    scanned++;
    const logs: string[] = tx.meta?.logMessages ?? [];
    const blobs = [Buffer.from(tx.transaction.message.serialize()), Buffer.from(logs.join(" ")),
      ...logs.filter((l) => l.startsWith("Program data: ")).map((l) => Buffer.from(l.slice(14), "base64"))];
    for (const [name, bytes] of secrets) if (blobs.some((b) => has(b, bytes))) found.push(`${name} in ${s.signature}`);
    for (const [name, bytes] of controls) if (blobs.some((b) => has(b, bytes))) controlHits.add(name);
  }
  l1TableData.forEach((d, i) => {
    for (const [name, bytes] of secrets) if (has(d, bytes)) found.push(`${name} in the table account (${i ? "after close" : "after the commit"})`);
    for (const [name, bytes] of controls) if (has(d, bytes)) controlHits.add(name);
  });
  S.check("byte-scan control: the same scan finds the creator's wallet and the big blind (public by design)", controlHits.size === controls.length, { found: [...controlHits] });
  S.check("byte scan of every Solana transaction touching the table (and its data): no wallets of players, no reader keys, no bets, no stacks",
    scanned > 0 && l1TableData.length === 2 && found.length === 0, { transactionsScanned: scanned, tableSnapshotsScanned: l1TableData.length, found });

  await S.ok("admin restores the previous auditor (the backend's)", () => l1.methods.setAuditor(previousAuditor).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc());
  S.finish({ table: T.table.toBase58(), tableId: tableId.toString(), auditor: auditor.publicKey.toBase58(), commitTx: l1Sigs[0]?.signature, reclaimTx: reclaimSig });
}

main().catch((e) => { console.error(e); process.exit(1); });
