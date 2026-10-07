// M2 devnet tests: tables and money inside the MagicBlock TEE rollup, with wrapped SOL.
// Every outcome goes to results/m2-money-<ts>.json; the script exits non-zero on any failure.
//
// Covers: L1 table rules -> program-created escrow (delegated to the TEE) -> hijack attempt ->
// wSOL top-ups -> rollup buy-in / rebuy / cash-out / rake + negative cases -> pause propagation ->
// money refused on L1 -> commit + reconciliation -> escape-hatch rules -> close -> withdraw.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { delegateSpl, withdrawSpl, deriveEphemeralAta, initEphemeralAtaIx, delegateEphemeralAtaIx, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";
import path from "path";
import { connection, CONFIG_PDA, PROGRAM_ID, idl, programFor, programOn, loadKey, teeConnection, TEE_VALIDATOR, tablePda, randomTableId } from "../scripts/lib";

type Outcome = { name: string; status: "PASS" | "FAIL"; detail: any };
const outcomes: Outcome[] = [];
const BN = (n: number | bigint) => new anchor.BN(n.toString());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const ASIA_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const dlpPda = (tag: string, acct: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(tag), acct.toBuffer()], DLP)[0];

// The TEE rollup hides transaction logs, so Anchor can't build an AnchorError there and throws a
// ProgramError with only a numeric code. Map codes back to names from our IDL and Anchor's own list.
const codeNames = new Map<number, string>([
  ...(idl.errors ?? []).map((x: any) => [x.code, x.name] as [number, string]),
  ...Object.entries(anchor.LangErrorCode).map(([n, c]) => [c as number, n] as [number, string]),
]);
function errName(e: any): string {
  const code = e?.error?.errorCode?.code;
  if (code) return `${code} (${e.error.errorCode.number})`;
  if (typeof e?.code === "number") return `${codeNames.get(e.code) ?? "Unknown"} (${e.code})`;
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
  const hit = logs.find((l) => /Error Code|custom program error|insufficient|failed|already/i.test(l));
  return hit ?? String(e?.message ?? e).slice(0, 300);
}
async function ok(name: string, fn: () => Promise<string>, check?: () => Promise<string | null>) {
  try {
    const sig = await fn();
    const problem = check ? await check() : null;
    outcomes.push({ name, status: problem ? "FAIL" : "PASS", detail: { sig, problem } });
    return sig;
  } catch (e: any) { outcomes.push({ name, status: "FAIL", detail: { unexpectedError: errName(e) } }); return ""; }
}
async function err(name: string, expected: string, fn: () => Promise<string>) {
  try { const sig = await fn(); outcomes.push({ name, status: "FAIL", detail: { expected, butSucceeded: sig } }); }
  catch (e: any) { const got = errName(e); outcomes.push({ name, status: got.includes(expected) ? "PASS" : "FAIL", detail: { expected, got } }); }
}
const sendL1 = (tx: Transaction, signers: Keypair[]) => anchor.web3.sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1"), p2 = loadKey("p2"), p3 = loadKey("p3");
  const l1 = programFor(deployer);
  const fetchCfg = () => (l1.account as any).config.fetch(CONFIG_PDA);
  // The suite shortens the escape delay to 60 s so the emergency path can be exercised, and puts it
  // back to the default (0 = 1 hour) at the end.
  const TEST_ESCAPE_SECS = 60;
  const cfgArgs = (paused: boolean, escapeIdleSecs = TEST_ESCAPE_SECS) => ({ devWallet: deployer.publicKey, rakeBps: 500, maxBuyIn: BN(1_000_000_000), paused, escapeIdleSecs });
  const setPaused = (paused: boolean) => l1.methods.updateConfig(cfgArgs(paused)).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc();
  await setPaused(false);

  const params = { smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 2 };
  const tokenOf = (k: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, k);
  const escrowOf = (t: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, t, true);
  const createAccts = (creator: PublicKey, table: PublicKey, mint = NATIVE_MINT) => {
    const [eata] = PublicKey.findProgramAddressSync([table.toBuffer(), mint.toBuffer()], new PublicKey("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2"));
    return { creator, config: CONFIG_PDA, table, mint, escrow: getAssociatedTokenAddressSync(mint, table, true), escrowEata: eata };
  };
  const create = (id: bigint, p: any, signer = deployer, mint = NATIVE_MINT) =>
    programFor(signer).methods.createTable(BN(id), p).accountsPartial(createAccts(signer.publicKey, tablePda(signer.publicKey, id), mint)).rpc();
  const delegate = (id: bigint, creator: PublicKey, payer = deployer, validator = TEE_VALIDATOR) =>
    programFor(payer).methods.delegateTable(BN(id), creator).accountsPartial({ payer: payer.publicKey, table: tablePda(creator, id), validator }).rpc();

  // ---- L1: table rules (preflight, free)
  const bad = randomTableId();
  await err("create: small blind 0 rejected", "InvalidBlinds", () => create(bad, { ...params, smallBlind: BN(0) }));
  await err("create: small blind > big blind rejected", "InvalidBlinds", () => create(bad, { ...params, smallBlind: BN(300_000) }));
  await err("create: min buy-in under 10 big blinds rejected", "InvalidBuyInRange", () => create(bad, { ...params, minBuyIn: BN(1_999_999) }));
  await err("create: min > max rejected", "InvalidBuyInRange", () => create(bad, { ...params, minBuyIn: BN(30_000_000) }));
  await err("create: max above program stake cap rejected", "AboveStakeCap", () => create(bad, { ...params, maxBuyIn: BN(1_000_000_001) }));
  await err("create: 1 seat rejected", "InvalidSeatCount", () => create(bad, { ...params, maxSeats: 1 }));
  await err("create: 10 seats rejected", "InvalidSeatCount", () => create(bad, { ...params, maxSeats: 10 }));
  await err("create: a non-wSOL mint (devnet USDC) rejected", "UnsupportedMint", () => create(bad, params, deployer, DEVNET_USDC));
  await ok("admin pauses the program", () => setPaused(true));
  await err("create while paused rejected", "Paused", () => create(bad, params));
  await ok("admin unpauses", () => setPaused(false));

  // ---- Escrow hijack (review finding M1): someone sets up a known table's escrow first
  const knownId = randomTableId();
  const knownTable = tablePda(deployer.publicKey, knownId);
  const [knownEata] = deriveEphemeralAta(knownTable, NATIVE_MINT);
  await ok("attacker (p3) pre-delegates a known future table's escrow to a non-TEE validator",
    () => sendL1(new Transaction().add(initEphemeralAtaIx(knownEata, knownTable, NATIVE_MINT, p3.publicKey), delegateEphemeralAtaIx(p3.publicKey, knownEata, ASIA_VALIDATOR)), [p3]));
  await err("creating that exact table then fails, nothing is created (attack only works on a known id)", "", () => create(knownId, params));
  outcomes.push({ name: "...and no table account exists for that id", status: (await connection.getAccountInfo(knownTable)) === null ? "PASS" : "FAIL", detail: { table: knownTable.toBase58() } });

  // ---- L1: create (program creates + delegates escrow) and delegate the table
  const tableId = randomTableId();
  const table = tablePda(deployer.publicKey, tableId);
  const escrow = escrowOf(table);
  const [escrowEata] = deriveEphemeralAta(table, NATIVE_MINT);
  await ok("create table; program creates the escrow and delegates it to the TEE", () => create(tableId, params), async () => {
    const rec = await connection.getAccountInfo(dlpPda("delegation", escrowEata));
    const validator = rec ? new PublicKey(rec.data.subarray(8, 40)) : null;
    return validator?.equals(TEE_VALIDATOR) ? null : `escrow delegated to ${validator?.toBase58()}`;
  });
  await err("money refused on L1 (table created, not delegated)", "NotInRollup",
    () => programFor(p1).methods.buyIn(BN(10_000_000)).accountsPartial({ player: p1.publicKey, config: CONFIG_PDA, table, playerToken: tokenOf(p1.publicKey), escrow, inRollup: MAGIC_PROGRAM_ID }).rpc());
  await err("delegate a new table by someone other than the creator rejected", "NotCreator", () => delegate(tableId, deployer.publicKey, p1));
  await err("delegate to a non-TEE validator rejected", "ConstraintAddress", () => delegate(tableId, deployer.publicKey, deployer, ASIA_VALIDATOR));
  await ok("creator delegates the table to the TEE", () => delegate(tableId, deployer.publicKey), async () => {
    const info = await connection.getAccountInfo(table);
    const rec = await connection.getAccountInfo(dlpPda("delegation", table));
    return info?.owner.equals(DLP) && rec && new PublicKey(rec.data.subarray(8, 40)).equals(TEE_VALIDATOR) ? null : "table not delegated to TEE";
  });

  // ---- L1: wSOL top-ups (one tx each: wrap + deposit)
  const deposits: [string, Keypair, bigint][] = [["p1", p1, 30_000_000n], ["p2", p2, 12_000_000n], ["p3", p3, 5_000_000n], ["deployer", deployer, 1_000n]];
  for (const [name, kp, amt] of deposits) {
    const ata = tokenOf(kp.publicKey);
    const ixs = await delegateSpl(kp.publicKey, NATIVE_MINT, amt, { validator: TEE_VALIDATOR, initVaultIfMissing: true, initAtasIfMissing: true, payer: kp.publicKey });
    const t = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata, lamports: Number(amt) }),
      createSyncNativeInstruction(ata),
      ...ixs,
    );
    await ok(`top-up ${name}: wrap ${amt} lamports + deposit to rollup`, () => sendL1(t, [kp]));
  }
  await sleep(8000);

  // ---- Rollup
  const er: Record<string, Connection> = {};
  for (const [n, k] of [["deployer", deployer], ["p1", p1], ["p2", p2], ["p3", p3]] as [string, Keypair][]) er[n] = await teeConnection(k);
  const prog = (n: string, k: Keypair) => programOn(er[n], k);
  const readTable = async () => (prog("deployer", deployer).account as any).table.fetch(table, "confirmed");
  const balance = async (n: string, owner: PublicKey) => { try { return BigInt((await er[n].getTokenAccountBalance(tokenOf(owner))).value.amount); } catch { return -1n; } };
  const buyIn = (n: string, k: Keypair, amount: bigint, overrides: any = {}) => prog(n, k).methods.buyIn(BN(amount))
    .accountsPartial({ player: k.publicKey, config: CONFIG_PDA, table, playerToken: tokenOf(k.publicKey), escrow, inRollup: MAGIC_PROGRAM_ID, ...overrides }).rpc();
  const cashOut = (n: string, k: Keypair, overrides: any = {}) => prog(n, k).methods.cashOut()
    .accountsPartial({ player: k.publicKey, table, playerToken: tokenOf(k.publicKey), escrow, inRollup: MAGIC_PROGRAM_ID, ...overrides }).rpc();

  const start = { p1: await balance("p1", p1.publicKey), p2: await balance("p2", p2.publicKey), dev: await balance("deployer", deployer.publicKey) };
  outcomes.push({ name: "rollup balances before play (each wallet reading its own)", status: start.p1 >= 30_000_000n && start.p2 >= 12_000_000n ? "PASS" : "FAIL", detail: Object.fromEntries(Object.entries(start).map(([k, v]) => [k, v.toString()])) });

  await err("buy-in below the table minimum rejected", "BuyInTooSmall", () => buyIn("p1", p1, 1_999_999n));
  await err("buy-in above the table maximum rejected", "BuyInTooLarge", () => buyIn("p1", p1, 22_000_000n));
  await err("buy-in paying from someone else's token account rejected", "ConstraintTokenOwner", () => buyIn("p1", p1, 10_000_000n, { playerToken: tokenOf(p2.publicKey) }));
  await err("buy-in into a fake escrow rejected", "ConstraintAddress", () => buyIn("p1", p1, 10_000_000n, { escrow: tokenOf(p3.publicKey) }));
  await err("buy-in with a fake 'in rollup' account rejected", "ConstraintAddress", () => buyIn("p1", p1, 10_000_000n, { inRollup: SystemProgram.programId }));

  await ok("p1 buys in 0.01 (rake 5%)", () => buyIn("p1", p1, 10_000_000n), async () => {
    const t = await readTable(); const s = t.seats[0];
    return s.player.equals(p1.publicKey) && s.stack.toString() === "9500000" && t.rakeAccrued.toString() === "500000" && t.seated === 1 ? null : `seat ${JSON.stringify(s)} rake ${t.rakeAccrued}`;
  });
  await ok("p2 buys in 0.008", () => buyIn("p2", p2, 8_000_000n), async () => {
    const t = await readTable(); return t.seats[1].stack.toString() === "7600000" && t.seated === 2 ? null : "p2 seat wrong";
  });
  await err("p3 cannot sit at a full 2-seat table", "TableFull", () => buyIn("p3", p3, 2_000_000n));
  await err("rebuy below one big blind rejected", "RebuyTooSmall", () => buyIn("p2", p2, 199_999n));
  await ok("rebuy of 200,001 rounds rake up to 10,001", () => buyIn("p2", p2, 200_001n), async () => {
    const t = await readTable(); return t.rakeAccrued.toString() === String(500_000 + 400_000 + 10_001) && t.seats[1].stack.toString() === String(7_600_000 + 190_000) ? null : `rake ${t.rakeAccrued} stack ${t.seats[1].stack}`;
  });
  await ok("p1 rebuys 0.01 (stack 19M, under the 20M max)", () => buyIn("p1", p1, 10_000_000n), async () => {
    const t = await readTable(); return t.seats[0].stack.toString() === "19000000" && t.seated === 2 ? null : `stack ${t.seats[0].stack}`;
  });
  await err("rebuy that would exceed the table max rejected", "BuyInTooLarge", () => buyIn("p1", p1, 2_000_000n));
  await err("cash-out by a wallet with no seat rejected", "NotSeated", () => cashOut("p3", p3));
  await err("cash-out to someone else's token account rejected", "ConstraintTokenOwner", () => cashOut("p1", p1, { playerToken: tokenOf(p2.publicKey) }));

  // escape-hatch guard while the table is busy (reads the last L1 commit)
  await ok("commit table ledger to L1 (2 players seated)", () => prog("deployer", deployer).methods.commitTable().accountsPartial({ payer: deployer.publicKey, table }).rpc());
  await sleep(6000);
  const escapePayerOf = (t: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("escape-payer"), t.toBuffer()], PROGRAM_ID)[0];
  const reqAccts = (requester: PublicKey, t: PublicKey) => ({ requester, config: CONFIG_PDA, table: t, escapePayer: escapePayerOf(t), ownerProgram: PROGRAM_ID, undelegationRequest: dlpPda("undelegation-request", t), delegationRecord: dlpPda("delegation", t), delegationMetadata: dlpPda("delegation-metadata", t), delegationProgram: DLP });
  const request = (signer: Keypair, id: bigint, creator: PublicKey) => programFor(signer).methods.requestTableUndelegation(BN(id), creator).accountsPartial(reqAccts(signer.publicKey, tablePda(creator, id))).rpc();
  await err("emergency undelegation of a busy, recently active table rejected", "TableActive", () => request(deployer, tableId, deployer.publicKey));
  await err("close by someone other than the creator rejected", "NotCreator",
    () => prog("p1", p1).methods.closeTable().accountsPartial({ creator: p1.publicKey, table }).rpc());
  await err("close with players seated rejected", "TableNotEmpty",
    () => prog("deployer", deployer).methods.closeTable().accountsPartial({ creator: deployer.publicKey, table }).rpc());

  // pause on L1 reaches the rollup's copy of the config; cash-out still works
  await ok("admin pauses on L1", () => setPaused(true));
  let pausedSeen = false, pauseErr = "";
  for (let i = 0; i < 10 && !pausedSeen; i++) {
    await sleep(2000);
    try { await buyIn("p2", p2, 200_000n); pauseErr = "rebuy went through while paused"; break; }
    catch (e: any) { pauseErr = errName(e); pausedSeen = pauseErr.includes("Paused"); }
  }
  outcomes.push({ name: "rollup sees the L1 pause and rejects buy-ins", status: pausedSeen ? "PASS" : "FAIL", detail: { got: pauseErr } });
  await ok("p1 cashes out 0.019 while paused", () => cashOut("p1", p1), async () => {
    const t = await readTable(); const b = await balance("p1", p1.publicKey);
    return t.seats[0].player.equals(PublicKey.default) && t.seated === 1 && b - start.p1 === -20_000_000n + 19_000_000n ? null : `p1 delta ${b - start.p1}`;
  });
  await ok("admin unpauses", () => setPaused(false));
  await err("double cash-out rejected", "NotSeated", () => cashOut("p1", p1));

  const devToken = tokenOf(deployer.publicKey);
  const collect = (escrowAcct = escrow) => prog("deployer", deployer).methods.collectRake().accountsPartial({ config: CONFIG_PDA, table, escrow: escrowAcct, devToken, inRollup: MAGIC_PROGRAM_ID }).rpc();
  await err("rake to a token account that isn't the dev wallet's rejected", "ConstraintTokenOwner",
    () => prog("deployer", deployer).methods.collectRake().accountsPartial({ config: CONFIG_PDA, table, escrow, devToken: tokenOf(p1.publicKey), inRollup: MAGIC_PROGRAM_ID }).rpc());
  await ok("collect rake to the dev wallet (1,410,001: 5% of 10M + 8M + 10M, rounded up on 200,001)", () => collect(), async () => {
    const t = await readTable(); const dev = await balance("deployer", deployer.publicKey);
    return t.rakeAccrued.toString() === "0" && t.totalRakeCollected.toString() === "1410001" && dev - start.dev === 1_410_001n ? null : `rake ${t.rakeAccrued} collected ${t.totalRakeCollected} dev delta ${dev - start.dev}`;
  });
  await err("collecting again with nothing accrued rejected", "NothingToCollect", () => collect());

  // reconciliation at a commit point
  await ok("commit table ledger to L1", () => prog("deployer", deployer).methods.commitTable().accountsPartial({ payer: deployer.publicKey, table }).rpc());
  await sleep(6000);
  const t = await readTable();
  const l1Raw = await connection.getAccountInfo(table);
  const l1Table = l1Raw ? (l1.coder.accounts as any).decode("table", l1Raw.data) : null;
  const recon = {
    totalDeposited: t.totalDeposited.toString(), totalPaidOut: t.totalPaidOut.toString(), totalRakeCollected: t.totalRakeCollected.toString(),
    escrowOwed: t.escrowOwed.toString(), escrowBalance: t.escrowBalance.toString(), stacks: t.seats.map((s: any) => s.stack.toString()).filter((x: string) => x !== "0"),
    l1CopyMatches: l1Table ? l1Table.totalDeposited.toString() === t.totalDeposited.toString() && l1Table.escrowOwed.toString() === t.escrowOwed.toString() : false,
  };
  const balanced = BigInt(recon.totalDeposited) - BigInt(recon.totalRakeCollected) - BigInt(recon.totalPaidOut) === BigInt(recon.escrowOwed) && recon.escrowOwed === recon.escrowBalance;
  outcomes.push({ name: "reconciliation: deposited - rake - paid out = owed = escrow balance; L1 copy matches", status: balanced && recon.l1CopyMatches ? "PASS" : "FAIL", detail: recon });

  await ok("p2 cashes out; table empty", () => cashOut("p2", p2), async () => {
    const t2 = await readTable(); return t2.seated === 0 && t2.escrowOwed.toString() === "0" ? null : "table not empty";
  });

  // normal close: creator closes the empty table; it comes back to L1 as CLOSED
  await ok("creator closes the empty table (commit + undelegate)", () => prog("deployer", deployer).methods.closeTable().accountsPartial({ creator: deployer.publicKey, table }).rpc());
  let closed: any = null;
  for (let i = 0; i < 24 && !closed; i++) { await sleep(5000); const info = await connection.getAccountInfo(table); if (info?.owner.equals(PROGRAM_ID)) closed = (l1.coder.accounts as any).decode("table", info.data); }
  outcomes.push({ name: "closed table is back on L1, owned by the program, status CLOSED", status: closed && closed.status === 2 ? "PASS" : "FAIL", detail: { status: closed?.status } });
  await err("a closed table can't be delegated again", "TableNotOpen", () => delegate(tableId, deployer.publicKey));

  // ---- Emergency path on table B (escape delay set to 60 s for this run)
  const t2Id = randomTableId(); const t2 = tablePda(deployer.publicKey, t2Id); const t2Escrow = escrowOf(t2);
  const waitBack = async () => { for (let s = 0; s < 120; s += 5) { await sleep(5000); if ((await connection.getAccountInfo(t2))?.owner.equals(PROGRAM_ID)) return s + 5; } return -1; };
  const readT2 = async () => (prog("deployer", deployer).account as any).table.fetch(t2, "confirmed");
  await ok("table B: create + delegate", async () => { await create(t2Id, params); return delegate(t2Id, deployer.publicKey); });
  await err("request straight after delegation rejected (delegation stamps the idle clock)", "TableActive", () => request(deployer, t2Id, deployer.publicKey));
  await sleep(5000);
  await ok("p2 sits at table B (nothing committed afterwards)", () => buyIn("p2", p2, 2_000_000n, { table: t2, escrow: t2Escrow }));
  await sleep((TEST_ESCAPE_SECS + 5) * 1000);
  const r1 = await ok("after the escape delay a stranger's (p3) request is accepted (L1 copy looks idle: the known M5 gap)", () => request(p3, t2Id, deployer.publicKey));
  const w1 = await waitBack();
  const backT2 = w1 > 0 ? (l1.coder.accounts as any).decode("table", (await connection.getAccountInfo(t2))!.data) : null;
  outcomes.push({ name: "TEE honours it: table B back on L1, still OPEN, with p2's seat on it", status: backT2 && backT2.status === 1 && backT2.seated === 1 ? "PASS" : "FAIL", detail: { requestSig: r1, secondsWaited: w1, seated: backT2?.seated } });
  await ok("anyone (p1) re-delegates the returned table so p2 isn't stranded", () => delegate(t2Id, deployer.publicKey, p1));
  await sleep(6000);
  await ok("p2 cashes out of table B inside the rollup", () => cashOut("p2", p2, { table: t2, escrow: t2Escrow }), async () => {
    const t = await readT2(); return t.seated === 0 && t.escrowOwed.toString() === "100000" ? null : `seated ${t.seated} owed ${t.escrowOwed}`;
  });
  await ok("collect table B's rake", () => prog("deployer", deployer).methods.collectRake().accountsPartial({ config: CONFIG_PDA, table: t2, escrow: t2Escrow, devToken, inRollup: MAGIC_PROGRAM_ID }).rpc());
  const md = await connection.getAccountInfo(dlpPda("delegation-metadata", t2));
  outcomes.push({ name: "after p1 re-delegated, the recorded rent payer is still the table's escape payer PDA (not p1)", status: md && md.data.includes(escapePayerOf(t2).toBuffer()) && !md.data.includes(p1.publicKey.toBuffer()) ? "PASS" : "FAIL", detail: { escapePayer: escapePayerOf(t2).toBase58() } });
  await sleep((TEST_ESCAPE_SECS + 5) * 1000);
  const r2 = await ok("after re-delegation a stranger (p3) can still file the request: the role can't be captured", () => request(p3, t2Id, deployer.publicKey));
  const w2 = await waitBack();
  outcomes.push({ name: "TEE honours it; table B back on L1", status: w2 > 0 ? "PASS" : "FAIL", detail: { requestSig: r2, secondsWaited: w2 } });

  // withdraw p1's rollup balance back to plain SOL
  const p1Bal = await balance("p1", p1.publicKey);
  const sol0 = await connection.getBalance(p1.publicKey);
  const wIxs = await withdrawSpl(p1.publicKey, NATIVE_MINT, p1Bal, { validator: TEE_VALIDATOR, initAtasIfMissing: true, payer: p1.publicKey });
  const wSig = await ok("p1 withdraws whole rollup balance", () => sendL1(new Transaction().add(...wIxs), [p1]));
  let sol = sol0; for (let i = 0; i < 30 && sol <= sol0; i++) { await sleep(2000); sol = await connection.getBalance(p1.publicKey); }
  outcomes.push({ name: "withdrawal arrives as plain SOL", status: sol > sol0 ? "PASS" : "FAIL", detail: { withdrawSig: wSig, amount: p1Bal.toString(), solDelta: sol - sol0 } });

  await ok("restore the default escape delay (1 hour)", () => l1.methods.updateConfig(cfgArgs(false, 0)).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc());

  const failed = outcomes.filter((o) => o.status === "FAIL").length;
  const summary = { program: PROGRAM_ID.toBase58(), table: table.toBase58(), tableId: tableId.toString(), tableB: t2.toBase58(), escrow: escrow.toBase58(), ranAt: new Date().toISOString(), pass: outcomes.length - failed, fail: failed, outcomes };
  const out = path.join(__dirname, "../results", `m2-money-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(summary, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  for (const o of outcomes) console.log(`${o.status.padEnd(5)} ${o.name}${o.status === "FAIL" ? "  " + JSON.stringify(o.detail) : ""}`);
  console.log(`\n${summary.pass} passed, ${failed} failed -> ${path.relative(process.cwd(), out)}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
