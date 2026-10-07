// Hand verifier CLI. Recomputes a table's latest published hand from its public record (seeds,
// VRF entropy, shuffle, deck, button) and optionally checks a downloaded action log against the
// record's log hash. Needs no login and no trust in the program.
//
//   npx tsx scripts/verify-hand.ts <table> [--l1] [--log <file.json>] [--prev-button <seat>]
//     --l1           read the record committed to Solana (the table's `lastRecord`) instead of the
//                    rollup's public hand record
//     --log          a log downloaded with --download-log, checked against the record's hash
//     --prev-button  the previous hand's button, to check this hand's button (hand 1 is always checked)
//   npx tsx scripts/verify-hand.ts <table> --download-log <key name> --out <file.json>
//     downloads the table's current hand log as a reader (a player of that hand, or the auditor
//     once the hand is over); the key is loaded like the other scripts' keys
import fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { connection, loadKey, programFor, teeConnection, TEE_URL } from "./lib";
import { boardOf, cardName, dealOrder, holeCards, seatsIn, verify, verifyLog, HandLogFile, Record } from "../tests/verifier";
import { recordOf, logOf } from "../tests/helpers";

export type PublishedRecord = Record & { logHash: Buffer; logLen: number; boardLen: number };

const coder = () => programFor(loadKey("deployer")).coder.accounts as any;

function toRecord(x: any): PublishedRecord {
  return { table: x.table, handNo: BigInt(x.handNo.toString()), button: x.button, dealtMask: x.dealtMask, seedMask: x.seedMask,
    seeds: x.seeds.map((s: number[]) => Buffer.from(s)), entropy: Buffer.from(x.entropy), shuffleSeed: Buffer.from(x.shuffleSeed),
    cards: Array.from(x.cards), logHash: Buffer.from(x.logHash), logLen: x.logLen, boardLen: x.boardLen };
}

/** The latest published hand: from Solana (the committed table) or from the rollup's public record. */
export async function fetchRecord(table: PublicKey, opts: { l1?: boolean } = {}): Promise<PublishedRecord | null> {
  if (opts.l1) {
    const info = await connection.getAccountInfo(table, "confirmed");
    if (!info || info.data.length === 0) return null;
    return toRecord(coder().decode("table", info.data).lastRecord);
  }
  const info = await new Connection(TEE_URL, "confirmed").getAccountInfo(recordOf(table));
  return info ? toRecord(coder().decode("handRecord", info.data)) : null;
}

/** Reads the table's hand log with a reader's login and returns it in the file format. */
export async function downloadLog(conn: Connection, table: PublicKey): Promise<HandLogFile | null> {
  const info = await conn.getAccountInfo(logOf(table));
  if (!info) return null;
  const log = coder().decode("handLog", info.data);
  const n = Math.min(log.len, log.entries.length);
  return { table: table.toBase58(), handNo: log.handNo.toString(), secret: Buffer.from(log.secret).toString("hex"), len: log.len,
    entries: log.entries.slice(0, n).map((e: any) => ({ street: e.street, seat: e.seat, kind: e.kind, committed: e.committed.toString() })) };
}

/** Everything the CLI prints, as data (the test suite calls this too). */
export function report(r: PublishedRecord, log?: HandLogFile, prevButton?: number) {
  const v = verify(r, undefined, prevButton);
  const l = log ? verifyLog(r, log) : undefined;
  const holes = holeCards(v.deck, dealOrder(r.button, r.dealtMask));
  const board = boardOf(v.deck, seatsIn(r.dealtMask).length).slice(0, r.boardLen);
  return {
    ok: v.ok && (!l || l.ok),
    hand: r.handNo.toString(), button: r.button,
    deck: v.ok ? "recomputed from seeds + VRF entropy: matches" : "MISMATCH",
    holeCards: Object.fromEntries(holes.map((h, seat) => [seat, h]).filter(([, h]: any) => h[0] !== 255).map(([seat, h]: any) => [seat, h.map(cardName).join(" ")])),
    board: board.map(cardName).join(" "),
    log: l ? (l.ok ? `${log!.len} actions, hash matches the record` : "MISMATCH") : "not checked (pass --log)",
    problems: [...v.problems, ...(l?.problems ?? [])],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (!args[0] || args[0].startsWith("--")) { console.error("usage: verify-hand.ts <table> [--l1] [--log file] [--prev-button n] | <table> --download-log <key> --out <file>"); process.exit(2); }
  const table = new PublicKey(args[0]);
  const keyName = opt("--download-log");
  if (keyName) {
    const log = await downloadLog(await teeConnection(loadKey(keyName)), table);
    if (!log) { console.error("can't read the log with that key (not a reader of this hand)"); process.exit(1); }
    fs.writeFileSync(opt("--out") ?? "hand-log.json", JSON.stringify(log, null, 1));
    console.log(JSON.stringify({ saved: opt("--out") ?? "hand-log.json", hand: log.handNo, actions: log.len }));
    return;
  }
  const r = await fetchRecord(table, { l1: args.includes("--l1") });
  if (!r) { console.error("no record found"); process.exit(1); }
  const logFile = opt("--log");
  const prev = opt("--prev-button");
  const out = report(r, logFile ? JSON.parse(fs.readFileSync(logFile, "utf8")) : undefined, prev === undefined ? undefined : Number(prev));
  console.log(JSON.stringify(out, null, 1));
  if (!out.ok) process.exit(1);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
