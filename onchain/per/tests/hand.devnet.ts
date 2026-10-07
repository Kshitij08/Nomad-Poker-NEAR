// M4 devnet tests: VRF shuffle and deal. Seeds (required from every seat's current occupant), a
// spoofed callback, two real hands dealt by the VRF inside the TEE, private hole cards, the ledger
// salt, what a reader can see of the oracle's transaction, the public hand record and the off-chain
// verifier (including tampered records). Results go to results/m4-hand-<ts>.json.
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { randomBytes } from "crypto";
import { programFor, programOn, loadKey, teeConnection, TEE_URL, TEE_VALIDATOR, randomTableId } from "../scripts/lib";
import { BN, Suite, errName, sleep, tableApi, handOf, rawRead, readerFor, sendL1, sha256, tokenOf, connUrl } from "./helpers";
import { verify, holeCards, dealOrder, nextButton, cardName, NO_CARD, Record } from "./verifier";

const S = new Suite("m4-hand");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const HAND_DEALT = 2, HAND_IDLE = 0;

async function rpcAt(url: string, method: string, params: any[]) {
  return (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;
}

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
  const rd = { p1: await teeConnection(readerFor(p1.publicKey)), p2: await teeConnection(readerFor(p2.publicKey)) };
  const url = { p1: connUrl(rd.p1), p2: connUrl(rd.p2), outsider: connUrl(er.p3) };

  const T = tableApi(deployer, randomTableId());
  const readTable = async () => coder.decode("table", (await er.deployer.getAccountInfo(T.table, "processed"))!.data);
  const readHand = async (u: string, seat: number) => { const r = await rawRead(u, handOf(T.table, seat)); return r.data ? coder.decode("hand", r.data) : null; };
  const readRecord = async (): Promise<Record | null> => {
    const r = await rawRead(TEE_URL, T.record);  // no login: the record is public
    if (!r.data) return null;
    const x = coder.decode("handRecord", r.data);
    return { table: x.table, handNo: BigInt(x.handNo.toString()), button: x.button, dealtMask: x.dealtMask, seedMask: x.seedMask,
      seeds: x.seeds.map((s: number[]) => Buffer.from(s)), entropy: Buffer.from(x.entropy), shuffleSeed: Buffer.from(x.shuffleSeed), cards: Array.from(x.cards) };
  };
  const waitDealt = async (hand: number) => {
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const t = await readTable();
      if (t.handState === HAND_DEALT && Number(t.handNo) === hand) return Date.now() - start;
      await sleep(50);
    }
    return -1;
  };

  await S.ok("create + delegate a 6-seat table", async () => { await T.create(params); return T.delegate(); });
  await sleep(4000);
  await S.ok("open: ledger, deck and the public hand record", () => T.open(prog.deployer, deployer.publicKey));
  S.check("the hand record is readable with no login (public)", (await rawRead(TEE_URL, T.record)).visible, {});
  await S.ok("p1 sits in seat 0", () => T.buyIn(prog.p1, p1.publicKey, 0, 2_000_000n));
  await S.err("a hand can't start with one player", "NotEnoughPlayers", () => T.startHand(prog.p3, p3.publicKey));
  await S.ok("p2 sits in seat 3", () => T.buyIn(prog.p2, p2.publicKey, 3, 2_000_000n));

  // ---- seeds
  const seed1 = randomBytes(32), seed2 = randomBytes(32);
  const seedSig = await S.ok("p1 commits a hidden seed for seat 0", () => T.commitSeed(prog.p1, p1.publicKey, 0, seed1));
  await S.err("a hand can't start until every seated player has committed a seed", "MissingSeeds", () => T.startHand(prog.p3, p3.publicKey));
  await S.err("an outsider can't commit a seed for a seat", "NotSeated", () => T.commitSeed(prog.p3, p3.publicKey, 0, randomBytes(32)));
  await S.err("p1 can't commit a seed for p2's seat", "NotSeated", () => T.commitSeed(prog.p1, p1.publicKey, 3, randomBytes(32)));
  // A departed player's seed doesn't count for the next occupant of the seat.
  await S.ok("p3 sits in seat 5 and commits a seed", async () => { await T.buyIn(prog.p3, p3.publicKey, 5, 2_000_000n); return T.commitSeed(prog.p3, p3.publicKey, 5, randomBytes(32)); });
  await S.ok("p3 leaves; the creator takes seat 5 without committing", async () => { await T.cashOut(prog.p3, p3.publicKey, 5); return T.buyIn(prog.deployer, deployer.publicKey, 5, 2_000_000n); });
  await S.ok("p2 commits a hidden seed for seat 3", () => T.commitSeed(prog.p2, p2.publicKey, 3, seed2));
  await S.err("seat 5 still holds p3's old seed, which doesn't count for the creator", "MissingSeeds", () => T.startHand(prog.p3, p3.publicKey));
  await S.ok("the creator leaves seat 5", () => T.cashOut(prog.deployer, deployer.publicKey, 5));

  const txView = async (u: string) => {
    const r = await rpcAt(u, "getTransaction", [seedSig, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    const raw = r.result?.transaction?.[0] ? Buffer.from(r.result.transaction[0], "base64") : null;
    return { found: !!r.result, seedVisible: !!raw?.includes(seed1) };
  };
  const views = { p1WalletControl: await txView(connUrl(er.p1)), p2Reader: await txView(url.p2), outsider: await txView(url.outsider), noLogin: await txView(TEE_URL) };
  S.check("p1's seed: p1 can fetch its own transaction (control), but the other player, an outsider and no login can't see the seed",
    views.p1WalletControl.found && !views.p2Reader.seedVisible && !views.outsider.seedVisible && !views.noLogin.seedVisible, views);

  // ---- a spoofed callback
  await S.err("a fake VRF callback signed by an outsider is rejected", "ConstraintAddress",
    () => prog.p3.methods.deal(Array.from(randomBytes(32)), BN(1)).accountsPartial({ vrfProgramIdentity: p3.publicKey, table: T.table, deck: T.deck, ledger: T.ledger }).rpc());
  await S.err("abort with no hand running is refused", "HandNotDealt", () => T.abortHand(prog.p3, p3.publicKey));

  // ---- hand 1
  await S.ok("an outsider (p3) starts hand 1: VRF requested", () => T.startHand(prog.p3, p3.publicKey));
  const retry = await T.startHand(prog.p3, p3.publicKey).then(() => "accepted", (e) => errName(e));
  S.check("a second request straight away is refused (still shuffling, or already dealt)", /VrfPending|HandInProgress/.test(retry), { result: retry });
  const lat1 = await waitDealt(1);
  S.check("the VRF callback dealt hand 1", lat1 >= 0, { msFromRequestToDealt: lat1 });
  const t1 = await readTable();
  await S.err("no second start while dealt", "HandInProgress", () => T.startHand(prog.p3, p3.publicKey));
  await S.err("no seed commits during a hand", "HandInProgress", () => T.commitSeed(prog.p1, p1.publicKey, 0, randomBytes(32)));
  await S.err("no cash-out during a hand", "HandInProgress", () => T.cashOut(prog.p1, p1.publicKey, 0));
  await S.err("abort of a dealt hand is refused", "HandNotDealt", () => T.abortHand(prog.p3, p3.publicKey));

  const h0 = await readHand(url.p1, 0), h3 = await readHand(url.p2, 3);
  S.check("each player reads their own two cards (dealt, hand 1)", !!h0 && !!h3 && h0.cards.every((c: number) => c < 52) && h3.cards.every((c: number) => c < 52) && Number(h0.handNo) === 1,
    { p1: h0?.cards.map(cardName), p2: h3?.cards.map(cardName), button: t1.button });
  S.check("players can't read each other's cards; outsiders read neither; nobody reads the deck", !(await rawRead(url.p1, handOf(T.table, 3))).visible && !(await rawRead(url.p2, handOf(T.table, 0))).visible
    && !(await rawRead(url.outsider, handOf(T.table, 0))).visible && !(await rawRead(url.p1, T.deck)).visible && !(await rawRead(TEE_URL, T.deck)).visible, {});
  const ledgerRaw = (await rawRead(url.p1, T.ledger)).data;
  const salt = ledgerRaw ? Buffer.from(coder.decode("ledger", ledgerRaw).salt) : Buffer.alloc(32);
  S.check("the ledger got a salt from the VRF, and the table's fingerprint covers it", !!ledgerRaw && !salt.equals(Buffer.alloc(32)) && Buffer.from(t1.ledgerHash).equals(sha256(ledgerRaw)), { ledgerReadable: !!ledgerRaw });

  // What can a seated player's reader see of the VRF oracle's transaction (it touches the ledger and hands)?
  const sigs = (await rpcAt(url.p1, "getSignaturesForAddress", [T.ledger.toBase58(), { limit: 20 }])).result ?? [];
  let oracleTx: any = { listed: sigs.length, fulfillmentSeen: false };
  for (const s of sigs) {
    const r = await rpcAt(url.p1, "getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
    const keys: string[] = r.result?.transaction?.message?.accountKeys ?? [];
    if (keys.includes(VRF_PROGRAM.toBase58())) { oracleTx = { listed: sigs.length, fulfillmentSeen: true, dataBytes: (r.result.transaction.message.instructions ?? []).map((i: any) => i.data?.length ?? 0) }; break; }
  }
  S.check("a seated player's reader can't see the VRF oracle's fulfillment transaction", !oracleTx.fulfillmentSeen, oracleTx);

  // ---- end hand 1 and verify it from the public record
  await S.err("an outsider can't end the hand", "NotSeated", () => T.endHand(prog.p3, p3.publicKey));
  await S.ok("p2 ends hand 1 (M4 stand-in for showdown)", () => T.endHand(prog.p2, p2.publicKey));
  const r1 = await readRecord();
  const v1a = r1 ? verify(r1, { seat: 0, seed: seed1, cards: h0?.cards }) : { ok: false, problems: ["no record"], deck: [] };
  const v1b = r1 ? verify(r1, { seat: 3, seed: seed2, cards: h3?.cards }) : { ok: false, problems: ["no record"], deck: [] };
  S.check("verifier (no login): hand 1's deck and button recompute from entropy + both seeds, and match both players' cards", v1a.ok && v1b.ok && r1?.handNo === 1n && r1?.dealtMask === 0b1001,
    { p1: v1a.problems, p2: v1b.problems, button: r1?.button, seedMask: r1?.seedMask, first10: r1?.cards.slice(0, 10).map(cardName) });
  S.check("the public record contains neither the ledger salt nor the departed player's seat-5 seed", !!r1 && ![r1.entropy, r1.shuffleSeed, ...r1.seeds].some((b) => b.equals(salt)) && r1.seeds[5].equals(Buffer.alloc(32)) && (r1.seedMask & (1 << 5)) === 0, {});
  if (r1) {
    const tamperCard = verify({ ...r1, cards: [r1.cards[1], r1.cards[0], ...r1.cards.slice(2)] });
    const tamperSeed = verify({ ...r1, seeds: r1.seeds.map((s, i) => (i === 3 ? randomBytes(32) : s)) });
    const tamperEntropy = verify({ ...r1, entropy: randomBytes(32) });
    const tamperButton = verify({ ...r1, button: r1.button === 0 ? 3 : 0 });
    S.check("tampered records fail verification (swapped cards, a changed seed, changed entropy, moved button)", !tamperCard.ok && !tamperSeed.ok && !tamperEntropy.ok && !tamperButton.ok,
      { card: tamperCard.problems, seed: tamperSeed.problems, entropy: tamperEntropy.problems, button: tamperButton.problems });
  }
  S.check("table back to idle after the hand", (await readTable()).handState === HAND_IDLE, {});

  // ---- hand 2: seeds don't carry over; the button moves on
  const seed1b = randomBytes(32), seed2b = randomBytes(32);
  await S.ok("p1 commits a fresh seed for hand 2", () => T.commitSeed(prog.p1, p1.publicKey, 0, seed1b));
  await S.err("hand 2 can't start on p2's hand-1 seed", "MissingSeeds", () => T.startHand(prog.p1, p1.publicKey));
  await S.ok("p2 commits a fresh seed for hand 2", () => T.commitSeed(prog.p2, p2.publicKey, 3, seed2b));
  await S.ok("p1 starts hand 2", () => T.startHand(prog.p1, p1.publicKey));
  const lat2 = await waitDealt(2);
  const t2 = await readTable();
  S.check("hand 2 dealt; the button moved to the next seated seat", lat2 >= 0 && t2.button === nextButton(t1.button, 0b1001), { msFromRequestToDealt: lat2, button1: t1.button, button2: t2.button });
  const h0b = await readHand(url.p1, 0);
  await S.ok("the creator ends hand 2", () => T.endHand(prog.deployer, deployer.publicKey));
  const r2 = await readRecord();
  const v2 = r2 ? verify(r2, { seat: 0, seed: seed1b, cards: h0b?.cards }, r1?.button) : { ok: false, problems: ["no record"], deck: [] as number[] };
  S.check("verifier: hand 2 recomputes, including the button rotation", v2.ok && r2?.handNo === 2n && verify(r2!, { seat: 3, seed: seed2b }).ok, { problems: v2.problems });
  S.check("hand 2's deck differs from hand 1's", !!r1 && !!r2 && r2.cards.join() !== r1.cards.join(), {});
  if (r2) {
    const order = dealOrder(r2.button, r2.dealtMask);
    S.check("dealing order starts left of the button", order[0] === nextButton(r2.button, r2.dealtMask) && holeCards(v2.deck, order)[0].every((c) => c !== NO_CARD), { order });
  }

  // ---- clean up
  await S.ok("p1 cashes out", () => T.cashOut(prog.p1, p1.publicKey, 0));
  await S.ok("p2 cashes out", () => T.cashOut(prog.p2, p2.publicKey, 3));
  await S.ok("collect rake", () => T.collectRake(prog.deployer, tokenOf(deployer.publicKey)));
  await S.ok("creator closes the table (record deleted too)", () => T.close(prog.deployer, deployer.publicKey));
  await sleep(6000);
  S.check("after close the record, deck and ledger are gone from the rollup", !(await rawRead(TEE_URL, T.record)).visible && !(await rawRead(url.p1, T.deck)).visible && !(await rawRead(url.p1, T.ledger)).visible, {});

  S.finish({ table: T.table.toBase58(), latenciesMs: [lat1, lat2], hand1: { button: r1?.button, deck: r1?.cards.map(cardName).join(" ") } });
}
main().catch((e) => { S.check("suite crashed", false, { error: String(e?.stack ?? e).slice(0, 600) }); S.finish({}); });
