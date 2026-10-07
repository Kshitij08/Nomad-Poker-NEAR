// Experiment: does a MagicBlock Hydra crank keep a hand moving with nobody's client online? Seats
// two players, schedules the table's keeper (tick every `interval` rollup slots, `tip` lamports per
// trigger), starts a hand, then never calls begin_hand and never acts. Watches the table: a working
// keeper begins the hand, times out both players and finishes it.
// Usage: npx tsx scripts/probe-keeper-crank.ts [intervalSlots=100] [tip=0] [watchSeconds=90] [fund=0]
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { loadKey, programFor, programOn, teeConnection, randomTableId } from "./lib";
import { BN, errName, sleep, tableApi, rawRead, readerFor, connUrl, tokenOf, HYDRA_EPHEMERAL } from "../tests/helpers";

async function main() {
  const [interval = "100", tip = "0", watch = "90", fund = "0"] = process.argv.slice(2);
  const deployer = loadKey("deployer"), p1 = loadKey("p1"), p2 = loadKey("p2");
  const er = { d: await teeConnection(deployer), p1: await teeConnection(p1), p2: await teeConnection(p2) };
  const prog = { d: programOn(er.d, deployer), p1: programOn(er.p1, p1), p2: programOn(er.p2, p2) };
  const coder = programFor(deployer).coder.accounts as any;
  const T = tableApi(deployer, randomTableId());
  await T.create({ smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false });
  await T.delegate(); await sleep(4000);
  await T.open(prog.d, deployer.publicKey);
  await T.buyIn(prog.p1, p1.publicKey, 0, 2_000_000n);
  await T.buyIn(prog.p2, p2.publicKey, 2, 2_000_000n);
  const out: any = { table: T.table.toBase58(), crank: T.crank.toBase58(), intervalSlots: Number(interval), tip: Number(tip) };
  try { out.schedule = await T.scheduleKeeper(prog.d, deployer.publicKey, Number(interval), Number(tip), Number(fund)); } catch (e) { out.schedule = "FAILED " + errName(e) + " " + String((e as any)?.message ?? e).slice(0, 300); }
  const crankAcct = await er.d.getAccountInfo(T.crank);
  out.crankAccount = crankAcct ? { owner: crankAcct.owner.toBase58(), bytes: crankAcct.data.length, lamports: crankAcct.lamports } : null;
  await T.commitSeed(prog.p1, p1.publicKey, 0, randomBytes(32));
  await T.commitSeed(prog.p2, p2.publicKey, 2, randomBytes(32));
  await T.startHand(prog.d, deployer.publicKey);
  const t0 = Date.now();
  const timeline: any[] = [];
  let last = "";
  const rd = connUrl(await teeConnection(readerFor(p1.publicKey)));
  while (Date.now() - t0 < Number(watch) * 1000) {
    const t = coder.decode("table", (await er.d.getAccountInfo(T.table, "processed"))!.data);
    const ca = await er.d.getAccountInfo(T.crank);
    const executed = ca ? Number(ca.data.readBigUInt64LE(32 + 32 + 8 + 8 + 8 + 8)) : -1;
    const state = `hand ${t.handNo} state ${t.handState} executed ${executed}`;
    if (state !== last) { timeline.push({ s: Math.round((Date.now() - t0) / 1000), state }); last = state; }
    if (Number(t.handNo) === 1 && t.handState === 0) break;
    await sleep(1000);
  }
  out.timeline = timeline;
  const tEnd = coder.decode("table", (await er.d.getAccountInfo(T.table))!.data);
  out.handFinishedByKeeper = Number(tEnd.handNo) === 1 && tEnd.handState === 0;
  if (out.handFinishedByKeeper) {
    const log = coder.decode("handLog", (await rawRead(rd, T.log)).data!);
    out.logKinds = Array.from({ length: log.len }, (_, i) => log.entries[i].kind);
  }
  // clean up: cancel the keeper, finish any hand, empty and close the table
  try { out.cancel = await T.cancelKeeper(prog.d, deployer.publicKey); } catch (e) { out.cancel = "FAILED " + errName(e); }
  for (let i = 0; i < 20; i++) {
    const t = coder.decode("table", (await er.d.getAccountInfo(T.table))!.data);
    if (t.handState === 0) break;
    try { await T.tick(prog.d); } catch { /* not due yet */ }
    await sleep(3000);
  }
  for (const [p, kp, seat] of [[prog.p1, p1, 0], [prog.p2, p2, 2]] as any[]) { try { await T.cashOut(p, kp.publicKey, seat); } catch (e) { out[`cashout${seat}`] = errName(e); } }
  try { await T.collectRake(prog.d, tokenOf(deployer.publicKey)); await T.close(prog.d, deployer.publicKey); out.closed = true; } catch (e) { out.closed = errName(e); }
  const file = path.join(__dirname, "../results", `keeper-crank-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
