// M4 devnet tests: VRF shuffle and deal. Seeds, a spoofed callback, two real hands dealt by the VRF
// inside the TEE, private hole cards, the ledger salt, the public hand record and the off-chain
// verifier (including tampered records). Results go to results/m4-hand-<ts>.json.
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { randomBytes } from "crypto";
import { CONFIG_PDA, PROGRAM_ID, programFor, programOn, loadKey, teeConnection, TEE_URL, TEE_VALIDATOR, randomTableId } from "../scripts/lib";
import { BN, Suite, errName, sleep, tableApi, handOf, rawRead, readerFor, sendL1, sha256, tokenOf, connUrl } from "./helpers";
import { verify, holeCards, dealOrder, nextButton, cardName, NO_CARD, Record } from "./verifier";

const S = new Suite("m4-hand");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const HAND_DEALT = 2, HAND_IDLE = 0;

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1"), p2 = loadKey("p2"), p3 = loadKey("p3");
  const l1 = programFor(deployer);
  const coder = l1.coder.accounts as any;
  const params = { smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false };

  const er = { deployer: await teeConnection(deployer), p1: await teeConnection(p1), p2: await teeConnection(p2), p3: await teeConnection(p3) };
  for (const [name, kp] of [["p1", p1], ["p2", p2]] as [keyof typeof er, any][]) {
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
  const readRecord = async (): Promise<Record> => {
    const r = await rawRead(TEE_URL, T.record);  // no login: the record is public
    const x = coder.decode("handRecord", r.data!);
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
  await S.ok("p2 commits a hidden seed for seat 3", () => T.commitSeed(prog.p2, p2.publicKey, 3, seed2));
  await S.err("an outsider can't commit a seed for a seat", "NotSeated", () => T.commitSeed(prog.p3, p3.publicKey, 0, randomBytes(32)));
  await S.err("p1 can't commit a seed for p2's seat", "NotSeated", () => T.commitSeed(prog.p1, p1.publicKey, 3, randomBytes(32)));
  const txView = async (u: string) => {
    const r: any = await (await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [seedSig, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }) })).json();
    const raw = r.result?.transaction?.[0] ? Buffer.from(r.result.transaction[0], "base64") : null;
    return { found: !!r.result, seedVisible: !!raw?.includes(seed1) };
  };
  const views = { p2Reader: await txView(url.p2), outsider: await txView(url.outsider), noLogin: await txView(TEE_URL), p1Wallet: await txView(connUrl(er.p1)) };
  S.check("p1's seed can't be read from its transaction by the other player, an outsider or without login", !views.p2Reader.seedVisible && !views.outsider.seedVisible && !views.noLogin.seedVisible, views);

  // ---- a spoofed callback
  const [scopedIdentity] = PublicKey.findProgramAddressSync([Buffer.from("identity"), PROGRAM_ID.toBuffer()], VRF_PROGRAM);
  await S.err("a fake VRF callback signed by an outsider is rejected", "ConstraintAddress",
    () => prog.p3.methods.deal(Array.from(randomBytes(32))).accountsPartial({ vrfProgramIdentity: p3.publicKey, table: T.table, deck: T.deck, ledger: T.ledger }).rpc());

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

  const h0 = await readHand(url.p1, 0), h3 = await readHand(url.p2, 3);
  S.check("each player reads their own two cards (dealt, hand 1)", !!h0 && !!h3 && h0.cards.every((c: number) => c < 52) && h3.cards.every((c: number) => c < 52) && Number(h0.handNo) === 1,
    { p1: h0?.cards.map(cardName), p2: h3?.cards.map(cardName), button: t1.button });
  S.check("players can't read each other's cards; outsiders read neither", !(await rawRead(url.p1, handOf(T.table, 3))).visible && !(await rawRead(url.p2, handOf(T.table, 0))).visible
    && !(await rawRead(url.outsider, handOf(T.table, 0))).visible && !(await rawRead(TEE_URL, T.deck)).visible, {});
  const ledgerRaw = (await rawRead(url.p1, T.ledger)).data;
  const ledger = ledgerRaw ? coder.decode("ledger", ledgerRaw) : { salt: Array(32).fill(0) };
  S.check("the ledger got a salt from the VRF, and the table's fingerprint covers it", !!ledgerRaw && !Buffer.from(ledger.salt).equals(Buffer.alloc(32)) && Buffer.from(t1.ledgerHash).equals(sha256(ledgerRaw)), { ledgerReadable: !!ledgerRaw });

  // ---- end hand 1 and verify it from the public record
  await S.err("an outsider can't end the hand", "NotSeated", () => T.endHand(prog.p3, p3.publicKey));
  await S.ok("p2 ends hand 1 (M4 stand-in for showdown)", () => T.endHand(prog.p2, p2.publicKey));
  const r1 = await readRecord();
  const v1a = verify(r1, { seat: 0, seed: seed1, cards: h0?.cards });
  const v1b = verify(r1, { seat: 3, seed: seed2, cards: h3?.cards });
  S.check("verifier (no login): hand 1's deck recomputes from entropy + both seeds, and matches both players' cards", v1a.ok && v1b.ok && r1.handNo === 1n,
    { p1: v1a.problems, p2: v1b.problems, button: r1.button, seedMask: r1.seedMask, first10: r1.cards.slice(0, 10).map(cardName) });
  S.check("the record doesn't contain the ledger salt", !Buffer.from(JSON.stringify(r1)).includes(Buffer.from(ledger.salt).toString("hex")) && !r1.entropy.equals(Buffer.from(ledger.salt)), {});
  const tamperCard = verify({ ...r1, cards: [r1.cards[1], r1.cards[0], ...r1.cards.slice(2)] });
  const tamperSeed = verify({ ...r1, seeds: r1.seeds.map((s, i) => (i === 3 ? randomBytes(32) : s)) });
  const tamperEntropy = verify({ ...r1, entropy: randomBytes(32) });
  S.check("tampered records fail verification (swapped cards, a changed seed, changed entropy)", !tamperCard.ok && !tamperSeed.ok && !tamperEntropy.ok,
    { card: tamperCard.problems, seed: tamperSeed.problems, entropy: tamperEntropy.problems });
  S.check("table back to idle after the hand", (await readTable()).handState === HAND_IDLE, {});

  // ---- hand 2: only p1 commits a seed; the button moves on
  const seed1b = randomBytes(32);
  await S.ok("p1 commits a fresh seed for hand 2 (p2 doesn't)", () => T.commitSeed(prog.p1, p1.publicKey, 0, seed1b));
  await S.ok("p1 starts hand 2", () => T.startHand(prog.p1, p1.publicKey));
  const lat2 = await waitDealt(2);
  const t2 = await readTable();
  S.check("hand 2 dealt; the button moved to the next seated seat", lat2 >= 0 && t2.button === nextButton(t1.button, 0b1001), { msFromRequestToDealt: lat2, button1: t1.button, button2: t2.button });
  const h0b = await readHand(url.p1, 0);
  await S.ok("the creator ends hand 2", () => T.endHand(prog.deployer, deployer.publicKey));
  const r2 = await readRecord();
  const v2 = verify(r2, { seat: 0, seed: seed1b, cards: h0b?.cards });
  S.check("verifier: hand 2 recomputes; p2's seat contributed no seed (mask bit off, zeros)", v2.ok && r2.handNo === 2n && (r2.seedMask & (1 << 3)) === 0 && r2.seeds[3].equals(Buffer.alloc(32)),
    { problems: v2.problems, seedMask: r2.seedMask });
  S.check("hand 2's deck differs from hand 1's", r2.cards.join() !== r1.cards.join(), {});
  const order = dealOrder(r2.button, r2.dealtMask);
  S.check("dealing order starts left of the button", order[0] === nextButton(r2.button, r2.dealtMask) && holeCards(v2.deck, order)[0].every((c) => c !== NO_CARD), { order });

  // ---- clean up
  await S.ok("p1 cashes out", () => T.cashOut(prog.p1, p1.publicKey, 0));
  await S.ok("p2 cashes out", () => T.cashOut(prog.p2, p2.publicKey, 3));
  await S.ok("collect rake", () => T.collectRake(prog.deployer, tokenOf(deployer.publicKey)));
  await S.ok("creator closes the table (record deleted too)", () => T.close(prog.deployer, deployer.publicKey));
  await sleep(6000);
  S.check("after close the record, deck and ledger are gone from the rollup", !(await rawRead(TEE_URL, T.record)).visible && !(await rawRead(url.p1, T.deck)).visible && !(await rawRead(url.p1, T.ledger)).visible, {});

  S.finish({ table: T.table.toBase58(), latenciesMs: [lat1, lat2], hand1: { button: r1.button, deck: r1.cards.map(cardName).join(" ") } });
}
main().catch((e) => { S.check("suite crashed", false, { error: String(e?.stack ?? e).slice(0, 600) }); S.finish({}); });
