// M4 devnet tests: VRF shuffle and deal. Seeds (required from every seat's current occupant), a
// spoofed callback, two real hands dealt by the VRF inside the TEE, private hole cards, the ledger
// salt, what a reader can see of the oracle's transaction, the public hand record and the off-chain
// verifier (including tampered records). Results go to results/m4-hand-<ts>.json.
// Runs with the backend's keeper on (M10): the keeper may begin a dealt hand and time out the player to
// act before the suite does, as it does in real play. Steps it can take first accept either outcome.
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { randomBytes } from "crypto";
import { programFor, programOn, loadKey, teeConnection, TEE_URL, TEE_VALIDATOR, randomTableId } from "../scripts/lib";
import { BN, KIND, Suite, errName, sleep, tableApi, handOf, rawRead, readerFor, sendL1, sha256, tokenOf, connUrl } from "./helpers";
import { verify, holeCards, dealOrder, nextButton, cardName, NO_CARD, Record } from "./verifier";
import { recoverHand } from "./attack";

const S = new Suite("m4-hand");
const HAND_DEALT = 2, HAND_PLAYING = 3, HAND_IDLE = 0;

// MagicBlock leak 2: simulateTransaction returns accounts listed in `accounts.addresses`, without a login.
async function simulateLeak(accounts: PublicKey[]): Promise<Buffer[]> {
  const stranger = Keypair.generate();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: stranger.publicKey, lamports: 0 }));
  tx.feePayer = stranger.publicKey;
  tx.recentBlockhash = (await rpcAt(TEE_URL, "getLatestBlockhash", [])).result.value.blockhash;
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const sim = await rpcAt(TEE_URL, "simulateTransaction", [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: accounts.map((a) => a.toBase58()) } }]);
  return (sim.result?.value?.accounts ?? []).filter((a: any) => !!a).map((a: any) => Buffer.from(a.data[0], "base64")).filter((b: Buffer) => b.length > 0);
}

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
  const bySeat: Record<number, [any, PublicKey]> = { 0: [prog.p1, p1.publicKey], 3: [prog.p2, p2.publicKey] };
  const foldToAct = async () => {
    const seat = coder.decode("ledger", (await rawRead(url.p1, T.ledger)).data!).game.toAct;
    return T.act(bySeat[seat][0], bySeat[seat][1], seat, KIND.fold);
  };
  // Begins the betting, unless the keeper already has (it ticks a dealt hand at once).
  const beginOrKeeper = async (prog: any, signer: PublicKey, hand: number): Promise<string> => {
    try { return await T.beginHand(prog, signer); }
    catch (e) {
      const t = await readTable();
      if (errName(e).startsWith("HandNotDealt") && Number(t.handNo) === hand && t.handState !== HAND_DEALT) return "already begun by the keeper";
      throw e;
    }
  };
  // Ends a heads-up hand: the player to act folds, unless the keeper already timed them out (15 s turns).
  const endHand = async (hand: number): Promise<string> => {
    let how = "the keeper timed out the player to act";
    const t = await readTable();
    if (t.handState === HAND_PLAYING && Number(t.handNo) === hand) {
      try { await foldToAct(); how = "the player to act folded"; }
      catch (e) { if (!/NotYourTurn|HandNotPlaying/.test(errName(e))) throw e; }
    }
    const start = Date.now();
    while (Date.now() - start < 40_000) {
      const now = await readTable();
      if (now.handState === HAND_IDLE && Number(now.handNo) === hand) return how;
      await sleep(500);
    }
    throw new Error(`hand ${hand} didn't end in 40 s`);
  };
  // The table and the ledger as one consistent pair (the keeper may change the ledger between two reads).
  const readTableAndLedger = async () => {
    for (let i = 0; ; i++) {
      const a = await readTable();
      const raw = (await rawRead(url.p1, T.ledger)).data;
      const b = await readTable();
      if (a.ledgerSeq.toString() === b.ledgerSeq.toString() || i >= 5) return { table: b, ledgerRaw: raw };
    }
  };
  const waitDealt = async (hand: number) => {
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const t = await readTable();
      // Dealt, or already begun by the keeper (which ticks a dealt hand at once).
      if ((t.handState === HAND_DEALT || t.handState === HAND_PLAYING) && Number(t.handNo) === hand) return Date.now() - start;
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
  // Control: the same no-login probe reads a public transaction (a memo touching no private account) in
  // full, so a "not visible" for a seed means the contents were withheld, not that the probe is blind.
  const memoBytes = randomBytes(32);
  const teeDeployer = await teeConnection(deployer);
  const memoTx = new Transaction().add(new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKFwFSyoZ8CprTPJyJJ5XrjqJhnwV2Q"),
    keys: [{ pubkey: deployer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memoBytes.toString("hex")) }));
  memoTx.feePayer = deployer.publicKey;
  memoTx.recentBlockhash = (await teeDeployer.getLatestBlockhash()).blockhash;
  memoTx.sign(deployer);
  const memoSig = await teeDeployer.sendRawTransaction(memoTx.serialize(), { skipPreflight: true });
  await teeDeployer.confirmTransaction(memoSig, "confirmed");
  let memoView = { found: false, visible: false };
  for (let i = 0; i < 10 && !memoView.found; i++) {
    const r = await rpcAt(TEE_URL, "getTransaction", [memoSig, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    const raw = r.result?.transaction?.[0] ? Buffer.from(r.result.transaction[0], "base64") : null;
    memoView = { found: !!r.result, visible: !!raw?.includes(Buffer.from(memoBytes.toString("hex"))) };
    if (!memoView.found) await sleep(1500);
  }
  S.check("probe control: with no login, a public memo transaction's 32 random bytes are readable", memoView.found && memoView.visible, { memoSig, ...memoView });
  // During play the RPC withholds the contents of transactions touching private accounts, even from
  // their signer (found, but the seed isn't in what comes back).
  S.check("p1's seed can't be read from its transaction by the other player, an outsider or without login (contents withheld even from p1)",
    views.p1WalletControl.found && !views.p2Reader.seedVisible && !views.outsider.seedVisible && !views.noLogin.seedVisible, views);

  // ---- a spoofed callback
  await S.err("a fake VRF callback signed by an outsider is rejected", "ConstraintAddress",
    () => prog.p3.methods.deal(Array.from(randomBytes(32)), BN(1)).accountsPartial({ vrfProgramIdentity: p3.publicKey, table: T.table, deck: T.deck, ledger: T.ledger }).rpc());
  await S.err("abort with no hand running is refused", "NotShuffling", () => T.abortHand(prog.p3, p3.publicKey));

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
  await S.err("abort of a dealt hand is refused", "NotShuffling", () => T.abortHand(prog.p3, p3.publicKey));

  const h0 = await readHand(url.p1, 0), h3 = await readHand(url.p2, 3);
  S.check("each player reads their own two cards (dealt, hand 1)", !!h0 && !!h3 && h0.cards.every((c: number) => c < 52) && h3.cards.every((c: number) => c < 52) && Number(h0.handNo) === 1,
    { p1: h0?.cards.map(cardName), p2: h3?.cards.map(cardName), button: t1.button });
  S.check("players can't read each other's cards; outsiders read neither; nobody reads the deck", !(await rawRead(url.p1, handOf(T.table, 3))).visible && !(await rawRead(url.p2, handOf(T.table, 0))).visible
    && !(await rawRead(url.outsider, handOf(T.table, 0))).visible && !(await rawRead(url.p1, T.deck)).visible && !(await rawRead(TEE_URL, T.deck)).visible, {});
  const { table: tl, ledgerRaw } = await readTableAndLedger();
  const salt = ledgerRaw ? Buffer.from(coder.decode("ledger", ledgerRaw).salt) : Buffer.alloc(32);
  S.check("the ledger got a salt from the VRF, and the table's fingerprint covers it", !!ledgerRaw && !salt.equals(Buffer.alloc(32)) && Buffer.from(tl.ledgerHash).equals(sha256(ledgerRaw)), { ledgerReadable: !!ledgerRaw });

  // Begin now, while the hand is surely live (the keeper may have begun it already; it times the player to
  // act out after 15 s, before the probes below finish).
  await S.ok("begin the betting (blinds posted), or the keeper already has", () => beginOrKeeper(prog.p3, p3.publicKey, 1));
  await S.err("an outsider can't act in the hand", "NotSeated", () => T.act(prog.p3, p3.publicKey, 0, KIND.fold));

  // Can anyone rebuild the live hand from transaction data (seeds in commit_seed transactions, the
  // VRF output in the oracle's fulfillment)? Tried with no login, an outsider's login, and the other
  // seated player's reader (who knows the ledger but not p1's seed).
  const live = {
    noLogin: await recoverHand(TEE_URL, T.table, 1n, 0b1001, 15_000),
    outsider: await recoverHand(url.outsider, T.table, 1n, 0b1001, 5_000),
    p2Reader: await recoverHand(url.p2, T.table, 1n, 0b1001, 5_000),
  };
  const rebuilt = (r: any) => !!r.predicted && h0 && r.predicted[0].join() === h0.cards.map(cardName).join();
  S.check("during hand 1, nobody else can rebuild p1's cards from transaction data, or see any seed or the VRF output (no login, outsider, the other player)",
    Object.values(live).every((r: any) => !rebuilt(r) && !r.vrfOutputFound && r.seedsFound === 0),
    Object.fromEntries(Object.entries(live).map(([k, v]: any) => [k, { listed: v.signaturesListed, hidden: v.transactionsHidden, seeds: v.seedsFound, vrf: v.vrfOutputFound }])));

  // MagicBlock leak 2 (M3): simulateTransaction hands out private accounts with no login. Probed on
  // the live deck and a hand; tracked as KNOWN until MagicBlock fixes it.
  const leakDeck = await simulateLeak([T.deck]), leakHand = await simulateLeak([handOf(T.table, 0)]);
  const leakedDeck = leakDeck[0] ? coder.decode("deck", leakDeck[0]) : null;
  S.known("MagicBlock leak 2: simulateTransaction returns the live deck and hands with no login", leakDeck.length > 0 || leakHand.length > 0,
    { deckReturned: leakDeck.length, handReturned: leakHand.length, leakedDeckMatchesP1Cards: !!leakedDeck && h0 && holeCards(Array.from(leakedDeck.cards), dealOrder(t1.button, 0b1001))[0].join() === Array.from(h0.cards).join() });

  // ---- end hand 1 and verify it from the public record
  await S.ok("hand 1 ends: the player to act folds, or the keeper timed them out (heads-up)", () => endHand(1));
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
  await S.ok("begin hand 2 (or the keeper does) and it ends: the player to act folds, or the keeper times them out", async () => { await beginOrKeeper(prog.deployer, deployer.publicKey, 2); return endHand(2); });
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
  await S.ok("creator closes the table (record deleted; ledger and deck kept, readable by nobody)", () => T.close(prog.deployer, deployer.publicKey));
  await sleep(6000);
  const afterClose = await recoverHand(TEE_URL, T.table, 1n, 0b1001, 60_000);
  const seedAfter = await txView(TEE_URL);
  // Before M6, closing deleted the private accounts and the TEE then served these transactions in full.
  S.check("after close, the no-login probe still finds p1's seed transaction, but its contents stay hidden", seedAfter.found && !seedAfter.seedVisible, seedAfter);
  S.check("after close, nobody can rebuild the hand from public transactions (no seeds, no VRF output)",
    !afterClose.predicted && afterClose.seedsFound === 0 && !afterClose.vrfOutputFound, { seeds: afterClose.seedsFound, vrf: afterClose.vrfOutputFound, hidden: afterClose.transactionsHidden });
  S.check("after close the record is gone; p1's reader key can no longer read the deck or ledger",
    !(await rawRead(TEE_URL, T.record)).visible && !(await rawRead(url.p1, T.deck)).visible && !(await rawRead(url.p1, T.ledger)).visible, {});
  const leakClosed = await simulateLeak([T.ledger]);
  S.known("MagicBlock leak 2 also covers a closed table: simulateTransaction returns its kept ledger with no login", leakClosed.length > 0, { bytes: leakClosed.map((b) => b.length) });
  const deckClosed = await simulateLeak([T.deck]);
  const closedLedger = leakClosed[0] ? coder.decode("ledger", leakClosed[0]) : null;
  // Since MagicBlock fixed leak 2 for closed tables (seen 11 Oct), nothing comes back at all: that passes too.
  const ledgerErased = leakClosed.length === 0 || (!!closedLedger && Buffer.from(closedLedger.salt).equals(Buffer.alloc(32))
    && closedLedger.game.seats.every((s: any) => Number(s.stack) === 0 && Number(s.total) === 0) && closedLedger.seats.every((s: any) => s.player.equals(PublicKey.default)));
  const deckErased = deckClosed.length === 0 || (deckClosed.length === 1 && deckClosed[0].subarray(8).every((b) => b === 0));
  S.check("...and close erased what it would show (the ledger's salt, game and seats zero, the deck all zero), or nothing is returned at all",
    ledgerErased && deckErased, { ledgerBytes: leakClosed[0]?.length ?? "not returned", deckBytes: deckClosed[0]?.length ?? "not returned" });

  S.finish({ table: T.table.toBase58(), latenciesMs: [lat1, lat2], hand1: { button: r1?.button, deck: r1?.cards.map(cardName).join(" ") } });
}
main().catch((e) => { S.check("suite crashed", false, { error: String(e?.stack ?? e).slice(0, 600) }); S.finish({}); });
