// Attack test: can an outsider with NO login compute a hand's cards from transaction data the TEE
// RPC returns? Deals a real hand at a new table. Then, twice — while the hand is live, and again
// after the table is closed — reads the table's transactions without any login, takes each seat's
// seed from the commit_seed transactions and the VRF output from the oracle's fulfillment, and
// recomputes the hole cards, comparing them with what the players actually hold.
// Writes results/attack-deck-from-public-txs-<ts>.json.
import { PublicKey } from "@solana/web3.js";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { loadKey, programOn, teeConnection, TEE_URL, randomTableId } from "./lib";
import { BN, sleep, tableApi, rawRead, readerFor, connUrl, tokenOf, handOf } from "../tests/helpers";
import { cardName } from "../tests/verifier";
import { recoverHand } from "../tests/attack";

const DEALT = 0b1001;
const recover = (table: PublicKey, waitMs: number) => recoverHand(TEE_URL, table, 1n, DEALT, waitMs);

async function main() {
  const deployer = loadKey("deployer"), p1 = loadKey("p1"), p2 = loadKey("p2");
  const er = { d: await teeConnection(deployer), p1: await teeConnection(p1), p2: await teeConnection(p2) };
  const prog = { d: programOn(er.d, deployer), p1: programOn(er.p1, p1), p2: programOn(er.p2, p2) };
  const coder = prog.d.coder.accounts as any;
  const T = tableApi(deployer, randomTableId());
  await T.create({ smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false });
  await T.delegate(); await sleep(4000);
  await T.open(prog.d, deployer.publicKey);
  await T.buyIn(prog.p1, p1.publicKey, 0, 2_000_000n);
  await T.buyIn(prog.p2, p2.publicKey, 3, 2_000_000n);
  await T.commitSeed(prog.p1, p1.publicKey, 0, randomBytes(32));
  await T.commitSeed(prog.p2, p2.publicKey, 3, randomBytes(32));
  await T.requestStart(prog.d, deployer.publicKey);
  await T.startHand(prog.d, deployer.publicKey);
  for (let i = 0; i < 300; i++) { const t = coder.decode("table", (await er.d.getAccountInfo(T.table, "processed"))!.data); if (t.handState === 2) break; await sleep(100); }
  const hand = async (kp: any, seat: number) => coder.decode("hand", (await rawRead(connUrl(await teeConnection(readerFor(kp.publicKey))), handOf(T.table, seat))).data!).cards.map(cardName);
  const truth = { seat0: await hand(p1, 0), seat3: await hand(p2, 3) };
  const matches = (r: any) => !!r.predicted && r.predicted[0].join() === truth.seat0.join() && r.predicted[3].join() === truth.seat3.join();

  const out: any = { ranAt: new Date().toISOString(), table: T.table.toBase58(), note: "`live` and `afterClose` used the TEE RPC with no login", truth };
  out.live = await recover(T.table, 30_000);
  out.live.cardsRecovered = matches(out.live);
  await T.beginHand(prog.d, deployer.publicKey);
  const toAct = coder.decode("ledger", (await rawRead(connUrl(await teeConnection(readerFor(p1.publicKey))), T.ledger)).data!).game.toAct;
  await T.act(toAct === 0 ? prog.p1 : prog.p2, toAct === 0 ? p1.publicKey : p2.publicKey, toAct, 0);
  await T.cashOut(prog.p1, p1.publicKey, 0); await T.cashOut(prog.p2, p2.publicKey, 3);
  await T.collectRake(prog.d, tokenOf(deployer.publicKey)); await T.close(prog.d, deployer.publicKey);
  out.afterClose = await recover(T.table, 60_000);
  out.afterClose.cardsRecovered = matches(out.afterClose);
  const file = path.join(__dirname, "../results", `attack-deck-from-public-txs-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
