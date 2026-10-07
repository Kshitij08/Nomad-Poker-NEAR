// M5 devnet tests: real Hold'em hands played by the on-chain engine inside the TEE, each one replayed
// through the game's own C# engine (per/golden, `replay` mode) with the same cards, button, stacks
// and actions; the final stacks must match exactly. Also: blinds, turn order, illegal actions,
// the 15 s turn timer, side pots, the seed window, rebuy/cash-out locks during a hand, the action
// log's privacy and hash. Results go to results/m5-engine-<ts>.json.
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { createHash, randomBytes } from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { programFor, programOn, loadKey, teeConnection, TEE_URL, TEE_VALIDATOR, randomTableId } from "../scripts/lib";
import { BN, KIND, Suite, errName, sleep, tableApi, rawRead, readerFor, sendL1, tokenOf, connUrl, handOf } from "./helpers";
import { holeCards, dealOrder, boardOf, cardName } from "./verifier";

const S = new Suite("m5-engine");
const SEATS = [0, 2, 4];
const LOG_TIMEOUT = 0x80;

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1"), p2 = loadKey("p2"), p3 = loadKey("p3");
  const wallets: Record<number, any> = { 0: p1, 2: p2, 4: p3 };
  const coder = programFor(deployer).coder.accounts as any;
  const er = { deployer: await teeConnection(deployer), p1: await teeConnection(p1), p2: await teeConnection(p2), p3: await teeConnection(p3) };
  for (const [name, kp] of [["p1", p1], ["p2", p2], ["p3", p3]] as [keyof typeof er, any][]) {
    let bal = 0n;
    try { bal = BigInt((await er[name].getTokenAccountBalance(tokenOf(kp.publicKey))).value.amount); } catch { /* none yet */ }
    if (bal < 12_000_000n) {
      const amt = 12_000_000n - bal, ata = tokenOf(kp.publicKey);
      const ixs = await delegateSpl(kp.publicKey, NATIVE_MINT, amt, { validator: TEE_VALIDATOR, initVaultIfMissing: true, initAtasIfMissing: true, payer: kp.publicKey });
      await S.ok(`top-up ${name} to 0.012 wSOL in the rollup`, () => sendL1(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata, lamports: Number(amt) }), createSyncNativeInstruction(ata), ...ixs), [kp]));
    }
  }
  await sleep(6000);
  const prog: Record<string, any> = { deployer: programOn(er.deployer, deployer), 0: programOn(er.p1, p1), 2: programOn(er.p2, p2), 4: programOn(er.p3, p3) };
  const rd = { p1: connUrl(await teeConnection(readerFor(p1.publicKey))), p2: connUrl(await teeConnection(readerFor(p2.publicKey))), p3: connUrl(await teeConnection(readerFor(p3.publicKey))) };
  const outsiderUrl = connUrl(er.deployer); // the creator isn't seated: an outsider for reads

  const T = tableApi(deployer, randomTableId());
  const params = { smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false };
  const readTable = async () => coder.decode("table", (await er.deployer.getAccountInfo(T.table, "processed"))!.data);
  const readLedger = async () => coder.decode("ledger", (await rawRead(rd.p1, T.ledger)).data!);
  const readRecord = async () => coder.decode("handRecord", (await rawRead(TEE_URL, T.record)).data!);
  const waitState = async (state: number, handNo?: number) => {
    for (let i = 0; i < 300; i++) {
      const t = await readTable();
      if (t.handState === state && (handNo === undefined || Number(t.handNo) === handNo)) return t;
      await sleep(100);
    }
    throw new Error(`table never reached state ${state}`);
  };

  await S.ok("create + delegate a 6-seat table (blinds 0.0001 / 0.0002)", async () => { await T.create(params); return T.delegate(); });
  await sleep(4000);
  await S.ok("open (ledger, deck, record, hand log)", () => T.open(prog.deployer, deployer.publicKey));
  await S.ok("p1 sits in seat 0 with 2,000,000 (1,900,000 after rake)", () => T.buyIn(prog[0], p1.publicKey, 0, 2_000_000n));
  await S.ok("p2 sits in seat 2 with 4,000,000", () => T.buyIn(prog[2], p2.publicKey, 2, 4_000_000n));
  await S.ok("p3 sits in seat 4 with 6,000,000", () => T.buyIn(prog[4], p3.publicKey, 4, 6_000_000n));

  const hands: any[] = [];
  const cu: { hand: string; seat: number; kind: number; units: number; endsHand: boolean }[] = [];
  const conns: Record<number, any> = { 0: er.p1, 2: er.p2, 4: er.p3 };
  /** Plays one hand: seeds for `seeders`, start, deal, begin, then `policy` until it ends. */
  async function playHand(label: string, seeders: number[], policy: (seat: number, g: any) => [number, bigint], hooks: { afterBegin?: (g: any) => Promise<void> } = {}) {
    for (const s of seeders) await T.commitSeed(prog[s], wallets[s].publicKey, s, randomBytes(32));
    const t0 = await readTable();
    const handNo = Number(t0.handNo) + 1;
    const stacksBefore = (await readLedger()).seats.map((s: any) => BigInt(s.stack.toString()));
    await T.startHand(prog.deployer, deployer.publicKey);
    const dealtT = await waitState(2, handNo);
    await T.beginHand(prog.deployer, deployer.publicKey);
    let g = (await readLedger()).game;
    const begun = g;
    if (hooks.afterBegin) await hooks.afterBegin(g);
    g = (await readLedger()).game;
    const actions: [number, number, string][] = [];
    for (let guard = 0; guard < 60 && g.street !== 5; guard++) {
      const seat = g.toAct;
      const [kind, amount] = policy(seat, g);
      // Compute cost: the TEE reports 0 units even in simulation, but it does say whether a
      // simulation succeeds, so bisect the smallest compute limit at which this exact action passes.
      const conn = conns[seat];
      const passes = async (units: number) => {
        const tx = await T.actTx(prog[seat], wallets[seat].publicKey, seat, kind, amount, units);
        tx.feePayer = wallets[seat].publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(wallets[seat]);
        return !(await conn.simulateTransaction(tx)).value.err;
      };
      let lo = 0, hi = 1_400_000;
      if (!(await passes(hi))) hi = -1;
      while (hi > 0 && hi - lo > 2_000) { const mid = Math.floor((lo + hi) / 2); if (await passes(mid)) hi = mid; else lo = mid; }
      cu.push({ hand: label, seat, kind, units: hi, endsHand: false });
      await T.act(prog[seat], wallets[seat].publicKey, seat, kind, amount);
      actions.push([seat, kind, amount.toString()]);
      g = (await readLedger()).game;
      if (g.street === 5) cu[cu.length - 1].endsHand = true;
    }
    const tEnd = await readTable();
    const ledgerAfter = await readLedger();
    const record = await readRecord();
    hands.push({ label, handNo, dealtMask: dealtT.dealtMask, button: dealtT.button, stacksBefore, begun, actions, record, ledgerAfter, tableAfter: tEnd });
    return hands[hands.length - 1];
  }

  /** Replays a finished hand through the C# engine and compares final stacks and the board. */
  function replay(h: any, extraActions: [number, number, string][] = []) {
    const seatCount = 6;
    const deck: number[] = Array.from(h.record.cards);
    const order = dealOrder(h.button, h.dealtMask);
    const holes = holeCards(deck, order);
    const board = boardOf(deck, order.length);
    const dealt = (s: number) => (h.dealtMask & (1 << s)) !== 0;
    const input = {
      seatCount, sb: 100_000, bb: 200_000, button: h.button,
      stacks: Array.from({ length: seatCount }, (_, s) => (dealt(s) ? Number(h.stacksBefore[s]) : -1)),
      holes: Array.from({ length: seatCount }, (_, s) => (dealt(s) ? holes[s] : null)),
      board, actions: (h.allActions ?? h.actions).map((a: any) => [a[0], a[1], Number(a[2])]),
    };
    const file = path.join(os.tmpdir(), `replay-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
    const out = JSON.parse(execFileSync("dotnet", ["run", "-c", "Release", "--project", path.join(__dirname, "../golden"), "--", "replay", file], { encoding: "utf8" }).trim().split("\n").pop()!);
    // The ledger has a slot for every possible seat (9); the table uses the first 6.
    const onChain = h.ledgerAfter.seats.slice(0, seatCount).map((s: any, i: number) => (dealt(i) ? Number(s.stack.toString()) : -1));
    const csharp = out.final.map((x: number, i: number) => (dealt(i) ? x : -1));
    return {
      match: out.problem === null && onChain.every((v: number, i: number) => v === csharp[i]) && JSON.stringify(out.board.slice(0, h.record.boardLen)) === JSON.stringify(board.slice(0, h.record.boardLen)),
      onChain, csharp, problem: out.problem, csharpAwards: out.awards, board: board.slice(0, h.record.boardLen).map(cardName),
      holes: Object.fromEntries(order.map((s) => [s, holes[s].map(cardName)])),
    };
  }

  // ---- hand A: everyone in, short stack shoves, middle stack shoves over, big stack calls: side pots
  const shove = (seat: number, g: any): [number, bigint] => {
    const s = g.seats[seat], toCall = BigInt(g.highBet.toString()) - BigInt(s.currentBet.toString());
    if (seat === 4) return toCall > 0n ? [KIND.call, 0n] : [KIND.check, 0n];
    return [KIND.allIn, 0n];
  };
  const A = await playHand("A: side pots", SEATS, shove);
  const repA = replay(A);
  S.check("hand A: blinds and first actor follow the C# rules (SB, BB left of the button; first to act left of the BB)",
    A.begun.sbSeat === nextOf(A.button, A.dealtMask) && A.begun.bbSeat === nextOf(A.begun.sbSeat, A.dealtMask) && A.begun.toAct === nextOf(A.begun.bbSeat, A.dealtMask),
    { button: A.button, sb: A.begun.sbSeat, bb: A.begun.bbSeat, firstToAct: A.begun.toAct });
  S.check("hand A: went to showdown with the full board", A.record.boardLen === 5, { boardLen: A.record.boardLen, actions: A.actions });
  S.check("hand A: on-chain final stacks equal the C# engine's replay of the same hand", repA.match, repA);
  S.check("hand A: chips conserved (stacks before = stacks after)", sum(A.stacksBefore) === sum(A.ledgerAfter.seats.map((s: any) => BigInt(s.stack.toString()))), {});
  S.check("hand A: more than one pot paid out (main + side pot)", repA.csharpAwards.length >= 2, { awards: repA.csharpAwards });

  // Anyone left with nothing rebuys between hands.
  for (const s of SEATS) {
    const st = BigInt((await readLedger()).seats[s].stack.toString());
    if (st === 0n) await S.ok(`seat ${s} busted in hand A and rebuys 2,000,000 between hands`, () => T.buyIn(prog[s], wallets[s].publicKey, s, 2_000_000n));
  }

  // ---- hand B: rules, locks, timeout
  const B = await playHand("B: rules and timeout", SEATS, (seat, g) => {
    const s = g.seats[seat], toCall = BigInt(g.highBet.toString()) - BigInt(s.currentBet.toString());
    return toCall > 0n ? [KIND.call, 0n] : [KIND.check, 0n];
  }, {
    afterBegin: async (g) => {
      const seat = g.toAct, other = SEATS.find((s) => s !== seat)!;
      await S.err("hand B: a wallet can't act for a seat it doesn't hold", "NotSeated", () => T.act(prog[other], wallets[other].publicKey, seat, KIND.call));
      await S.err("hand B: acting out of turn is refused", "NotYourTurn", () => T.act(prog[other], wallets[other].publicKey, other, KIND.call));
      await S.err("hand B: checking when facing the big blind is refused", "IllegalAction", () => T.act(prog[seat], wallets[seat].publicKey, seat, KIND.check));
      const minTo = BigInt(g.highBet.toString()) + BigInt(g.minRaise.toString());
      await S.err("hand B: a raise below the minimum is refused", "IllegalAction", () => T.act(prog[seat], wallets[seat].publicKey, seat, KIND.raise, minTo - 1n));
      await S.err("hand B: rebuy during a hand is refused", "HandInProgress", () => T.buyIn(prog[seat], wallets[seat].publicKey, seat, 200_000n));
      await S.err("hand B: cash-out during a hand is refused", "HandInProgress", () => T.cashOut(prog[seat], wallets[seat].publicKey, seat));
      await S.err("hand B: timeout before the 15 s turn is up is refused", "TurnNotOver", () => T.timeout(prog.deployer, deployer.publicKey));
      const logReaders = { dealtPlayer: (await rawRead(rd.p1, T.log)).visible, outsider: (await rawRead(outsiderUrl, T.log)).visible, noLogin: (await rawRead(TEE_URL, T.log)).visible };
      S.check("hand B: the action log is readable by a player dealt in, not by an outsider or without login", logReaders.dealtPlayer && !logReaders.outsider && !logReaders.noLogin, logReaders);
      await S.ok(`hand B: seat ${seat} makes a minimum raise to ${minTo}`, () => T.act(prog[seat], wallets[seat].publicKey, seat, KIND.raise, minTo));
      (globalThis as any).bPre = [[seat, KIND.raise, minTo.toString()]];
      const next = (await readLedger()).game.toAct;
      await sleep(16_500);
      await S.ok(`hand B: after 15 s anyone (the creator, not seated) times out seat ${next}`, () => T.timeout(prog.deployer, deployer.publicKey));
      const g2 = (await readLedger()).game;
      (globalThis as any).bPre.push([next, g2.seats[next].status === 3 ? KIND.fold : KIND.check, "0"]);
      S.check(`hand B: the timed-out seat ${next} was folded (it faced a raise)`, g2.seats[next].status === 3, { status: g2.seats[next].status });
    },
  });
  B.allActions = [...(globalThis as any).bPre, ...B.actions];
  const repB = replay(B);
  S.check("hand B: on-chain final stacks equal the C# engine's replay (including the timeout fold)", repB.match, repB);
  const logRaw = (await rawRead(rd.p1, T.log)).data!;
  const log = coder.decode("handLog", logRaw);
  let h = createHash("sha256").update(T.table.toBuffer()).update(u64(BigInt(B.handNo))).digest();
  for (let i = 0; i < log.len; i++) {
    const e = log.entries[i];
    h = createHash("sha256").update(h).update(Buffer.from([e.street, e.seat, e.kind])).update(u64(BigInt(e.committed.toString()))).digest();
  }
  const timeoutLogged = Array.from({ length: log.len }, (_, i) => log.entries[i]).some((e: any) => (e.kind & LOG_TIMEOUT) !== 0);
  S.check("hand B: the log a player reads hashes to the public record's log hash, and marks the timeout", h.equals(Buffer.from(B.record.logHash)) && log.len === B.record.logLen && timeoutLogged,
    { entries: log.len, recordLogLen: B.record.logLen, timeoutLogged });

  for (const s of SEATS) {
    const st = BigInt((await readLedger()).seats[s].stack.toString());
    if (st === 0n) await T.buyIn(prog[s], wallets[s].publicKey, s, 2_000_000n);
  }

  // ---- hand C: p3 doesn't commit a seed; after the 20 s window the others play heads-up
  for (const s of [0, 2]) await T.commitSeed(prog[s], wallets[s].publicKey, s, randomBytes(32));
  await S.err("hand C: with p3's seed missing the hand can't start inside the seed window", "MissingSeeds", () => T.startHand(prog.deployer, deployer.publicKey));
  const idle = Number((await readTable()).idleSince);
  await sleep(Math.max(0, (idle + 21) * 1000 - Date.now()));
  const C = await playHand("C: heads-up after the seed window", [], (seat, g) => {
    const s = g.seats[seat], toCall = BigInt(g.highBet.toString()) - BigInt(s.currentBet.toString());
    return toCall > 0n ? [KIND.call, 0n] : [KIND.check, 0n];
  });
  const repC = replay(C);
  S.check("hand C: dealt to seats 0 and 2 only (p3 sat out)", C.dealtMask === 0b101, { dealtMask: C.dealtMask });
  S.check("hand C: heads-up rule: the button posts the small blind", C.begun.sbSeat === C.button, { button: C.button, sb: C.begun.sbSeat });
  S.check("hand C: on-chain final stacks equal the C# engine's replay", repC.match, repC);
  S.check("hand C: p3's stack is untouched", BigInt(C.ledgerAfter.seats[4].stack.toString()) === C.stacksBefore[4], {});

  const showdownCu = cu.filter((c) => c.endsHand);
  S.check("compute (bisected, within 2,000 units): every action, including those that run a showdown and settle the hand, fits well under 1.4M", cu.length > 0 && cu.every((c) => c.units > 0 && c.units < 1_000_000),
    { maxAny: Math.max(...cu.map((c) => c.units)), endOfHand: showdownCu.map((c) => ({ hand: c.hand, units: c.units })), all: cu.map((c) => c.units) });

  // ---- clean up
  for (const s of SEATS) await S.ok(`seat ${s} cashes out`, () => T.cashOut(prog[s], wallets[s].publicKey, s));
  await S.ok("collect rake", () => T.collectRake(prog.deployer, tokenOf(deployer.publicKey)));
  await S.ok("creator closes the table (hand log deleted too)", () => T.close(prog.deployer, deployer.publicKey));
  await sleep(6000);
  S.check("after close the hand log and ledger are gone", !(await rawRead(rd.p1, T.log)).visible && !(await rawRead(rd.p1, T.ledger)).visible, {});

  S.finish({ table: T.table.toBase58(), hands: hands.map((x) => ({ label: x.label, handNo: x.handNo, button: x.button, dealtMask: x.dealtMask, actions: x.allActions ?? x.actions })),
    replays: { A: repA, B: repB, C: repC }, computeUnits: cu });
}

function nextOf(seat: number, mask: number) {
  for (let i = 1; i <= 6; i++) { const s = (seat + i) % 6; if (mask & (1 << s)) return s; }
  return seat;
}
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

main().catch((e) => { S.check("suite crashed", false, { error: String(e?.stack ?? e).slice(0, 800) }); S.finish({}); });
