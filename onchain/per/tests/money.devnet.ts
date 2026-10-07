// M2/M3 devnet money suite: tables and money inside the MagicBlock TEE rollup, with wrapped SOL.
// Results go to results/m2-money-<ts>.json; exits non-zero on any failure.
//
// Covers: L1 table rules -> program-created escrow -> hijack attempt -> wSOL top-ups -> rollup
// buy-in / rebuy / cash-out / rake + negative cases -> pause -> money refused on L1 -> commit and
// reconciliation (private ledger vs. public fingerprint) -> close -> escape hatch -> withdraw.
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { delegateSpl, withdrawSpl, deriveEphemeralAta, initEphemeralAtaIx, delegateEphemeralAtaIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import { connection, CONFIG_PDA, PROGRAM_ID, programFor, programOn, loadKey, teeConnection, TEE_VALIDATOR, randomTableId } from "../scripts/lib";
import { BN, Suite, sleep, dlpPda, escapePayerOf, tableApi, tokenOf, sendL1, sha256, rawRead, connUrl } from "./helpers";

const S = new Suite("m2-money");
const ASIA_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1"), p2 = loadKey("p2"), p3 = loadKey("p3");
  const l1 = programFor(deployer);
  // The escape delay is shortened to 60 s for this run and restored to the default at the end.
  const TEST_ESCAPE_SECS = 60;
  const cfg = (paused: boolean, escapeIdleSecs = TEST_ESCAPE_SECS) => l1.methods.updateConfig({ devWallet: deployer.publicKey, rakeBps: 500, maxBuyIn: BN(1_000_000_000), paused, escapeIdleSecs }).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc();
  await cfg(false);
  const params = { smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 2, inviteOnly: false };
  const decodeTable = (data: Buffer) => (l1.coder.accounts as any).decode("table", data);

  // ---- L1 rules (preflight, free)
  const bad = tableApi(deployer, randomTableId());
  await S.err("create: small blind 0 rejected", "InvalidBlinds", () => bad.create({ ...params, smallBlind: BN(0) }));
  await S.err("create: small blind > big blind rejected", "InvalidBlinds", () => bad.create({ ...params, smallBlind: BN(300_000) }));
  await S.err("create: min buy-in under 10 big blinds rejected", "InvalidBuyInRange", () => bad.create({ ...params, minBuyIn: BN(1_999_999) }));
  await S.err("create: min > max rejected", "InvalidBuyInRange", () => bad.create({ ...params, minBuyIn: BN(30_000_000) }));
  await S.err("create: max above program stake cap rejected", "AboveStakeCap", () => bad.create({ ...params, maxBuyIn: BN(1_000_000_001) }));
  await S.err("create: 1 seat rejected", "InvalidSeatCount", () => bad.create({ ...params, maxSeats: 1 }));
  await S.err("create: 10 seats rejected", "InvalidSeatCount", () => bad.create({ ...params, maxSeats: 10 }));
  await S.err("create: a non-wSOL mint (devnet USDC) rejected", "UnsupportedMint", () => bad.create(params, deployer, DEVNET_USDC));
  await S.ok("admin pauses the program", () => cfg(true));
  await S.err("create while paused rejected", "Paused", () => bad.create(params));
  await S.ok("admin unpauses", () => cfg(false));

  // ---- escrow hijack on a known id
  const known = tableApi(deployer, randomTableId());
  const [knownEata] = deriveEphemeralAta(known.table, NATIVE_MINT);
  await S.ok("attacker (p3) pre-delegates a known future table's escrow to a non-TEE validator",
    () => sendL1(new Transaction().add(initEphemeralAtaIx(knownEata, known.table, NATIVE_MINT, p3.publicKey), delegateEphemeralAtaIx(p3.publicKey, knownEata, ASIA_VALIDATOR)), [p3]));
  await S.err("creating that exact table then fails, nothing is created", "", () => known.create(params));
  S.check("...and no table account exists for that id", (await connection.getAccountInfo(known.table)) === null, {});

  // ---- create / delegate
  const T = tableApi(deployer, randomTableId());
  await S.ok("create table; program creates the escrow and delegates it to the TEE", () => T.create(params), async () => {
    const rec = await connection.getAccountInfo(dlpPda("delegation", T.escrowEata));
    return rec && new PublicKey(rec.data.subarray(8, 40)).equals(TEE_VALIDATOR) ? null : "escrow not delegated to TEE";
  });
  // On L1 a buy-in fails even earlier than the rollup guard: the private ledger never exists there.
  await S.err("buy-in refused on L1 (the private ledger doesn't exist on L1)", "AccountNotInitialized", () => T.buyIn(programFor(p1), p1.publicKey, 0, 10_000_000n));
  await S.err("rollup-only instructions refused on L1 by the Magic-program guard (open_table)", "NotInRollup", () => T.open(programFor(p1), p1.publicKey));
  await S.err("delegate a new table by someone other than the creator rejected", "NotCreator", () => T.delegate(p1));
  await S.err("delegate to a non-TEE validator rejected", "ConstraintAddress", () => T.delegate(deployer, ASIA_VALIDATOR));
  await S.ok("creator delegates the table to the TEE", () => T.delegate(), async () => {
    const rec = await connection.getAccountInfo(dlpPda("delegation", T.table));
    return rec && new PublicKey(rec.data.subarray(8, 40)).equals(TEE_VALIDATOR) ? null : "table not delegated to TEE";
  });

  // ---- wSOL top-ups
  for (const [name, kp, amt] of [["p1", p1, 30_000_000n], ["p2", p2, 12_000_000n], ["p3", p3, 5_000_000n], ["deployer", deployer, 1_000n]] as [string, Keypair, bigint][]) {
    const ata = tokenOf(kp.publicKey);
    const ixs = await delegateSpl(kp.publicKey, NATIVE_MINT, amt, { validator: TEE_VALIDATOR, initVaultIfMissing: true, initAtasIfMissing: true, payer: kp.publicKey });
    const t = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata, lamports: Number(amt) }), createSyncNativeInstruction(ata), ...ixs);
    await S.ok(`top-up ${name}: wrap ${amt} lamports + deposit to rollup`, () => sendL1(t, [kp]));
  }
  await sleep(8000);

  const er = { deployer: await teeConnection(deployer), p1: await teeConnection(p1), p2: await teeConnection(p2), p3: await teeConnection(p3) };
  const prog = { deployer: programOn(er.deployer, deployer), p1: programOn(er.p1, p1), p2: programOn(er.p2, p2), p3: programOn(er.p3, p3) };
  const readTable = async () => (prog.deployer.account as any).table.fetch(T.table, "confirmed");
  const readLedger = async (as: "p1" | "p2" | "p3") => (prog[as].account as any).ledger.fetch(T.ledger, "confirmed");
  const balance = async (n: keyof typeof er, owner: PublicKey) => { try { return BigInt((await er[n].getTokenAccountBalance(tokenOf(owner))).value.amount); } catch { return -1n; } };

  await S.ok("open the table's private accounts", () => T.open(prog.deployer, deployer.publicKey));
  const start = { p1: await balance("p1", p1.publicKey), p2: await balance("p2", p2.publicKey), dev: await balance("deployer", deployer.publicKey) };
  S.check("rollup balances before play (each wallet reading its own)", start.p1 >= 30_000_000n && start.p2 >= 12_000_000n, Object.fromEntries(Object.entries(start).map(([k, v]) => [k, v.toString()])));

  await S.err("buy-in below the table minimum rejected", "BuyInTooSmall", () => T.buyIn(prog.p1, p1.publicKey, 0, 1_999_999n));
  await S.err("buy-in above the table maximum rejected", "BuyInTooLarge", () => T.buyIn(prog.p1, p1.publicKey, 0, 22_000_000n));
  await S.err("buy-in paying from someone else's token account rejected", "ConstraintTokenOwner", () => T.buyIn(prog.p1, p1.publicKey, 0, 10_000_000n, { playerToken: tokenOf(p2.publicKey) }));
  await S.err("buy-in into a fake escrow rejected", "ConstraintAddress", () => T.buyIn(prog.p1, p1.publicKey, 0, 10_000_000n, { escrow: tokenOf(p3.publicKey) }));
  await S.err("buy-in with a fake Magic program account rejected", "ConstraintAddress",
    () => T.buyIn(prog.p1, p1.publicKey, 0, 10_000_000n, { rollup: { magicProgram: SystemProgram.programId, vault: new PublicKey("MagicVau1t999999999999999999999999999999999"), permissionProgram: new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1") } }));

  await S.ok("p1 buys in 0.01 at seat 0 (rake 5%)", () => T.buyIn(prog.p1, p1.publicKey, 0, 10_000_000n), async () => {
    const l = await readLedger("p1"); const s = l.seats[0];
    return s.player.equals(p1.publicKey) && s.stack.toString() === "9500000" && l.rakeAccrued.toString() === "500000" ? null : `seat ${JSON.stringify(s)} rake ${l.rakeAccrued}`;
  });
  await S.ok("p2 buys in 0.008 at seat 1", () => T.buyIn(prog.p2, p2.publicKey, 1, 8_000_000n), async () => {
    const l = await readLedger("p2"); const t = await readTable();
    return l.seats[1].stack.toString() === "7600000" && t.seatMask === 0b11 ? null : "p2 seat wrong";
  });
  await S.err("p3 cannot sit at a full 2-seat table", "SeatTaken", () => T.buyIn(prog.p3, p3.publicKey, 0, 2_000_000n));
  await S.err("rebuy below one big blind rejected", "RebuyTooSmall", () => T.buyIn(prog.p2, p2.publicKey, 1, 199_999n));
  await S.ok("rebuy of 200,001 rounds rake up to 10,001", () => T.buyIn(prog.p2, p2.publicKey, 1, 200_001n), async () => {
    const l = await readLedger("p2"); return l.rakeAccrued.toString() === "910001" && l.seats[1].stack.toString() === "7790000" ? null : `rake ${l.rakeAccrued} stack ${l.seats[1].stack}`;
  });
  await S.ok("p1 rebuys 0.01 (stack 19M, under the 20M max)", () => T.buyIn(prog.p1, p1.publicKey, 0, 10_000_000n), async () => {
    const l = await readLedger("p1"); return l.seats[0].stack.toString() === "19000000" ? null : `stack ${l.seats[0].stack}`;
  });
  await S.err("rebuy that would exceed the table max rejected", "BuyInTooLarge", () => T.buyIn(prog.p1, p1.publicKey, 0, 2_000_000n));
  await S.err("cash-out by a wallet with no seat rejected", "NotSeated", () => T.cashOut(prog.p3, p3.publicKey, 0));
  await S.err("cash-out to someone else's token account rejected", "ConstraintTokenOwner", () => T.cashOut(prog.p1, p1.publicKey, 0, { playerToken: tokenOf(p2.publicKey) }));

  await S.ok("commit the public table to L1 (2 players seated)", () => T.commit(prog.deployer, deployer.publicKey));
  await sleep(6000);
  await S.err("emergency undelegation of a busy, recently active table rejected", "TableActive", () => T.request(p3));
  await S.err("close by someone other than the creator rejected", "NotCreator", () => T.close(prog.p1, p1.publicKey));
  await S.err("close with players seated rejected", "TableNotEmpty", () => T.close(prog.deployer, deployer.publicKey));

  await S.ok("admin pauses on L1", () => cfg(true));
  let pausedSeen = false, pauseErr = "";
  for (let i = 0; i < 10 && !pausedSeen; i++) {
    await sleep(2000);
    try { await T.buyIn(prog.p2, p2.publicKey, 1, 200_000n); pauseErr = "rebuy went through while paused"; break; }
    catch (e: any) { pauseErr = String(e?.code ?? e?.message); pausedSeen = e?.code === 6009; }
  }
  S.check("rollup sees the L1 pause and rejects buy-ins", pausedSeen, { got: pauseErr });
  await S.ok("p1 cashes out 0.019 while paused", () => T.cashOut(prog.p1, p1.publicKey, 0), async () => {
    const b = await balance("p1", p1.publicKey); const t = await readTable();
    return t.seatMask === 0b10 && b - start.p1 === -20_000_000n + 19_000_000n ? null : `p1 delta ${b - start.p1} mask ${t.seatMask}`;
  });
  await S.ok("admin unpauses", () => cfg(false));
  await S.err("double cash-out rejected", "NotSeated", () => T.cashOut(prog.p1, p1.publicKey, 0));

  const devToken = tokenOf(deployer.publicKey);
  await S.err("rake to a token account that isn't the dev wallet's rejected", "ConstraintTokenOwner", () => T.collectRake(prog.deployer, tokenOf(p1.publicKey)));
  await S.ok("collect rake to the dev wallet (1,410,001)", () => T.collectRake(prog.deployer, devToken), async () => {
    const l = await readLedger("p2"); const dev = await balance("deployer", deployer.publicKey);
    return l.rakeAccrued.toString() === "0" && l.totalRakeCollected.toString() === "1410001" && dev - start.dev === 1_410_001n ? null : `rake ${l.rakeAccrued} collected ${l.totalRakeCollected} dev delta ${dev - start.dev}`;
  });
  await S.err("collecting again with nothing accrued rejected", "NothingToCollect", () => T.collectRake(prog.deployer, devToken));

  // reconciliation on the private ledger; L1 holds only its fingerprint
  await S.ok("commit the public table to L1", () => T.commit(prog.deployer, deployer.publicKey));
  await sleep(6000);
  const l = await readLedger("p2");
  const ledgerRaw = (await rawRead(connUrl(er.p2), T.ledger)).data!;
  const l1T = decodeTable((await connection.getAccountInfo(T.table))!.data);
  const recon = {
    totalDeposited: l.totalDeposited.toString(), totalRakeCollected: l.totalRakeCollected.toString(), totalPaidOut: l.totalPaidOut.toString(),
    escrowOwed: l.escrowOwed.toString(), escrowBalance: l.escrowBalance.toString(),
    l1FingerprintMatches: Buffer.from(l1T.ledgerHash).equals(sha256(ledgerRaw)),
  };
  const balanced = BigInt(recon.totalDeposited) - BigInt(recon.totalRakeCollected) - BigInt(recon.totalPaidOut) === BigInt(recon.escrowOwed) && recon.escrowOwed === recon.escrowBalance;
  S.check("reconciliation: deposited - rake - paid out = owed = escrow balance; L1 fingerprint matches the private ledger", balanced && recon.l1FingerprintMatches, recon);

  await S.ok("p2 cashes out; table empty", () => T.cashOut(prog.p2, p2.publicKey, 1), async () => (await readTable()).seatMask === 0 ? null : "not empty");
  await S.ok("creator closes the empty table", () => T.close(prog.deployer, deployer.publicKey));
  let closed: any = null;
  for (let i = 0; i < 24 && !closed; i++) { await sleep(5000); const info = await connection.getAccountInfo(T.table); if (info?.owner.equals(PROGRAM_ID)) closed = decodeTable(info.data); }
  S.check("closed table is back on L1, owned by the program, status CLOSED", closed?.status === 2, { status: closed?.status });
  await S.err("a closed table can't be delegated again", "TableNotOpen", () => T.delegate());

  // ---- emergency path on table B (60 s escape delay)
  const B = tableApi(deployer, randomTableId());
  const waitBack = async () => { for (let s = 0; s < 120; s += 5) { await sleep(5000); if ((await connection.getAccountInfo(B.table))?.owner.equals(PROGRAM_ID)) return s + 5; } return -1; };
  await S.ok("table B: create + delegate + open", async () => { await B.create(params); await B.delegate(); await sleep(4000); return B.open(prog.deployer, deployer.publicKey); });
  await S.err("request straight after delegation rejected (delegation stamps the idle clock)", "TableActive", () => B.request(p3));
  await S.ok("p2 sits at table B (nothing committed afterwards)", () => B.buyIn(prog.p2, p2.publicKey, 0, 2_000_000n));
  await sleep((TEST_ESCAPE_SECS + 5) * 1000);
  const r1 = await S.ok("after the escape delay a stranger's (p3) request is accepted (the known M5 gap)", () => B.request(p3));
  const w1 = await waitBack();
  const backB = w1 > 0 ? decodeTable((await connection.getAccountInfo(B.table))!.data) : null;
  S.check("TEE honours it: table B back on L1, still OPEN, seat 0 marked taken", backB?.status === 1 && backB?.seatMask === 1, { requestSig: r1, secondsWaited: w1 });
  await S.ok("anyone (p1) re-delegates the returned table so p2 isn't stranded", () => B.delegate(p1));
  await sleep(6000);
  S.check("the private ledger survived the round trip (p2 still reads it)", (await rawRead(connUrl(er.p2), B.ledger)).visible, {});
  await S.ok("p2 cashes out of table B inside the rollup", () => B.cashOut(prog.p2, p2.publicKey, 0));
  await S.ok("collect table B's rake", () => B.collectRake(prog.deployer, devToken));
  const md = await connection.getAccountInfo(dlpPda("delegation-metadata", B.table));
  S.check("after p1 re-delegated, the recorded rent payer is still the escape payer PDA (not p1)", !!md && md.data.includes(escapePayerOf(B.table).toBuffer()) && !md.data.includes(p1.publicKey.toBuffer()), {});
  await sleep((TEST_ESCAPE_SECS + 5) * 1000);
  const r2 = await S.ok("after re-delegation a stranger (p3) can still file the request", () => B.request(p3));
  const w2 = await waitBack();
  S.check("TEE honours it; table B back on L1", w2 > 0, { requestSig: r2, secondsWaited: w2 });

  // ---- withdraw
  const p1Bal = await balance("p1", p1.publicKey);
  const sol0 = await connection.getBalance(p1.publicKey);
  const wIxs = await withdrawSpl(p1.publicKey, NATIVE_MINT, p1Bal, { validator: TEE_VALIDATOR, initAtasIfMissing: true, payer: p1.publicKey });
  const wSig = await S.ok("p1 withdraws whole rollup balance", () => sendL1(new Transaction().add(...wIxs), [p1]));
  let sol = sol0; for (let i = 0; i < 30 && sol <= sol0; i++) { await sleep(2000); sol = await connection.getBalance(p1.publicKey); }
  S.check("withdrawal arrives as plain SOL", sol > sol0, { withdrawSig: wSig, amount: p1Bal.toString(), solDelta: sol - sol0 });
  await S.ok("restore the default escape delay (1 hour)", () => cfg(false, 0));

  S.finish({ table: T.table.toBase58(), tableB: B.table.toBase58() });
}
main().catch((e) => { console.error(e); process.exit(1); });
