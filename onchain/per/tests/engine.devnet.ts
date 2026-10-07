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
import { connection, programFor, programOn, loadKey, teeConnection, TEE_URL, TEE_VALIDATOR, randomTableId } from "../scripts/lib";
import { BN, KIND, Suite, bisectCompute, errName, sleep, tableApi, rawRead, readerFor, sendL1, tokenOf, connUrl, handOf } from "./helpers";
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
  const idle0 = Number((await readTable()).idleSince);
  await sleep(2000);
  await S.ok("open again (idempotent)", () => T.open(prog[4], p3.publicKey));
  S.check("opening again doesn't restart the seed window (no stalling by re-opening)", Number((await readTable()).idleSince) === idle0, { idle0 });
  await S.ok("p1 sits in seat 0 with 2,000,000 (1,900,000 after rake)", () => T.buyIn(prog[0], p1.publicKey, 0, 2_000_000n));
  await S.ok("p2 sits in seat 2 with 4,000,000", () => T.buyIn(prog[2], p2.publicKey, 2, 4_000_000n));
  await S.ok("p3 sits in seat 4 with 6,000,000", () => T.buyIn(prog[4], p3.publicKey, 4, 6_000_000n));

  const hands: any[] = [];
  const readerActed: any[] = [];
  const cu: { hand: string; seat: number; kind: number; units: number; endsHand: boolean }[] = [];
  const conns: Record<number, any> = { 0: er.p1, 2: er.p2, 4: er.p3 };
  // Each seat's reader key, which may also act (the session-key path).
  const readerKey: Record<number, any> = { 0: readerFor(p1.publicKey), 2: readerFor(p2.publicKey), 4: readerFor(p3.publicKey) };
  const readerProg: Record<number, any> = {};
  for (const s of SEATS) readerProg[s] = programOn(await teeConnection(readerKey[s]), readerKey[s]);
  /** Plays one hand: seeds for `seeders`, start, deal, begin, then `policy` until it ends. */
  async function playHand(label: string, seeders: number[], policy: (seat: number, g: any) => [number, bigint], hooks: { afterBegin?: (g: any) => Promise<void>; readerActsFor?: number; beginWithTick?: boolean } = {}) {
    for (const s of seeders) await T.commitSeed(prog[s], wallets[s].publicKey, s, randomBytes(32));
    const t0 = await readTable();
    const handNo = Number(t0.handNo) + 1;
    const stacksBefore = (await readLedger()).seats.map((s: any) => BigInt(s.stack.toString()));
    await T.startHand(prog.deployer, deployer.publicKey);
    const dealtT = await waitState(2, handNo);
    cu.push({ hand: label, seat: -1, kind: -1, units: await bisectCompute(er.deployer, deployer, (u) => T.beginHandTx(prog.deployer, deployer.publicKey, u)), endsHand: false, what: "begin_hand" } as any);
    if (hooks.beginWithTick) await T.tick(prog.deployer); else await T.beginHand(prog.deployer, deployer.publicKey);
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
      if (hooks.readerActsFor === seat) {
        await T.act(readerProg[seat], readerKey[seat].publicKey, seat, kind, amount);
        readerActed.push({ hand: label, seat, kind });
      } else {
        await T.act(prog[seat], wallets[seat].publicKey, seat, kind, amount);
      }
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
      match: out.problem === null && onChain.every((v: number, i: number) => v === csharp[i]) && JSON.stringify(out.board.slice(0, h.record.boardLen)) === JSON.stringify(board.slice(0, h.record.boardLen))
        && order.every((s) => JSON.stringify(out.holes[s]) === JSON.stringify(holes[s])),
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
  // Commits: the table pays, so anyone may commit at most every 15 minutes; the creator any time.
  await S.ok("an outsider (p3) commits the table (its first commit)", () => T.commit(prog[4], p3.publicKey));
  await sleep(8000);
  const l1AfterA = coder.decode("table", (await connection.getAccountInfo(T.table))!.data);
  S.check("the commit reached Solana: the L1 copy shows hand 1, idle", Number(l1AfterA.handNo) === 1 && l1AfterA.handState === 0, { l1HandNo: Number(l1AfterA.handNo), l1HandState: l1AfterA.handState });
  await S.err("an outsider can't commit again within 15 minutes (the table pays)", "CommitTooSoon", () => T.commit(prog[4], p3.publicKey));
  await S.ok("the creator may commit any time", () => T.commit(prog.deployer, deployer.publicKey));

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
      cu.push({ hand: "B: rules and timeout", seat: next, kind: -1, units: await bisectCompute(er.deployer, deployer, (u) => T.timeoutTx(prog.deployer, deployer.publicKey, u)), endsHand: false, what: "timeout" } as any);
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
  S.check("hand C: p3, who missed the seed window, is now marked sitting out", C.ledgerAfter.seats[4].sittingOut === true, {});

  // ---- hand D1: p3 is sitting out, so the next hand starts at once without waiting for them; a
  // seat not dealt in may rebuy mid-hand; p1 acts with its reader key instead of its wallet
  const callOrCheck = (seat: number, g: any): [number, bigint] => {
    const s = g.seats[seat], toCall = BigInt(g.highBet.toString()) - BigInt(s.currentBet.toString());
    return toCall > 0n ? [KIND.call, 0n] : [KIND.check, 0n];
  };
  const D1 = await playHand("D1: p3 sitting out", [0, 2], callOrCheck, {
    readerActsFor: 0,
    beginWithTick: true,
    afterBegin: async () => {
      await S.ok("hand D1: p3 (not dealt in) rebuys 1,000,000 while the hand runs", () => T.buyIn(prog[4], p3.publicKey, 4, 1_000_000n));
    },
  });
  S.check("hand D1: started straight away (no seed window) and dealt seats 0 and 2 only", D1.dealtMask === 0b101, { dealtMask: D1.dealtMask });
  S.check("hand D1: begun by tick (the crank's instruction, no signer needed), not begin_hand", D1.begun.street === 1 && D1.begun.toAct !== 255, { street: D1.begun.street });
  S.check("hand D1: p1's reader key acted for seat 0 (no wallet signature needed)", readerActed.some((r) => r.hand.startsWith("D1") && r.seat === 0), { readerActed });
  const repD1 = replay(D1);
  S.check("hand D1: on-chain final stacks equal the C# engine's replay", repD1.match, repD1);
  // ---- hand D2: p3 commits a seed and plays again
  const D2 = await playHand("D2: p3 back", SEATS, callOrCheck);
  S.check("hand D2: p3 committed a seed and was dealt in again", D2.dealtMask === 0b10101 && D2.ledgerAfter.seats[4].sittingOut === false, { dealtMask: D2.dealtMask });
  const repD2 = replay(D2);
  S.check("hand D2: on-chain final stacks equal the C# engine's replay", repD2.match, repD2);

  const idleBefore = await readTable();
  await S.ok("tick with nothing to do succeeds and changes nothing (so a crank's schedule keeps advancing)", () => T.tick(prog.deployer));
  const idleAfter = await readTable();
  S.check("...table unchanged by the idle tick", idleAfter.handState === idleBefore.handState && Number(idleAfter.ledgerSeq) === Number(idleBefore.ledgerSeq), {});
  const showdownCu = cu.filter((c) => c.endsHand);
  const what = (c: any) => c.what ?? "act";
  S.check("compute (bisected, within 2,000 units): begin_hand, every act (incl. showdown + settlement + commit) and timeout fit well under 1.4M",
    cu.length > 0 && cu.every((c) => c.units > 0 && c.units < 1_000_000),
    { maxAny: Math.max(...cu.map((c) => c.units)), beginHand: cu.filter((c) => what(c) === "begin_hand").map((c) => c.units), timeout: cu.filter((c) => what(c) === "timeout").map((c) => c.units),
      endOfHand: showdownCu.map((c) => ({ hand: c.hand, units: c.units })), acts: cu.filter((c) => what(c) === "act").map((c) => c.units) });

  // ---- clean up
  for (const s of SEATS) await S.ok(`seat ${s} cashes out`, () => T.cashOut(prog[s], wallets[s].publicKey, s));
  await S.ok("collect rake", () => T.collectRake(prog.deployer, tokenOf(deployer.publicKey)));
  await S.ok("creator closes the table (hand log deleted too)", () => T.close(prog.deployer, deployer.publicKey));
  await sleep(6000);
  S.check("after close the hand log and ledger are gone", !(await rawRead(rd.p1, T.log)).visible && !(await rawRead(rd.p1, T.ledger)).visible, {});
  // Are bet sizes readable from the act transactions once the table's private accounts are gone?
  const actDisc = createHash("sha256").update("global:act").digest().subarray(0, 8);
  const rpcNoLogin = async (method: string, params: any[]) => (await (await fetch(TEE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;
  let bets = { listed: 0, actTxs: 0, actWithAmountVisible: 0, hidden: 0 };
  for (let tries = 0; tries < 6; tries++) {
    const sigs = (await rpcNoLogin("getSignaturesForAddress", [T.table.toBase58(), { limit: 200 }])).result ?? [];
    bets = { listed: sigs.length, actTxs: 0, actWithAmountVisible: 0, hidden: 0 };
    for (const sg of sigs) {
      const msg = (await rpcNoLogin("getTransaction", [sg.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }])).result?.transaction?.message;
      if (!msg || !(msg.accountKeys ?? []).length) { bets.hidden++; continue; }
      for (const ix of msg.instructions ?? []) {
        const d = Buffer.from(require("bs58").decode(ix.data));
        if (d.subarray(0, 8).equals(actDisc)) { bets.actTxs++; if (d.length >= 18) bets.actWithAmountVisible++; }
      }
    }
    if (bets.actTxs > 0) break;
    await sleep(10_000);
  }
  S.known("after the table closes, bet sizes in its act transactions are readable with no login (bets are meant to stay private)", bets.actWithAmountVisible > 0, bets);

  S.finish({ table: T.table.toBase58(), hands: hands.map((x) => ({ label: x.label, handNo: x.handNo, button: x.button, dealtMask: x.dealtMask, actions: x.allActions ?? x.actions })),
    replays: { A: repA, B: repB, C: repC, D1: repD1, D2: repD2 }, computeUnits: cu });
}

function nextOf(seat: number, mask: number) {
  for (let i = 1; i <= 6; i++) { const s = (seat + i) % 6; if (mask & (1 << s)) return s; }
  return seat;
}
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

main().catch((e) => { S.check("suite crashed", false, { error: String(e?.stack ?? e).slice(0, 800) }); S.finish({}); });
