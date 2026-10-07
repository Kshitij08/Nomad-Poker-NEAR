// M3 devnet tests: who can read what. Builds an access matrix over the table, its private ledger,
// deck and hands for seated players, an outsider, the creator, and no login; checks nothing private
// reaches L1; that readers change live as players sit and leave; invite-only tables; and that
// transaction logs stay hidden from outsiders. Results go to results/m3-privacy-<ts>.json.
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { createEataPermissionIx, delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { connection, CONFIG_PDA, programFor, programOn, loadKey, teeConnection, TEE_URL, TEE_VALIDATOR, randomTableId } from "../scripts/lib";
import { BN, Suite, sleep, tableApi, handOf, invitesOf, inviteHash, rawRead, sha256, sendL1, tokenOf, connUrl } from "./helpers";

const S = new Suite("m3-privacy");

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1"), p2 = loadKey("p2"), p3 = loadKey("p3");
  const l1 = programFor(deployer);
  await l1.methods.updateConfig({ devWallet: deployer.publicKey, rakeBps: 500, maxBuyIn: BN(1_000_000_000), paused: false, escapeIdleSecs: 0 }).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc();
  const params = { smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false };

  // Make sure every player has wSOL in the rollup (earlier suites may have withdrawn it all).
  const er = { deployer: await teeConnection(deployer), p1: await teeConnection(p1), p2: await teeConnection(p2), p3: await teeConnection(p3) };
  for (const [name, kp] of [["p1", p1], ["p2", p2], ["p3", p3]] as [keyof typeof er, any][]) {
    let bal = 0n;
    try { bal = BigInt((await er[name].getTokenAccountBalance(tokenOf(kp.publicKey))).value.amount); } catch { /* no account yet */ }
    if (bal < 15_000_000n) {
      const amt = 15_000_000n - bal;
      const ata = tokenOf(kp.publicKey);
      const ixs = await delegateSpl(kp.publicKey, NATIVE_MINT, amt, { validator: TEE_VALIDATOR, initVaultIfMissing: true, initAtasIfMissing: true, payer: kp.publicKey });
      await S.ok(`top-up ${name} to 0.015 wSOL in the rollup`, () => sendL1(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata, lamports: Number(amt) }), createSyncNativeInstruction(ata), ...ixs), [kp]));
    }
  }
  await sleep(6000);
  const prog = { deployer: programOn(er.deployer, deployer), p1: programOn(er.p1, p1), p2: programOn(er.p2, p2), p3: programOn(er.p3, p3) };
  const urls: Record<string, string> = { p1: connUrl(er.p1), p2: connUrl(er.p2), "p3 (outsider)": connUrl(er.p3), "creator (not seated)": connUrl(er.deployer), "no login": TEE_URL };

  // ---- table A: public seating, two players
  const A = tableApi(deployer, randomTableId());
  await S.ok("create + delegate table A", async () => { await A.create(params); return A.delegate(); });
  await sleep(4000);
  await S.err("buy-in before the private accounts exist is rejected", "AccountNotInitialized", () => A.buyIn(prog.p1, p1.publicKey, 0, 10_000_000n));
  await S.ok("anyone (p3) opens the table: creates ledger + deck", () => A.open(prog.p3, p3.publicKey));
  await S.ok("opening again is harmless (idempotent)", () => A.open(prog.p3, p3.publicKey));
  await S.ok("p1 sits in seat 0", () => A.buyIn(prog.p1, p1.publicKey, 0, 10_000_000n));
  const p2BuySig = await S.ok("p2 sits in seat 3", () => A.buyIn(prog.p2, p2.publicKey, 3, 8_000_000n));
  await S.err("p3 can't take an occupied seat", "SeatTaken", () => A.buyIn(prog.p3, p3.publicKey, 0, 2_000_000n));
  await S.err("seat beyond the table's 6 seats rejected", "InvalidSeat", () => A.buyIn(prog.p3, p3.publicKey, 6, 2_000_000n));
  await S.err("rebuy into a different seat rejected", "InvalidSeat", () => A.buyIn(prog.p1, p1.publicKey, 1, 1_000_000n));
  await sleep(2000);

  // ---- access matrix
  const subjects: [string, PublicKey, Record<string, boolean | null>][] = [
    ["table (public settings)", A.table, { p1: true, p2: true, "p3 (outsider)": null, "creator (not seated)": null, "no login": null }],
    ["ledger (seats, stacks, money)", A.ledger, { p1: true, p2: true, "p3 (outsider)": false, "creator (not seated)": false, "no login": false }],
    ["deck", A.deck, { p1: false, p2: false, "p3 (outsider)": false, "creator (not seated)": false, "no login": false }],
    ["hand seat 0 (p1)", handOf(A.table, 0), { p1: true, p2: false, "p3 (outsider)": false, "creator (not seated)": false, "no login": false }],
    ["hand seat 3 (p2)", handOf(A.table, 3), { p1: false, p2: true, "p3 (outsider)": false, "creator (not seated)": false, "no login": false }],
  ];
  const matrix: Record<string, Record<string, string>> = {};
  let matrixOk = true;
  let ledgerBytes: Buffer | undefined;
  for (const [label, acct, expect] of subjects) {
    matrix[label] = {};
    for (const [who, url] of Object.entries(urls)) {
      const r = await rawRead(url, acct);
      matrix[label][who] = r.visible ? `data (${r.dataLen} B)` : "null";
      if (label.startsWith("ledger") && who === "p1" && r.data) ledgerBytes = r.data;
      const want = expect[who];
      if (want !== null && want !== r.visible) matrixOk = false;
    }
  }
  S.check("access matrix: ledger only for seated players, hands only for their owner, deck for nobody", matrixOk, matrix);

  // ---- nothing private on L1
  for (const [label, acct] of [["ledger", A.ledger], ["deck", A.deck], ["hand seat 0", handOf(A.table, 0)]] as [string, PublicKey][]) {
    S.check(`${label} does not exist on L1`, (await connection.getAccountInfo(acct)) === null, { account: acct.toBase58() });
  }
  await S.ok("commit the public table to L1", () => A.commit(prog.deployer, deployer.publicKey));
  await sleep(6000);
  const l1Table = (await connection.getAccountInfo(A.table))!.data;
  const decoded = (l1.coder.accounts as any).decode("table", l1Table);
  const noWallets = !l1Table.includes(p1.publicKey.toBuffer()) && !l1Table.includes(p2.publicKey.toBuffer());
  S.check("L1 copy of the table holds no player wallets", noWallets, { l1Bytes: l1Table.length });
  S.check("L1 copy shows only seat occupancy (seats 0 and 3)", decoded.seatMask === 0b1001, { seatMask: decoded.seatMask });
  const fpMatches = !!ledgerBytes && Buffer.from(decoded.ledgerHash).equals(sha256(ledgerBytes));
  S.check("L1 fingerprint equals sha256 of the private ledger a seated player reads", fpMatches, { ledgerHash: Buffer.from(decoded.ledgerHash).toString("hex"), ledgerSeq: decoded.ledgerSeq.toString() });

  // ---- transaction logs
  const logsFor = async (url: string, sig: string) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }) });
    const j: any = await res.json();
    return { found: !!j.result, logs: j.result?.meta?.logMessages?.length ?? 0 };
  };
  const outsiderView = await logsFor(urls["p3 (outsider)"], p2BuySig);
  const playerView = await logsFor(urls.p1, p2BuySig);
  S.check("an outsider sees no logs of p2's buy-in", outsiderView.logs === 0, { outsider: outsiderView, seatedPlayer: playerView });

  // ---- readers change live
  await S.ok("p1 cashes out of seat 0", () => A.cashOut(prog.p1, p1.publicKey, 0));
  await sleep(2000);
  const afterLeave = {
    p1ReadsLedger: (await rawRead(urls.p1, A.ledger)).visible,
    p2ReadsLedger: (await rawRead(urls.p2, A.ledger)).visible,
    hand0ForP1: (await rawRead(urls.p1, handOf(A.table, 0))).visible,
  };
  S.check("after leaving, p1 can no longer read the ledger and seat 0's hand is gone; p2 still reads the ledger",
    !afterLeave.p1ReadsLedger && afterLeave.p2ReadsLedger && !afterLeave.hand0ForP1, afterLeave);
  await S.ok("p3 sits in the freed seat 0", () => A.buyIn(prog.p3, p3.publicKey, 0, 2_000_000n));
  await sleep(2000);
  S.check("the new occupant (p3) reads seat 0's hand and the ledger", (await rawRead(urls["p3 (outsider)"], handOf(A.table, 0))).visible && (await rawRead(urls["p3 (outsider)"], A.ledger)).visible, {});

  // ---- the escrow's MagicBlock account can't be given a permission by an outsider
  await S.err("an outsider can't attach a permission to the table's escrow account", "",
    () => sendL1(new Transaction().add(createEataPermissionIx(A.escrowEata, p3.publicKey, 0xff)), [p3]));

  // ---- invite-only table B
  const B = tableApi(deployer, randomTableId());
  await S.ok("create + delegate invite-only table B", async () => { await B.create({ ...params, inviteOnly: true }); return B.delegate(); });
  await S.ok("creator sets B's invite list (p1 only), as hashes", () => B.setInvites([inviteHash(B.table, p1.publicKey)]));
  const invData = (await connection.getAccountInfo(invitesOf(B.table)))!.data;
  S.check("the public invite list doesn't contain p1's wallet", !invData.includes(p1.publicKey.toBuffer()), { bytes: invData.length });
  await sleep(4000);
  await S.ok("open table B", () => B.open(prog.p3, p3.publicKey));
  await S.err("uninvited p2 can't sit", "NotInvited", () => B.buyIn(prog.p2, p2.publicKey, 0, 2_000_000n, { invites: invitesOf(B.table) }));
  await S.err("leaving out the invite list doesn't help", "NotInvited", () => B.buyIn(prog.p2, p2.publicKey, 0, 2_000_000n));
  await S.ok("invited p1 sits", () => B.buyIn(prog.p1, p1.publicKey, 0, 2_000_000n, { invites: invitesOf(B.table) }));

  // ---- clean up both tables
  await S.ok("p1 leaves table B", () => B.cashOut(prog.p1, p1.publicKey, 0));
  await S.ok("collect B's rake", () => B.collectRake(prog.deployer, tokenOf(deployer.publicKey)));
  await S.ok("creator closes table B (private accounts deleted, table back on L1)", () => B.close(prog.deployer, deployer.publicKey));
  await S.ok("p2 leaves table A", () => A.cashOut(prog.p2, p2.publicKey, 3));
  await S.ok("p3 leaves table A", () => A.cashOut(prog.p3, p3.publicKey, 0));
  await S.ok("collect A's rake", () => A.collectRake(prog.deployer, tokenOf(deployer.publicKey)));
  await S.ok("creator closes table A", () => A.close(prog.deployer, deployer.publicKey));
  await sleep(8000);
  S.check("after close, A's ledger and deck no longer exist in the rollup", !(await rawRead(urls.p2, A.ledger)).visible && !(await rawRead(urls.p2, A.deck)).visible, {});
  S.check("table A is back on L1, CLOSED", (l1.coder.accounts as any).decode("table", (await connection.getAccountInfo(A.table))!.data).status === 2, {});

  S.finish({ tableA: A.table.toBase58(), tableB: B.table.toBase58() });
}
main().catch((e) => { console.error(e); process.exit(1); });
