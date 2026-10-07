// M7 on devnet against the deployed backend: a real session in which the players never begin a
// hand or time anyone out. The backend's keeper must do both, archive the hand, open its log to
// the auditor, archive the log (encrypted) and keep the lobby current.
//   POKER_PER_KEYS=... BACKEND_URL=https://... npx tsx tests/keeper.devnet.ts [--wait-commit]
import fs from "fs";
import path from "path";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { randomBytes } from "crypto";
import { connection, programFor, programOn, loadKey, teeConnection, TEE_VALIDATOR, randomTableId } from "../scripts/lib";
import { BN, KIND, Suite, sleep, tableApi, rawRead, readerFor, sendL1, tokenOf, connUrl } from "./helpers";
import { downloadLog } from "../scripts/verify-hand";

const S = new Suite("m7-keeper");
const URL_ = process.env.BACKEND_URL ?? "https://poker-per-api-production.up.railway.app";
const KEYS = process.env.POKER_PER_KEYS ?? "";
const ADMIN = fs.readFileSync(path.join(KEYS, "m7-admin-token.txt"), "utf8").trim();
const KEEPER = loadKey("keeper").publicKey;
const get = async (p: string, auth = false) => { const r = await fetch(URL_ + p, { headers: auth ? { authorization: `Bearer ${ADMIN}` } : {} }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
const post = async (p: string, body: any) => { const r = await fetch(URL_ + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
const until = async <T>(what: () => Promise<T | null | undefined | false>, ms: number, every = 1500): Promise<T | null> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await what(); if (v) return v; await sleep(every); }
  return null;
};

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1"), p2 = loadKey("p2"), p3 = loadKey("p3");
  const coder = programFor(deployer).coder.accounts as any;
  const params = { smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false };
  const er = { deployer: await teeConnection(deployer), p1: await teeConnection(p1), p2: await teeConnection(p2), p3: await teeConnection(p3) };
  for (const [name, kp] of [["p1", p1], ["p2", p2], ["deployer", deployer]] as [keyof typeof er, any][]) {
    let bal = 0n;
    try { bal = BigInt((await er[name].getTokenAccountBalance(tokenOf(kp.publicKey))).value.amount); } catch { /* none yet */ }
    if (bal < 5_000_000n) {
      const amt = 5_000_000n - bal, ata = tokenOf(kp.publicKey);
      const ixs = await delegateSpl(kp.publicKey, NATIVE_MINT, amt, { validator: TEE_VALIDATOR, initVaultIfMissing: true, initAtasIfMissing: true, payer: kp.publicKey });
      await S.ok(`top-up ${name}`, () => sendL1(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata, lamports: Number(amt) }), createSyncNativeInstruction(ata), ...ixs), [kp]));
    }
  }
  await sleep(5000);
  const prog = { deployer: programOn(er.deployer, deployer), p1: programOn(er.p1, p1), p2: programOn(er.p2, p2), p3: programOn(er.p3, p3) };
  const rd1 = await teeConnection(readerFor(p1.publicKey));
  const T = tableApi(deployer, randomTableId());
  const key = T.table.toBase58();
  const readTable = async () => coder.decode("table", (await er.deployer.getAccountInfo(T.table, "processed"))!.data);
  const ledger = async () => coder.decode("ledger", (await rawRead(connUrl(rd1), T.ledger)).data!);
  const keeperEvents = async () => (await get(`/audit/events?limit=1000&table=${key}`, true)).body as any[];

  const health = await get("/health");
  S.check("backend health: ok, keeper looping, auditor is the config's", health.status === 200 && health.body.ok && health.body.keeper.auditorMatches === true && health.body.keeper.address === KEEPER.toBase58(),
    { status: health.status, loops: health.body?.keeper?.loops, lastError: health.body?.keeper?.lastError });

  await S.ok("create + delegate a 6-seat table", async () => { await T.create(params); return T.delegate(); });
  await sleep(4000);
  await S.ok("open", () => T.open(prog.deployer, deployer.publicKey));
  const listed = await until(async () => ((await get("/tables")).body as any[]).find((t) => t.address === key), 90_000);
  S.check("the lobby lists the new table (keeper discovery)", !!listed && listed.live === true && listed.smallBlind === "100000", { listed });
  await S.ok("p1 sits in seat 0, p2 in seat 3", async () => { await T.buyIn(prog.p1, p1.publicKey, 0, 2_000_000n); return T.buyIn(prog.p2, p2.publicKey, 3, 2_000_000n); });
  const seated = await until(async () => ((await get(`/tables/${key}`)).body?.seated === 2) || null, 60_000);
  S.check("the lobby shows 2 seated", !!seated, {});

  // ---- hand 1: nobody begins it but the keeper; then p? raises and the other never acts
  await S.ok("p1 and p2 commit seeds", async () => { await T.commitSeed(prog.p1, p1.publicKey, 0, randomBytes(32)); return T.commitSeed(prog.p2, p2.publicKey, 3, randomBytes(32)); });
  await S.ok("an outsider (p3) starts hand 1", () => T.startHand(prog.p3, p3.publicKey));
  const playing = await until(async () => { const t = await readTable(); return t.handState === 3 ? t : null; }, 60_000, 500);
  // The keeper logs an action after it confirms, which can be a moment after the rollup shows it.
  const ticks = (n: number) => until(async () => { const t = (await keeperEvents()).filter((e) => e.action === "tick" && e.ok); return t.length >= n ? t : null; }, 20_000);
  const begunBy = (await ticks(1))?.[0];
  // This test never calls begin_hand, so the keeper's tick is what began the hand.
  S.check("the dealt hand was begun by the keeper's tick (the test never calls begin_hand)", !!playing && !!begunBy, { tick: begunBy?.detail });
  const BET = 512_000n;
  let seat = (await ledger()).game.toAct;
  const bySeat: Record<number, [any, PublicKey]> = { 0: [prog.p1, p1.publicKey], 3: [prog.p2, p2.publicKey] };
  await S.ok(`seat ${seat} raises to ${BET}`, () => T.act(bySeat[seat][0], bySeat[seat][1], seat, KIND.raise, BET));
  const awaited = (await ledger()).game.toAct;
  const t0 = Date.now();
  const ended = await until(async () => { const t = await readTable(); return t.handState === 0 && Number(t.lastRecord.handNo) === 1 ? t : null; }, 60_000, 500);
  const timeoutTick = !!(await ticks(2));
  // Nobody in the test calls timeout; the log's timeout flag (checked below) shows it was one.
  S.check(`seat ${awaited} never acts: a second keeper tick times them out after their 15 s and the hand ends`, !!ended && timeoutTick, { secondsAfterRaise: Math.round((Date.now() - t0) / 1000) });
  const playerLog = await downloadLog(rd1, T.table);

  // ---- hand 2 straight away (fast play): hand 1's log must still be archived before hand 2 begins
  await S.ok("hand 2 starts at once: p1 and p2 commit seeds, an outsider starts it", async () => {
    await T.commitSeed(prog.p1, p1.publicKey, 0, randomBytes(32)); await T.commitSeed(prog.p2, p2.publicKey, 3, randomBytes(32));
    return T.startHand(prog.p3, p3.publicKey);
  });
  const playing2 = await until(async () => { const t = await readTable(); return t.handState === 3 && Number(t.handNo) === 2 ? t : null; }, 60_000, 500);
  S.check("the keeper began hand 2", !!playing2, {});
  const toAct2 = (await ledger()).game.toAct;
  await S.ok(`hand 2: seat ${toAct2} folds, the hand ends`, () => T.act(bySeat[toAct2][0], bySeat[toAct2][1], toAct2, KIND.fold));
  const hand1Log = await until(async () => { const r = await get(`/tables/${key}/hands/1`); return r.status === 200 && r.body.log.status !== "pending" ? r.body.log : null; }, 60_000);
  S.check("fast play: hand 1's log was archived before hand 2 began (not missed)", hand1Log?.status === "archived" && hand1Log?.verified === true, { hand1Log });
  const hand2Log = await until(async () => { const r = await get(`/tables/${key}/hands/2`); return r.status === 200 && r.body.log.status !== "pending" ? r.body.log : null; }, 90_000);
  S.check("hand 2's log archived too", hand2Log?.status === "archived" && hand2Log?.verified === true, { hand2Log });

  // ---- archive
  const hand = await until(async () => { const r = await get(`/tables/${key}/hands/1`); return r.status === 200 && r.body.log.status === "archived" ? r.body : null; }, 90_000);
  S.check("the backend archived hand 1: record verified (recomputed), log archived and its hash checked", !!hand && hand.verified && hand.recomputed.ok && hand.log.verified === true,
    { verified: hand?.verified, recomputed: hand?.recomputed?.ok, log: hand?.log });
  const publicView = JSON.stringify(hand ?? {});
  S.check("the public hand route carries no action log, bets or wallets", !publicView.includes(BET.toString()) && !publicView.includes(p1.publicKey.toBase58()) && !publicView.includes(p2.publicKey.toBase58()) && !("entries" in (hand ?? {})), {});
  const audit = await get(`/audit/tables/${key}/hands/1/log`, true);
  S.check("audit route (admin token): the archived log equals the one the players read, with the raise and the timeout",
    audit.status === 200 && JSON.stringify(audit.body) === JSON.stringify(playerLog) && audit.body.entries.some((e: any) => e.committed === BET.toString()) && audit.body.entries.some((e: any) => (e.kind & 0x80) !== 0),
    { status: audit.status, entries: audit.body?.entries?.length });
  S.check("audit route without the token: 401", (await get(`/audit/tables/${key}/hands/1/log`)).status === 401, {});
  const okVerify = await post("/verify", { table: key, handNo: "1", log: playerLog });
  const tampered = JSON.parse(JSON.stringify(playerLog));
  tampered.entries[2].committed = "400000";
  const badVerify = await post("/verify", { table: key, handNo: "1", log: tampered });
  S.check("POST /verify: a player's downloaded log verifies; the same log with a changed bet doesn't", okVerify.body?.ok === true && badVerify.body?.ok === false, { ok: okVerify.body, tampered: badVerify.body });

  // ---- commits
  const commits = (await keeperEvents()).filter((e) => e.action === "commit_table" && e.ok);
  S.check("the keeper committed the new table (its first commit is due at once)", commits.length >= 1, { commits: commits.map((c) => c.detail) });
  if (process.argv.includes("--wait-commit")) {
    const onL1 = await until(async () => {
      const info = await connection.getAccountInfo(T.table, "confirmed");
      return info && Number(coder.decode("table", info.data).lastRecord.handNo) === 1 ? info : null;
    }, 17 * 60_000, 15_000);
    const later = (await keeperEvents()).filter((e) => e.action === "commit_table" && e.ok);
    S.check("15 minutes later the keeper committed again, and hand 1's record is on Solana", !!onL1 && later.length >= 2, { commits: later.map((c) => c.detail) });
  }

  // ---- leaving and closing: the lobby drops the table
  await S.ok("p1 and p2 cash out", async () => { await T.cashOut(prog.p1, p1.publicKey, 0); return T.cashOut(prog.p2, p2.publicKey, 3); });
  await S.ok("collect rake", () => T.collectRake(prog.deployer, tokenOf(deployer.publicKey)));
  await S.ok("creator closes the table", () => T.close(prog.deployer, deployer.publicKey));
  const gone = await until(async () => !((await get("/tables")).body as any[]).some((t) => t.address === key), 120_000, 3000);
  S.check("the lobby drops the closed table", !!gone, {});
  const failures = (await keeperEvents()).filter((e) => !e.ok);
  S.check("no failed keeper action on this table", failures.length === 0, { failures: failures.map((f) => `${f.action}: ${f.detail}`) });

  S.finish({ table: key, backend: URL_ });
}

main().catch((e) => { console.error(e); process.exit(1); });
